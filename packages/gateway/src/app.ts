import { Hono } from 'hono';
import { logger } from 'hono/logger';

import { AGENT_SETUP_ROUTE_PATH, agentSetupPublicRoutes } from './control-plane/agent-setup.ts';
import { personalDashboardBootstrapRoutes } from './control-plane/auth/personal-bootstrap.ts';
import { controlPlaneRoutes } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { type AuthVars, authMiddleware } from './middleware/auth.ts';
import { personalControlPlaneCors, remainingRoutesCors } from './middleware/control-plane-cors.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';

// Bootstrap deliberately uses unauthenticated fetch in the Dashboard, so its
// route need not expand the authenticated Hono RPC surface. Erasing only this
// schema generic keeps that boundary explicit.
const bootstrapRoutes: Hono<{ Variables: AuthVars }> = personalDashboardBootstrapRoutes;

// `app` is a single chained expression so its type carries the full path/method
// map Hono RPC needs — apps/web consumes the exported AppType as the generic of
// `hc<AppType>()`. The data plane is mounted imperatively after the chain
// because apps/web reaches /v1/chat/completions etc. by plain fetch, not through
// the RPC client, so its route types need not be preserved.
export const app = new Hono<{ Variables: AuthVars }>()
  .onError(internalErrorResponse)
  .use('*', personalControlPlaneCors)
  // The public Agent Setup script endpoints reveal the selected API key as
  // executable source to an unauthenticated machine on purpose. They are mounted
  // here, structurally ahead of the logger / CORS / auth middleware below, so no
  // per-path bypass is needed in any of those layers and a lease token never
  // reaches a log line. The package seals every failure on these routes itself.
  .route(AGENT_SETUP_ROUTE_PATH, agentSetupPublicRoutes)
  // The bootstrap authority is carried in the request body, but mounting its
  // exchange before the access logger makes the no-logging property structural
  // even if logger behavior changes later.
  .route('/', bootstrapRoutes)
  .use('*', logger())
  .use('*', remainingRoutesCors)
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

mountDataPlane(app);

export type AppType = typeof app;
