import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdaptorServer, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { DESKTOP_RUNTIME_HEALTH_PATH } from '../src/desktop-runtime-compatibility.ts';
import { createLocalApp } from '../src/local-app.ts';
import { gatewayTestUrls } from '@floway-dev/test-utils';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

let staticRoot: string;

const navigationPaths = [
  '/',
  '/dashboard',
  '/dashboard/settings',
  '/dashboard/providers/upstreams/:id',
];

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), 'floway-local-app-'));
  await mkdir(join(staticRoot, 'assets'));
  await Promise.all([
    writeFile(join(staticRoot, 'index.html'), '<main>Floway Dashboard</main>'),
    writeFile(join(staticRoot, 'dashboard-routes.json'), JSON.stringify(navigationPaths)),
    writeFile(join(staticRoot, 'robots.txt'), 'User-agent: *\nDisallow:'),
    writeFile(join(staticRoot, 'assets', 'app-12345678.js'), 'export {};'),
    writeFile(join(staticRoot, 'assets', 'styles-12345678.css'), 'body {}'),
    writeFile(join(staticRoot, 'assets', 'font-12345678.woff2'), 'font'),
    writeFile(join(staticRoot, 'assets', 'icon-12345678.svg'), '<svg/>'),
    writeFile(join(staticRoot, 'assets', 'data-12345678.json'), '{}'),
    writeFile(join(staticRoot, 'assets', 'app-12345678.js.map'), '{}'),
  ]);
});

afterEach(async () => {
  await rm(staticRoot, { recursive: true, force: true });
});

describe('local app', () => {
  it('serves the exact desktop compatibility contract only when desktop integration is active', async () => {
    const desktopCompatibility = {
      contractDigest: 'a'.repeat(64),
      protocolVersion: 1 as const,
      releaseVersion: '0.1.0',
    };
    const gatewayFetch = vi.fn(() => new Response('gateway'));
    const localApp = createLocalApp({ desktopCompatibility, gatewayFetch, staticRoot });

    const response = await localApp.fetch(new Request(`http://local.test${DESKTOP_RUNTIME_HEALTH_PATH}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      compatibility: desktopCompatibility,
      service: 'floway',
      status: 'ok',
    });
    expect(gatewayFetch).not.toHaveBeenCalled();

    const serverOnly = createLocalApp({ gatewayFetch, staticRoot });
    expect(serverOnly.fetch(new Request(`http://local.test${DESKTOP_RUNTIME_HEALTH_PATH}`)))
      .toBe(await Promise.resolve(gatewayFetch.mock.results.at(-1)?.value));
  });

  it('fails construction when the Dashboard document is unavailable', () => {
    expect(() => createLocalApp({
      gatewayFetch: () => new Response(),
      staticRoot: join(staticRoot, 'missing'),
    })).toThrow(/Dashboard index is unavailable/);
  });

  it('fails construction when the Dashboard route manifest is invalid', async () => {
    await writeFile(join(staticRoot, 'dashboard-routes.json'), JSON.stringify(['/', '/']));

    expect(() => createLocalApp({
      gatewayFetch: () => new Response(),
      staticRoot,
    })).toThrow(/Dashboard routes are unavailable/);
  });

  it.each([
    '/',
    '/dashboard',
    '/dashboard/',
    '/dashboard/settings',
    '/dashboard/providers/upstreams/up_test',
  ])('serves the SPA document for %s', async path => {
    const gatewayFetch = vi.fn(() => new Response('gateway'));
    const localApp = createLocalApp({ gatewayFetch, staticRoot });

    const response = await localApp.fetch(new Request(`http://local.test${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('<main>Floway Dashboard</main>');
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it.each([
    '/login',
    '/dashboard/not-a-route',
    '/dashboard/settings/extra',
    '/dashboard/providers/upstreams/up_test/extra',
  ])('does not use the SPA document for undeclared path %s', async path => {
    const gatewayFetch = vi.fn(() => new Response('gateway'));
    const localApp = createLocalApp({ gatewayFetch, staticRoot });
    const request = new Request(`http://local.test${path}`);

    const response = await localApp.fetch(request);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('404 Not Found');
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['app-12345678.js', 'text/javascript; charset=utf-8'],
    ['styles-12345678.css', 'text/css; charset=utf-8'],
    ['font-12345678.woff2', 'font/woff2'],
    ['icon-12345678.svg', 'image/svg+xml; charset=utf-8'],
    ['data-12345678.json', 'application/json'],
    ['app-12345678.js.map', 'application/json'],
  ])('serves %s with immutable caching and %s', async (filename, contentType) => {
    const localApp = createLocalApp({ gatewayFetch: () => new Response('gateway'), staticRoot });

    const response = await localApp.fetch(new Request(`http://local.test/assets/${filename}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it('returns a real 404 for a missing static asset', async () => {
    const gatewayFetch = vi.fn(() => new Response('gateway'));
    const localApp = createLocalApp({ gatewayFetch, staticRoot });

    const response = await localApp.fetch(new Request('http://local.test/assets/missing.js'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('404 Not Found');
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it('serves an unhashed public asset with revalidation', async () => {
    const localApp = createLocalApp({ gatewayFetch: () => new Response('gateway'), staticRoot });

    const response = await localApp.fetch(new Request('http://local.test/robots.txt'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it.each(gatewayTestUrls)('routes %s directly to the gateway', path => {
    const gatewayResponse = new Response('gateway');
    const gatewayFetch = vi.fn(() => gatewayResponse);
    const localApp = createLocalApp({ gatewayFetch, staticRoot });
    const request = new Request(`http://local.test${path}`);

    expect(localApp.fetch(request)).toBe(gatewayResponse);
    expect(gatewayFetch).toHaveBeenCalledWith(request);
  });

  it('returns 404 for non-navigation methods on Dashboard paths', async () => {
    const gatewayFetch = vi.fn(() => new Response('gateway'));
    const localApp = createLocalApp({ gatewayFetch, staticRoot });
    const request = new Request('http://local.test/dashboard', { method: 'POST' });

    const response = await localApp.fetch(request);

    expect(response.status).toBe(404);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it('passes SSE responses through without buffering or replacement', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
        controller.close();
      },
    });
    const gatewayResponse = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    const localApp = createLocalApp({ gatewayFetch: () => gatewayResponse, staticRoot });

    const response = localApp.fetch(new Request('http://local.test/v1/responses'));

    expect(response).toBe(gatewayResponse);
    expect(await gatewayResponse.text()).toBe('data: ready\n\n');
  });

  it('passes WebSocket upgrade requests, environment, and responses through unchanged', () => {
    const gatewayResponse = new Response();
    const gatewayFetch = vi.fn((_request: Request, _environment: { connection: string }) => gatewayResponse);
    const localApp = createLocalApp({ gatewayFetch, staticRoot });
    const request = new Request('http://local.test/v1/responses', { headers: { Upgrade: 'websocket' } });
    const environment = { connection: 'node-websocket' };

    expect(localApp.fetch(request, environment)).toBe(gatewayResponse);
    expect(gatewayFetch).toHaveBeenCalledWith(request, environment);
  });

  it('carries SSE and WebSocket traffic through a real Node server', async () => {
    const gateway = new Hono()
      .get('/api/events', c => c.body('data: ready\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
      .get('/v1/responses', upgradeWebSocket(() => ({
        onOpen: (_event, socket) => socket.send('ready'),
      })));
    const localApp = createLocalApp({ gatewayFetch: gateway.fetch, staticRoot });
    const server = createAdaptorServer({
      fetch: localApp.fetch,
      websocket: { server: new WebSocketServer({ noServer: true }) },
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Node server did not expose a TCP address');

      const origin = `http://127.0.0.1:${address.port}`;
      const sseResponse = await fetch(`${origin}/api/events`);
      expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');
      expect(await sseResponse.text()).toBe('data: ready\n\n');

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
      const message = await new Promise<string>((resolve, reject) => {
        socket.once('message', data => resolve(data.toString()));
        socket.once('error', reject);
      });
      expect(message).toBe('ready');
      socket.close();
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
