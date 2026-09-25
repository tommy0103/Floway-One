import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { PersonalRuntimePaths } from './personal-runtime.ts';
import { PERSONAL_HOSTNAME } from './personal-runtime.ts';
import type { InitializedPersonalStorage } from './personal-storage.ts';
import { FLOWAY_SKILL_HELPER, FLOWAY_SKILL_MARKDOWN, FLOWAY_SKILL_REFERENCES } from '@floway-dev/agent-setup';
import type { PersonalAgentSkillInstaller, PersonalAgentSkillStatus } from '@floway-dev/gateway';

export const PERSONAL_AGENT_SKILL_SESSION_FILE = 'agent-skill.session';
const MANAGED_SKILL_MARKER = '<!-- Managed by Floway. -->';

interface PersonalAgentSkillOptions {
  paths: PersonalRuntimePaths;
  permissions: InitializedPersonalStorage;
  homeDir?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}

const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const writeAtomic = (path: string, content: string, mode: number): void => {
  const stage = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(stage, content, { encoding: 'utf8', mode, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(stage, mode);
    renameSync(stage, path);
  } catch (cause) {
    rmSync(stage, { force: true });
    throw new Error(`Floway could not write ${path}`, { cause });
  }
};

export const createPersonalAgentSkillInstaller = ({
  paths,
  permissions,
  homeDir = userInfo().homedir,
  nodeExecutable = process.execPath,
  platform = process.platform,
}: PersonalAgentSkillOptions): PersonalAgentSkillInstaller & { refreshInstalled(): void } => {
  if (!isAbsolute(paths.dataDir) || !isAbsolute(homeDir) || !isAbsolute(nodeExecutable)) {
    throw new Error('Floway Skill requires absolute local paths');
  }
  const sessionPath = join(paths.dataDir, PERSONAL_AGENT_SKILL_SESSION_FILE);

  const readSessionToken = (): string | null => {
    if (!existsSync(sessionPath)) return null;
    if (!lstatSync(sessionPath).isFile()) throw new Error('Floway Skill session path is not a regular file');
    permissions.hardenFile(sessionPath);
    const token = readFileSync(sessionPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Floway Skill session file is invalid');
    return token;
  };

  const claudeConfigDir = (): string => {
    const configuredClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    return configuredClaudeDir === undefined || configuredClaudeDir === ''
      ? join(homeDir, '.claude')
      : configuredClaudeDir;
  };

  const codexConfigDir = (): string => {
    const configuredCodexDir = process.env.CODEX_HOME;
    return configuredCodexDir === undefined || configuredCodexDir === ''
      ? join(homeDir, '.codex')
      : configuredCodexDir;
  };

  const skillRoots = (): string[] => {
    // Claude Code currently discovers personal skills in ~/.claude/skills.
    // https://code.claude.com/docs/en/skills#choose-where-skills-load
    return [...new Set([join(homeDir, '.agents', 'skills', 'floway'), join(claudeConfigDir(), 'skills', 'floway')])];
  };

  // The gateway's own loopback origin, from the same runtime state the
  // installed helper reads. Unknown when the runtime has never written it, in
  // which case no client can be configured against it either.
  const readGatewayOrigin = (): string | null => {
    try {
      const runtime: unknown = JSON.parse(readFileSync(paths.runtimeStatePath, 'utf8'));
      const port = (runtime as { port?: unknown }).port;
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
      return `http://${PERSONAL_HOSTNAME}:${port as number}`;
    } catch {
      return null;
    }
  };

  const directoryExists = (path: string): boolean => {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  };

  // Client configuration reads answer a boolean for the status surface: a
  // corrupt settings file must not break the page, and the file's contents
  // (which include the client's API key) never leave this process. The install
  // path stays loud about the same corruption.
  const claudeConfigured = (origin: string | null): boolean => {
    if (origin === null) return false;
    try {
      const settings: unknown = JSON.parse(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8'));
      const env = (settings as { env?: unknown }).env;
      const baseUrl = env !== null && typeof env === 'object'
        ? (env as Record<string, unknown>).ANTHROPIC_BASE_URL
        : undefined;
      return typeof baseUrl === 'string' && baseUrl.replace(/\/+$/, '') === origin;
    } catch {
      return false;
    }
  };

  const codexConfigured = (origin: string | null): boolean => {
    if (origin === null) return false;
    try {
      // Agent Setup writes model_providers.floway.base_url as origin plus a
      // path, so the slash also keeps one port's prefix from matching another.
      return readFileSync(join(codexConfigDir(), 'config.toml'), 'utf8').includes(`${origin}/`);
    } catch {
      return false;
    }
  };

  const managedSkillInstalled = (): boolean => {
    try {
      return readSessionToken() !== null
        && skillRoots().some(root => {
          try {
            return managedSkill(join(root, 'SKILL.md'));
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    }
  };

  const readStatus = async (): Promise<PersonalAgentSkillStatus> => {
    const origin = readGatewayOrigin();
    return {
      installed: managedSkillInstalled(),
      clients: [
        { agent: 'claude', installed: directoryExists(claudeConfigDir()), configured: claudeConfigured(origin) },
        { agent: 'codex', installed: directoryExists(codexConfigDir()), configured: codexConfigured(origin) },
      ],
    };
  };

  const managedSkill = (skillPath: string): boolean => {
    if (!existsSync(skillPath)) return false;
    if (!lstatSync(skillPath).isFile()) throw new Error(`Floway Skill path is not a regular file: ${skillPath}`);
    return readFileSync(skillPath, 'utf8').includes(MANAGED_SKILL_MARKER);
  };

  const launcher = platform === 'win32'
    ? `$script = Join-Path $PSScriptRoot 'floway.mjs'\n& ${powerShellLiteral(nodeExecutable)} $script @args\nexit $LASTEXITCODE\n`
    : `#!/bin/sh\nexec ${shellLiteral(nodeExecutable)} "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/floway.mjs" "$@"\n`;

  const writeBundle = (root: string): void => {
    mkdirSync(join(root, 'scripts'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'references'), { recursive: true, mode: 0o700 });
    writeAtomic(join(root, 'scripts', 'floway.mjs'), FLOWAY_SKILL_HELPER, 0o644);
    writeAtomic(join(root, 'scripts', platform === 'win32' ? 'floway.ps1' : 'floway'), launcher, platform === 'win32' ? 0o644 : 0o755);
    writeAtomic(join(root, 'connection.json'), `${JSON.stringify({ dataDir: paths.dataDir })}\n`, 0o644);
    for (const [file, contents] of FLOWAY_SKILL_REFERENCES) {
      writeAtomic(join(root, 'references', file), contents, 0o644);
    }
    // Publish the entrypoint last, after every referenced file is available.
    writeAtomic(join(root, 'SKILL.md'), FLOWAY_SKILL_MARKDOWN, 0o644);
  };

  const install = async (sessionToken: string): Promise<{ path: string }> => {
    if (!/^[0-9a-f]{64}$/.test(sessionToken)) throw new Error('Floway Skill session token is invalid');
    const roots = skillRoots();
    for (const root of roots) {
      const skillPath = join(root, 'SKILL.md');
      if (existsSync(skillPath) && !managedSkill(skillPath)) {
        throw new Error(`Floway Skill cannot replace an unmanaged skill at ${skillPath}`);
      }
    }
    for (const root of roots) writeBundle(root);
    writeAtomic(sessionPath, `${sessionToken}\n`, 0o600);
    permissions.hardenFile(sessionPath);
    return { path: join(roots[0], 'SKILL.md') };
  };

  // An app update refreshes only already-installed managed copies. Missing or
  // owner-managed skills stay untouched; the existing private session remains valid.
  const refreshInstalled = (): void => {
    if (readSessionToken() === null) return;
    for (const root of skillRoots()) {
      if (managedSkill(join(root, 'SKILL.md'))) writeBundle(root);
    }
  };

  return { readSessionToken, install, readStatus, refreshInstalled };
};
