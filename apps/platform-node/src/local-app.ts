import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import {
  DESKTOP_RUNTIME_HEALTH_PATH,
  type DesktopRuntimeCompatibility,
} from './desktop-runtime-compatibility.ts';
import { isGatewayOwnedPath } from '@floway-dev/protocols/common';

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE_CONTROL = 'no-cache';
const ROUTES_MANIFEST = 'dashboard-routes.json';

type GatewayResponse = Response | Promise<Response>;

export interface LocalAppOptions<GatewayArgs extends unknown[]> {
  desktopCompatibility?: DesktopRuntimeCompatibility | null;
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

const loadDashboardNavigationPaths = (staticRoot: string): string[] => {
  const manifestPath = join(staticRoot, ROUTES_MANIFEST);
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      !Array.isArray(value)
      || value.length === 0
      || !value.every(path => typeof path === 'string' && /^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/.test(path))
    ) {
      throw new TypeError('the manifest must be a non-empty array of absolute path patterns');
    }
    if (new Set(value).size !== value.length || !value.includes('/')) {
      throw new TypeError('the manifest must contain unique paths including /');
    }
    return value;
  } catch (cause) {
    throw new Error(`Dashboard routes are unavailable at ${manifestPath}`, { cause });
  }
};

const splitPath = (path: string): string[] =>
  path === '/' ? [] : path.replace(/\/$/, '').slice(1).split('/');

const createDashboardRouteMatcher = (patterns: string[]) => {
  const routeSegments = patterns.map(pattern => splitPath(pattern));
  return (pathname: string): boolean => {
    const pathSegments = splitPath(pathname);
    return routeSegments.some(pattern =>
      pattern.length === pathSegments.length
      && pattern.every((segment, index) => segment.startsWith(':') || segment === pathSegments[index]));
  };
};

const isDashboardRequest = (request: Request, matchesNavigationPath: (pathname: string) => boolean): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  const { pathname } = new URL(request.url);
  return matchesNavigationPath(pathname)
    || pathname === '/assets'
    || pathname.startsWith('/assets/')
    || pathname === '/robots.txt';
};

export const createLocalApp = <GatewayArgs extends unknown[]>({
  desktopCompatibility,
  gatewayFetch,
  staticRoot,
}: LocalAppOptions<GatewayArgs>) => {
  const root = resolve(staticRoot);
  requireDashboardIndex(root);
  const matchesNavigationPath = createDashboardRouteMatcher(loadDashboardNavigationPaths(root));

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
      const { pathname } = new URL(request.url);
      if (desktopCompatibility !== null && desktopCompatibility !== undefined
        && pathname === DESKTOP_RUNTIME_HEALTH_PATH
        && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({
          compatibility: desktopCompatibility,
          service: 'floway',
          status: 'ok',
        }), {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
          },
        });
      }
      if (isGatewayOwnedPath(pathname)) return gatewayFetch(request, ...args);
      if (isDashboardRequest(request, matchesNavigationPath)) return dashboard.fetch(request);
      return new Response('404 Not Found', { status: 404 });
    },
  };
};
