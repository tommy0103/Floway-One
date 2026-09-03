import { fileURLToPath } from 'node:url';

import { serve, upgradeWebSocket } from '@hono/node-server';
import { Agent, Pool, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

import { bootstrapNodePlatform } from './bootstrap.ts';
import { createLocalApp } from './local-app.ts';
import { applyMigrations } from './migrate.ts';
import { resolvePersonalRuntimePaths } from './personal-runtime.ts';
import { selectNodeRuntimeProfile } from './runtime-profile.ts';
import { startScheduledMaintenance } from './scheduled-maintenance.ts';
import { createNodeStoredSecretCodec } from './stored-secrets.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  initOpenAIResponsesWebSocketUpgradeResolver,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional } from '@floway-dev/platform';

// Copilot data-plane hosts close their keep-alive socket right after each
// response; reusing it surfaces as UND_ERR_SOCKET or
// RequestContentLengthMismatchError. `pipelining: 0` disables keep-alive.
//
// The host list is decided by GitHub (returned in /copilot_internal/v2/token
// `endpoints.api`, never enumerated locally), so match the
// `*.githubcopilot.com` family instead of today's individual hostnames.
//
// Refs: https://github.com/nodejs/undici/blob/v6.21.0/docs/docs/api/Client.md#parameter-clientoptions
//       https://github.com/Menci/Floway/pull/78#issuecomment-4765475966
const isCopilotDataPlaneHost = (hostname: string): boolean =>
  hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com');
setGlobalDispatcher(new Agent({
  factory: (origin, opts) => {
    const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
    return new Pool(origin, isCopilotDataPlaneHost(hostname) ? { ...opts, pipelining: 0 } : opts);
  },
}));

// In Node there is no Workers request lifecycle for waitUntil. Logging a
// rejection here is the only signal for a failed fire-and-forget task.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initOpenAIResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

export interface NodeEntryOverrides {
  readonly bootstrapNodePlatform?: typeof bootstrapNodePlatform;
  readonly resolvePersonalRuntimePaths?: typeof resolvePersonalRuntimePaths;
}

export const runNodeEntry = async (overrides: NodeEntryOverrides = {}): Promise<void> => {
  const profile = selectNodeRuntimeProfile(process.argv.slice(2));
  const personalPaths = profile === 'personal'
    ? (overrides.resolvePersonalRuntimePaths ?? resolvePersonalRuntimePaths)()
    : undefined;
  const { db, deviceMasterKeyCreationLock, personalStorage } = (overrides.bootstrapNodePlatform ?? bootstrapNodePlatform)(
    personalPaths === undefined
      ? { profile: 'server' }
      : { profile: 'personal', storage: personalPaths },
  );
  const port = Number(getEnvOptional('PORT', '8788'));

  // Passwordless admin login is a dev-only shortcut. Refuse production Node
  // startup without ADMIN_KEY so misconfiguration surfaces before listening.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
    console.error('FATAL: NODE_ENV=production requires ADMIN_KEY. Passwordless admin login is only allowed on dev instances.');
    process.exit(1);
  }

  await applyMigrations(db);
  if (personalPaths !== undefined) personalStorage?.hardenSqliteFiles(personalPaths.databasePath);
  const storedSecrets = await createNodeStoredSecretCodec(profile, db, deviceMasterKeyCreationLock);
  initRepo(new SqlRepo(db, { storedSecrets }));

  startScheduledMaintenance();

  const localApp = createLocalApp({
    gatewayFetch: app.fetch,
    staticRoot: fileURLToPath(new URL('../../web/dist/client', import.meta.url)),
  });

  const personalHostname = profile === 'personal' ? '127.0.0.1' : undefined;
  serve({
    fetch: localApp.fetch,
    ...(personalHostname === undefined ? {} : { hostname: personalHostname }),
    port,
    websocket: { server: new WebSocketServer({ noServer: true }) },
  }, info => {
    const displayedHostname = personalHostname === undefined ? 'localhost' : info.address;
    console.log(`Floway listening on http://${displayedHostname}:${info.port}`);
  });
};
