import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE_CONTROL = 'no-cache';

type GatewayResponse = Response | Promise<Response>;

export interface LocalAppOptions<GatewayArgs extends unknown[]> {
  gatewayFetch: (request: Request, ...args: GatewayArgs) => GatewayResponse;
  staticRoot: string;
}

const requireDashboardIndex = (staticRoot: string): void => {
  const indexPath = join(staticRoot, 'index.html');
  try {
    if (!statSync(indexPath).isFile()) throw new Error('the path is not a file');
  } catch (cause) {
    throw new Error(`Dashboard index is unavailable at ${indexPath}`, { cause });
  }
};

const isDashboardRequest = (request: Request): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  const { pathname } = new URL(request.url);
  return pathname === '/'
    || pathname === '/login'
    || pathname === '/dashboard'
    || pathname.startsWith('/dashboard/')
    || pathname === '/assets'
    || pathname.startsWith('/assets/')
    || pathname === '/robots.txt';
};

export const createLocalApp = <GatewayArgs extends unknown[]>({
  gatewayFetch,
  staticRoot,
}: LocalAppOptions<GatewayArgs>) => {
  const root = resolve(staticRoot);
  requireDashboardIndex(root);

  const dashboard = new Hono();

  dashboard.use('/assets/*', serveStatic({
    root,
    onFound: (_path, c) => c.res.headers.set('Cache-Control', IMMUTABLE_CACHE_CONTROL),
  }));
  dashboard.on(['GET', 'HEAD'], ['/assets', '/assets/*'], c => c.notFound());

  dashboard.use('/robots.txt', serveStatic({
    root,
    onFound: (_path, c) => c.res.headers.set('Cache-Control', REVALIDATE_CACHE_CONTROL),
  }));
  dashboard.on(['GET', 'HEAD'], '/robots.txt', c => c.notFound());

  dashboard.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', REVALIDATE_CACHE_CONTROL);
  });
  dashboard.use('*', serveStatic({
    root,
    path: 'index.html',
  }));

  return {
    fetch: (request: Request, ...args: GatewayArgs): GatewayResponse => {
      if (isDashboardRequest(request)) return dashboard.fetch(request);
      return gatewayFetch(request, ...args);
    },
  };
};
