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

test('installed helper creates Upstreams with distinct hues and keeps provider secrets private', () => withInstaller(async (root, installer, dataDir) => {
  const { path } = await installer.install(TOKEN);
  const helper = join(path, '../scripts/floway.mjs');
  const key = 'sk-private-provider-key';
  const keyPath = join(root, 'provider-key');
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  let customCreated = false;
  let ollamaCreated = false;
  let copilotCreated = false;
  let customPathOverride = false;
  let customModelsEndpoint = false;
  const expectedCustomBaseUrls: Record<string, string> = {
    Nested: 'https://provider.example/api/',
    Root: 'https://provider.example/',
    Beta: 'https://provider.example/v1beta',
    'Models Override': 'https://provider.example/v1/',
    Override: 'https://provider.example/v1/',
  };
  const hues = [90];
  const server = createServer((request, response) => {
    void (async () => {
      assertEquals(request.headers['x-floway-session'], TOKEN);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let reply: unknown;
      if (url.pathname === '/api/upstreams/blueprint') {
        const kind = url.searchParams.get('kind');
        const config: Record<string, unknown> = {};
        if (kind === 'custom') {
          config.modelsFetch = customModelsEndpoint ? { enabled: true, endpoint: '/models' } : { enabled: true };
          if (customPathOverride) config.pathOverrides = { '/chat/completions': '/chat' };
        }
        reply = { id: '', kind, name: '', enabled: false, config, state: null };
      } else if (url.pathname === '/api/upstreams' && request.method === 'GET') {
        reply = hues.map(hue => ({ hue }));
      } else if (url.pathname === '/api/upstreams/copilot/oauth/device-login/start') {
        reply = { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 };
      } else if (url.pathname === '/api/upstreams/copilot/oauth/device-login/poll') {
        assertEquals(body.deviceCode, 'device-secret');
        reply = { status: 'complete', patch: { config: { githubToken: 'oauth-secret' }, state: null } };
      } else if (url.pathname === '/api/upstreams' && request.method === 'POST') {
        if (!Number.isInteger(body.hue) || body.hue < 0 || body.hue >= 360 || hues.includes(body.hue)) {
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'A distinct hue is required.' }));
          return;
        }
        hues.push(body.hue);
        assertEquals(body.enabled, true);
        if (body.kind === 'custom') {
          customCreated = true;
          assertEquals(body.config.apiKey, key);
          assertEquals(body.config.baseUrl, expectedCustomBaseUrls[body.name]);
        } else if (body.kind === 'ollama') {
          ollamaCreated = true;
        } else {
          copilotCreated = true;
          assertEquals(body.config.githubToken, 'oauth-secret');
        }
        reply = { id: `${body.kind}-id`, name: body.name, kind: body.kind, enabled: true };
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
    const custom = await run(process.execPath, [helper, 'create-custom', 'Nested', 'https://provider.example/api/v1/', keyPath]);
    assertEquals(JSON.parse(custom.stdout).status, 'verified');
    assertEquals(JSON.parse(custom.stdout).models, ['usable-model']);
    assertEquals(JSON.parse(custom.stdout).baseUrl, 'https://provider.example/api/');
    assert(!custom.stdout.includes(key));
    assertEquals(hues[1], 270);
    const rootUrl = await run(process.execPath, [helper, 'create-custom', 'Root', 'https://provider.example/v1', keyPath]);
    assertEquals(JSON.parse(rootUrl.stdout).baseUrl, 'https://provider.example/');
    const beta = await run(process.execPath, [helper, 'create-custom', 'Beta', 'https://provider.example/v1beta', keyPath]);
    assertEquals(JSON.parse(beta.stdout).baseUrl, 'https://provider.example/v1beta');
    customModelsEndpoint = true;
    const modelsOverride = await run(process.execPath, [helper, 'create-custom', 'Models Override', 'https://provider.example/v1/', keyPath]);
    assertEquals(JSON.parse(modelsOverride.stdout).baseUrl, 'https://provider.example/v1/');
    customModelsEndpoint = false;
    customPathOverride = true;
    const overridden = await run(process.execPath, [helper, 'create-custom', 'Override', 'https://provider.example/v1/', keyPath]);
    assertEquals(JSON.parse(overridden.stdout).baseUrl, 'https://provider.example/v1/');
    await assertRejects(() => run(process.execPath, [helper, 'create-custom', 'Invalid', 'https://provider.example/v1?token=x', keyPath]), Error, 'provider URL');
    await assertRejects(() => run(process.execPath, [helper, 'create-custom', 'Invalid', 'https://provider.example/v1#fragment', keyPath]), Error, 'provider URL');
    const ollama = await run(process.execPath, [helper, 'create-ollama', 'Ollama', 'http://127.0.0.1:11434']);
    assertEquals(JSON.parse(ollama.stdout).status, 'verified');
    const started = await run(process.execPath, [helper, 'copilot-start', 'Copilot']);
    const handle = JSON.parse(started.stdout).handle as string;
    assertEquals(JSON.parse(started.stdout).status, 'authorization_required');
    assert(!started.stdout.includes('device-secret'));
    const finished = await run(process.execPath, [helper, 'copilot-finish', handle]);
    assertEquals(JSON.parse(finished.stdout).status, 'verified');
    assert(!finished.stdout.includes('oauth-secret'));
    assert(customCreated && ollamaCreated && copilotCreated);
    assertEquals(new Set(hues).size, 8);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test('custom probe checks four native paths with user-only requests and creates only selected endpoints', () => withInstaller(async (root, installer, dataDir) => {
  const { path } = await installer.install(TOKEN);
  const helper = join(path, '../scripts/floway.mjs');
  const key = 'sk-native-format-secret';
  const keyPath = join(root, 'provider-key');
  await writeFile(keyPath, key, { mode: 0o600 });
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  let createdEndpoints: Record<string, unknown> | null = null;
  let rejectAll = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (url.pathname === '/api/upstreams/blueprint') return void json({
        id: '', kind: 'custom', name: '', enabled: false,
        config: { baseUrl: '', authStyle: 'bearer', apiKey: '', endpoints: { openaiChatCompletions: {} }, modelsFetch: { enabled: true }, models: [] }, state: null,
      });
      if (url.pathname === '/api/upstreams/list-models') return void json({ data: [{ id: 'chat-model' }] });
      if (url.pathname === '/api/upstreams' && request.method === 'GET') return void json([]);
      if (url.pathname === '/api/upstreams' && request.method === 'POST') {
        createdEndpoints = (body.config as Record<string, unknown>).endpoints as Record<string, unknown>;
        return void json({ id: 'up-custom', name: body.name, kind: 'custom', enabled: true });
      }
      if (url.pathname === '/api/upstreams/up-custom') return void json({ id: 'up-custom', kind: 'custom', config: {} });
      if (url.pathname.startsWith('/v1/')) {
        if (request.headers['x-api-key']) {
          assertEquals(request.headers['x-api-key'], key);
          assertEquals(request.headers['anthropic-version'], '2023-06-01');
        } else {
          assertEquals(request.headers.authorization, `Bearer ${key}`);
        }
        seen.push({ path: url.pathname, body });
        if (rejectAll) return void json({ error: 'not available for this model' }, 404);
        if (url.pathname === '/v1/responses') return void json({ error: 'unknown endpoint' }, 404);
        const event = url.pathname === '/v1/messages'
          ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_stop"}\n\n'
          : `data: {"choices":[{"${url.pathname === '/v1/completions' ? 'text' : 'delta'}":${url.pathname === '/v1/completions' ? '"OK"' : '{"content":"OK"}'}}]}\n\ndata: [DONE]\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(event);
        return;
      }
      json({ error: 'unexpected request' }, 404);
    })().catch(error => response.destroy(error));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
    await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ version: 1, port: address.port }));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const run = promisify(execFile);
    const probed = await run(process.execPath, [helper, 'probe-custom', baseUrl, keyPath, 'chat-model']);
    const result = JSON.parse(probed.stdout) as { confirmedFormats: string[]; formats: Array<{ status: string }> };
    assertEquals(result.formats.map(format => format.status), ['available', 'available', 'failed', 'available']);
    assertEquals(result.confirmedFormats, ['openaiCompletions', 'openaiChatCompletions', 'anthropicMessages']);
    assertEquals(seen.map(call => call.path), ['/v1/completions', '/v1/chat/completions', '/v1/responses', '/v1/messages']);
    assert(seen.every(call => !JSON.stringify(call.body).includes('developer')));
    assert(!probed.stdout.includes(key));
    const created = await run(process.execPath, [helper, 'create-custom', 'Native', baseUrl, keyPath, result.confirmedFormats.join(',')]);
    assertEquals(JSON.parse(created.stdout).enabledFormats, result.confirmedFormats);
    assertEquals(Object.keys(createdEndpoints ?? {}), result.confirmedFormats);
    assert(!created.stdout.includes(key));
    const anthropicAuth = await run(process.execPath, [helper, 'probe-custom', baseUrl, keyPath, '--auth-style=anthropic']);
    assertEquals(JSON.parse(anthropicAuth.stdout).authStyle, 'anthropic');
    assert(!anthropicAuth.stdout.includes(key));
    rejectAll = true;
    const unavailable = await new Promise<{ code: number; stdout: string }>(resolve => {
      execFile(process.execPath, [helper, 'probe-custom', baseUrl, keyPath, 'chat-model'], (error, stdout) => {
        resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout });
      });
    });
    assertEquals(unavailable.code, 2);
    assertEquals(JSON.parse(unavailable.stdout).status, 'needs_attention');
    assertEquals(JSON.parse(unavailable.stdout).confirmedFormats, []);
    assert(!unavailable.stdout.includes(key));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test('installed helper tests the three Playground Gateway formats without printing API keys', () => withInstaller(async (_root, installer, dataDir) => {
  const { path } = await installer.install(TOKEN);
  const helper = join(path, '../scripts/floway.mjs');
  const gatewayKey = 'sk-gateway-secret';
  const calls: string[] = [];
  let failChat = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/models') {
        assertEquals(request.headers['x-floway-session'], TOKEN);
        assertEquals(url.searchParams.get('aliases'), 'false');
        assertEquals(url.searchParams.get('include_unlisted'), 'true');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'model-a', kind: 'chat', upstreams: [{ id: 'up-a', name: 'Provider A' }] }] }));
        return;
      }
      if (url.pathname === '/api/keys') {
        assertEquals(request.headers['x-floway-session'], TOKEN);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify([{ name: 'Gateway key', key: gatewayKey, upstream_ids: ['up-a'] }]));
        return;
      }
      calls.push(url.pathname);
      assertEquals(request.headers['x-floway-session'], undefined);
      assertEquals(request.headers['content-type'], 'application/json');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream: boolean };
      assertEquals(body.model, 'model-a');
      assertEquals(body.stream, true);
      if (url.pathname === '/v1/messages') {
        assertEquals(request.headers['x-api-key'], gatewayKey);
        assertEquals(request.headers['anthropic-version'], '2023-06-01');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_stop"}\n\n');
      } else if (url.pathname === '/v1/responses') {
        assertEquals(request.headers.authorization, `Bearer ${gatewayKey}`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n');
      } else if (url.pathname === '/v1/chat/completions') {
        assertEquals(request.headers.authorization, `Bearer ${gatewayKey}`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(failChat
          ? `data: {"error":{"message":"Gateway rejected ${gatewayKey}"}}\n\n`
          : 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      } else {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
    await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ version: 1, port: address.port }));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [helper, 'test-model', 'up-a', 'model-a']);
    assertEquals(stderr, '');
    const result = JSON.parse(stdout) as { status: string; upstreamId: string; upstreamName: string; formats: { api: string; status: string }[] };
    assertEquals(result.status, 'tested');
    assertEquals(result.upstreamId, 'up-a');
    assertEquals(result.upstreamName, 'Provider A');
    assertEquals(result.formats.map(format => [format.api, format.status]), [
      ['openaiResponses', 'available'], ['openaiChatCompletions', 'available'], ['anthropicMessages', 'available'],
    ]);
    assertEquals(calls, ['/v1/responses', '/v1/chat/completions', '/v1/messages']);
    assert(!stdout.includes(gatewayKey));
    assert(!stdout.includes(TOKEN));
    failChat = true;
    const failed = await promisify(execFile)(process.execPath, [helper, 'test-model', 'up-a', 'model-a']);
    const failedFormats = (JSON.parse(failed.stdout) as { formats: { status: string; issue?: string }[] }).formats;
    assertEquals(failedFormats.map(format => format.status), ['available', 'failed', 'available']);
    assertEquals(failedFormats[1]?.issue, 'Gateway rejected [redacted]');
    assert(!failed.stdout.includes(gatewayKey));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));
