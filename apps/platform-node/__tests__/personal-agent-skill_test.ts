import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { test } from 'vitest';

import { createPersonalAgentSkillInstaller, PERSONAL_AGENT_SKILL_SESSION_FILE } from '../src/personal-agent-skill.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { initializePersonalStorage } from '../src/personal-storage.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const TOKEN = 'a'.repeat(64);

const withInstaller = async (operation: (root: string, installer: ReturnType<typeof createPersonalAgentSkillInstaller>, dataDir: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'floway-agent-skill-'));
  const paths = resolvePersonalRuntimePaths({ dataDir: join(root, 'data'), stableUserHome: root });
  try {
    const permissions = initializePersonalStorage(paths);
    const installer = createPersonalAgentSkillInstaller({ paths, permissions, homeDir: root });
    await operation(root, installer, paths.dataDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('personal Floway Skill installs once for Codex and Claude with private authorization', () => withInstaller(async (root, installer, dataDir) => {
  assertEquals(installer.readSessionToken(), null);
  const { path } = await installer.install(TOKEN);
  assertEquals(path, join(root, '.agents/skills/floway/SKILL.md'));
  for (const skillPath of [path, join(root, '.claude/skills/floway/SKILL.md')]) {
    const contents = await readFile(skillPath, 'utf8');
    assert(contents.startsWith('---\nname: floway\n'));
    assert(!contents.includes(TOKEN));
    const connection = JSON.parse(await readFile(join(skillPath, '../connection.json'), 'utf8'));
    assertEquals(connection, { dataDir });
  }
  const sessionPath = join(dataDir, PERSONAL_AGENT_SKILL_SESSION_FILE);
  assertEquals(installer.readSessionToken(), TOKEN);
  assertEquals((await readFile(sessionPath, 'utf8')).trim(), TOKEN);
  if (process.platform !== 'win32') assertEquals((await stat(sessionPath)).mode & 0o777, 0o600);
}));

test('personal Floway Skill preserves an unmanaged skill and its authorization', () => withInstaller(async (root, installer, dataDir) => {
  const skillDir = join(root, '.agents/skills/floway');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: floway\n---\n\n# Owner skill\n');
  await assertRejects(() => installer.install(TOKEN), Error, 'unmanaged skill');
  assertEquals(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), '---\nname: floway\n---\n\n# Owner skill\n');
  await assertRejects(() => readFile(join(dataDir, PERSONAL_AGENT_SKILL_SESSION_FILE)), Error);
}));

test('personal Floway Skill checks Claude destination before changing the shared copy', () => withInstaller(async (root, installer, dataDir) => {
  const claudeDir = join(root, '.claude/skills/floway');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(join(claudeDir, 'SKILL.md'), '---\nname: floway\n---\n\n# Owner skill\n');
  await assertRejects(() => installer.install(TOKEN), Error, 'unmanaged skill');
  await assertRejects(() => readFile(join(root, '.agents/skills/floway/SKILL.md')), Error);
  await assertRejects(() => readFile(join(dataDir, PERSONAL_AGENT_SKILL_SESSION_FILE)), Error);
}));

test('installed helper follows a changed local port without exposing the session', () => withInstaller(async (_root, installer, dataDir) => {
  const { path } = await installer.install(TOKEN);
  const helper = join(path, '../scripts/floway.mjs');
  const run = promisify(execFile);
  for (const index of [1, 2]) {
    const server = createServer((request, response) => {
      assertEquals(request.headers['x-floway-session'], TOKEN);
      assertEquals(request.url, '/auth/me');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ user: { username: `owner-${index}` } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
      await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ version: 1, port: address.port }));
      const { stdout, stderr } = await run(process.execPath, [helper, 'status']);
      assertEquals(stderr, '');
      assertEquals(JSON.parse(stdout).owner, `owner-${index}`);
      assertEquals(JSON.parse(stdout).gateway, `http://127.0.0.1:${address.port}`);
      assert(!stdout.includes(TOKEN));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}));

test('installed helper completes key and device authorization without printing provider secrets', () => withInstaller(async (root, installer, dataDir) => {
  const { path } = await installer.install(TOKEN);
  const helper = join(path, '../scripts/floway.mjs');
  const key = 'sk-private-provider-key';
  const keyPath = join(root, 'provider-key');
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  let customCreated = false;
  let copilotCreated = false;
  const server = createServer((request, response) => {
    void (async () => {
      assertEquals(request.headers['x-floway-session'], TOKEN);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let reply: unknown;
      if (url.pathname === '/api/upstreams/blueprint') {
        reply = { id: '', kind: url.searchParams.get('kind'), name: '', enabled: false, config: {}, state: null };
      } else if (url.pathname === '/api/upstreams/copilot/oauth/device-login/start') {
        reply = { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 };
      } else if (url.pathname === '/api/upstreams/copilot/oauth/device-login/poll') {
        assertEquals(body.deviceCode, 'device-secret');
        reply = { status: 'complete', patch: { config: { githubToken: 'oauth-secret' }, state: null } };
      } else if (url.pathname === '/api/upstreams' && request.method === 'POST') {
        assertEquals(body.enabled, true);
        if (body.kind === 'custom') {
          customCreated = true;
          assertEquals(body.config.apiKey, key);
        } else {
          copilotCreated = true;
          assertEquals(body.config.githubToken, 'oauth-secret');
        }
        reply = { id: body.kind === 'custom' ? 'custom-id' : 'copilot-id', name: body.name, kind: body.kind, enabled: true };
      } else if (url.pathname.startsWith('/api/upstreams/') && request.method === 'GET') {
        reply = { id: url.pathname.split('/').at(-1), kind: 'custom', config: {} };
      } else if (url.pathname === '/api/upstreams/list-models') {
        reply = { data: [{ id: 'usable-model' }] };
      } else {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply));
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
    await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ version: 1, port: address.port }));
    const run = promisify(execFile);
    const custom = await run(process.execPath, [helper, 'create-custom', 'Example', 'https://provider.example', keyPath]);
    assertEquals(JSON.parse(custom.stdout).status, 'verified');
    assertEquals(JSON.parse(custom.stdout).models, ['usable-model']);
    assert(!custom.stdout.includes(key));
    const started = await run(process.execPath, [helper, 'copilot-start', 'Copilot']);
    const handle = JSON.parse(started.stdout).handle as string;
    assertEquals(JSON.parse(started.stdout).status, 'authorization_required');
    assert(!started.stdout.includes('device-secret'));
    const finished = await run(process.execPath, [helper, 'copilot-finish', handle]);
    assertEquals(JSON.parse(finished.stdout).status, 'verified');
    assert(!finished.stdout.includes('oauth-secret'));
    assert(customCreated && copilotCreated);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));
