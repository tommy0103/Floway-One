import { type Context, type Next } from 'hono';
import { cors } from 'hono/cors';

import { getPersonalDashboardOrigin } from '../control-plane/auth/personal-bootstrap.ts';
import { getRuntimeProfile } from '@floway-dev/platform';

const BOOTSTRAP_PATH = '/auth/bootstrap';
const permissiveCors = cors();

const isControlPlanePath = (path: string): boolean =>
  path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/');

export const personalControlPlaneCors = async (c: Context, next: Next): Promise<Response | void> => {
  if (getRuntimeProfile().mode !== 'personal' || !isControlPlanePath(c.req.path)) {
    return await next();
  }

  const origin = c.req.header('origin');
  if (origin === undefined) {
    if (c.req.path === BOOTSTRAP_PATH) {
      return c.json({ error: 'Origin is not allowed for the personal control plane' }, 403);
    }
    return await next();
  }

  const allowedOrigin = getPersonalDashboardOrigin();
  if (origin !== allowedOrigin) {
    return c.json({ error: 'Origin is not allowed for the personal control plane' }, 403);
  }
  return await cors({ origin: allowedOrigin })(c, next);
};

export const remainingRoutesCors = async (c: Context, next: Next): Promise<Response | void> => {
  if (getRuntimeProfile().mode === 'personal' && isControlPlanePath(c.req.path)) {
    return await next();
  }
  return await permissiveCors(c, next);
};
