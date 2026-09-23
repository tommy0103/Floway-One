import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { PersonalRuntimePaths } from './personal-runtime.ts';
import type { InitializedPersonalStorage } from './personal-storage.ts';
import { FLOWAY_SKILL_HELPER, FLOWAY_SKILL_MARKDOWN, FLOWAY_SKILL_REFERENCES } from '@floway-dev/agent-setup';
import type { PersonalAgentSkillInstaller } from '@floway-dev/gateway';

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

  const skillRoots = (): string[] => {
    const configuredClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    const claudeDir = configuredClaudeDir === undefined || configuredClaudeDir === ''
      ? join(homeDir, '.claude')
      : configuredClaudeDir;
    // Claude Code currently discovers personal skills in ~/.claude/skills.
    // https://code.claude.com/docs/en/skills#choose-where-skills-load
    return [...new Set([join(homeDir, '.agents', 'skills', 'floway'), join(claudeDir, 'skills', 'floway')])];
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

  return { readSessionToken, install, refreshInstalled };
};
