import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const helperSource = fileURLToPath(new URL('../../skills/floway/scripts/floway.mjs', import.meta.url));
const SESSION = 'a'.repeat(64);
const TARGET = 'up_target';
const MODEL = 'shared-model';
const SCOPED_KEY = 'sk-scoped-test-secret';
const OTHER_KEY = 'sk-unrestricted-secret';

interface ProbeRun {
  code: number;
  stdout: string;
  stderr: string;
  calls: Array<{ method: string; path: string; credential: string | undefined; body: unknown }>;
}

const runProbe = async ({ existingScoped = false, deleteFails = false, chatFails = false } = {}): Promise<ProbeRun> => {
  const calls: ProbeRun['calls'] = [];
  const json = (value: unknown) => JSON.stringify(value);
  const handleRequest = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const body = req.method === 'POST' ? await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString()) : '';
    const path = req.url ?? '';
    calls.push({
      method: req.method ?? '',
      path,
      credential: req.headers.authorization ?? req.headers['x-api-key']?.toString(),
      body: body ? JSON.parse(body) as unknown : null,
    });
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json(value));
    };
    if (path === '/api/models?aliases=false&include_unlisted=true') {
      respond(200, {
        data: [{
          id: MODEL,
          kind: 'chat',
          upstreams: [{ id: TARGET, name: 'Target' }, { id: 'up_other', name: 'Other' }],
        }],
      });
    } else if (path === '/api/keys' && req.method === 'GET') {
      respond(200, [
        { id: 'wide', name: 'Wide', key: OTHER_KEY, upstream_ids: null },
        ...(existingScoped ? [{ id: 'existing', name: 'Existing scoped', key: SCOPED_KEY, upstream_ids: [TARGET] }] : []),
      ]);
    } else if (path === '/api/keys' && req.method === 'POST') {
      respond(201, { id: 'temporary', name: 'Temporary scoped', key: SCOPED_KEY, upstream_ids: [TARGET] });
    } else if (path === '/api/keys/temporary' && req.method === 'DELETE') {
      respond(deleteFails ? 500 : 200, deleteFails ? { error: 'delete failed' } : { ok: true });
    } else if (path === '/v1/chat/completions' && chatFails) {
      respond(502, { error: 'upstream failed' });
    } else if (path === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.output_text.delta\ndata: {"delta":"OK"}\n\nevent: response.completed\ndata: {}\n\n');
    } else if (path === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    } else if (path === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_stop"}\n\n');
    } else {
      respond(404, { error: 'unexpected request' });
    }
  };
  const server = createServer((req, res) => { void handleRequest(req, res).catch(error => res.destroy(error)); });
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'floway-skill-probe-'));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
    const skillRoot = join(temporaryRoot, 'skill');
    const dataDir = join(temporaryRoot, 'data');
    mkdirSync(join(skillRoot, 'scripts'), { recursive: true });
    mkdirSync(dataDir);
    copyFileSync(helperSource, join(skillRoot, 'scripts', 'floway.mjs'));
    writeFileSync(join(skillRoot, 'connection.json'), json({ dataDir }));
    writeFileSync(join(dataDir, 'runtime.json'), json({ port: address.port }));
    writeFileSync(join(dataDir, 'agent-skill.session'), SESSION);
    const result = await new Promise<Pick<ProbeRun, 'code' | 'stdout' | 'stderr'>>(resolve => {
      execFile(process.execPath, [join(skillRoot, 'scripts', 'floway.mjs'), 'test-model', TARGET, MODEL], { timeout: 10_000 }, (error, stdout, stderr) => {
        resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
      });
    });
    return { ...result, calls };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

test('test-model creates and revokes a single-service key for every external format', async () => {
  const result = await runProbe();
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const created = result.calls.find(call => call.method === 'POST' && call.path === '/api/keys');
  expect(created?.body).toMatchObject({ upstream_ids: [TARGET], key_source: 'generate' });
  const probes = result.calls.filter(call => call.path.startsWith('/v1/'));
  expect(probes.map(call => call.path)).toEqual(['/v1/responses', '/v1/chat/completions', '/v1/messages']);
  expect(probes.map(call => call.credential)).toEqual([`Bearer ${SCOPED_KEY}`, `Bearer ${SCOPED_KEY}`, SCOPED_KEY]);
  expect(result.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/keys/temporary' });
  const output = JSON.parse(result.stdout) as { status: string; upstreamId: string; formats: Array<{ status: string }> };
  expect(output.status).toBe('tested');
  expect(output.upstreamId).toBe(TARGET);
  expect(output.formats.map(format => format.status)).toEqual(['available', 'available', 'available']);
  expect(result.stdout).not.toContain(SCOPED_KEY);
});

test('test-model reuses an existing single-service key without changing it', async () => {
  const result = await runProbe({ existingScoped: true });
  expect(result.code).toBe(0);
  expect(result.calls.some(call => call.path === '/api/keys' && call.method === 'POST')).toBe(false);
  expect(result.calls.some(call => call.method === 'DELETE')).toBe(false);
  expect(result.calls.filter(call => call.path.startsWith('/v1/'))).toHaveLength(3);
});

test('test-model exposes failed cleanup and still revokes after a failed probe', async () => {
  const result = await runProbe({ deleteFails: true, chatFails: true });
  expect(result.code).toBe(2);
  expect(result.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/keys/temporary' });
  const output = JSON.parse(result.stdout) as {
    status: string;
    keyCleanup: { keyId: string; status: string };
    formats: Array<{ status: string }>;
  };
  expect(output.status).toBe('needs_attention');
  expect(output.keyCleanup).toMatchObject({ keyId: 'temporary', status: 'failed' });
  expect(output.formats.map(format => format.status)).toEqual(['available', 'failed', 'available']);
  expect(result.stdout).not.toContain(SCOPED_KEY);
});
