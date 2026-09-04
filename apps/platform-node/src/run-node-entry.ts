import { fileURLToPath } from 'node:url';

import { createAdaptorServer, upgradeWebSocket } from '@hono/node-server';
import { Agent, Pool, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

import {
  bootstrapNodePlatform,
  resolveNodeRuntimeProfile,
  type BootstrappedNodePlatform,
} from './bootstrap.ts';
import { createLocalApp } from './local-app.ts';
import { applyMigrations } from './migrate.ts';
import { listenNodeServer } from './node-listener.ts';
import { installPersonalLogging } from './personal-logging.ts';
import {
  loadPersonalRuntime,
  resolvePersonalRuntimePaths,
  type PersonalRuntime,
} from './personal-runtime.ts';
import { initializePersonalStorage } from './personal-storage.ts';
import { selectNodeRuntimeProfile } from './runtime-profile.ts';
import { startScheduledMaintenance } from './scheduled-maintenance.ts';
import { startNodeRuntime } from './start-runtime.ts';
import { createNodeStoredSecretCodec } from './stored-secrets.ts';
import {
  LEGACY_PLAINTEXT_SCHEMA_MIGRATION,
  app,
  assertRuntimeProfileData,
  initBackgroundSchedulerResolver,
  initRepo,
  initOpenAIResponsesWebSocketUpgradeResolver,
  SqlRepo,
  validateStoredSecrets,
} from '@floway-dev/gateway';
import type { RuntimeProfileMode } from '@floway-dev/platform';

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

export interface NodeEntryInfo {
  readonly port: number;
}

interface NodeServeOptions {
  readonly displayEndpoint: string;
  readonly hostname?: string;
  readonly port: number;
}

type NodeServe = (options: NodeServeOptions) => Promise<NodeEntryInfo>;

export interface NodeEntryOverrides {
  readonly args?: readonly string[];
  readonly assertRuntimeProfileData?: (repo: SqlRepo) => Promise<void>;
  readonly bootstrapNodePlatform?: typeof bootstrapNodePlatform;
  readonly createLocalApp?: typeof createLocalApp;
  readonly createNodeStoredSecretCodec?: typeof createNodeStoredSecretCodec;
  readonly initializePersonalStorage?: typeof initializePersonalStorage;
  readonly loadPersonalRuntime?: typeof loadPersonalRuntime;
  readonly resolvePersonalRuntimePaths?: typeof resolvePersonalRuntimePaths;
  readonly serve?: NodeServe;
  readonly start?: () => Promise<NodeEntryInfo>;
}

const prepareNodePlatform = async (
  bootstrapped: BootstrappedNodePlatform,
  profile: RuntimeProfileMode,
  overrides: NodeEntryOverrides,
  personalDatabasePath?: string,
): Promise<void> => {
  const { db, deviceMasterKeyCreationLock, personalStorage } = bootstrapped;
  const hasExistingMigrationState = profile === 'personal'
    && await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .first<{ name: string }>() !== null;
  const createStoredSecrets = overrides.createNodeStoredSecretCodec ?? createNodeStoredSecretCodec;
  let storedSecrets;
  if (hasExistingMigrationState) {
    await applyMigrations(db, undefined, undefined, { through: LEGACY_PLAINTEXT_SCHEMA_MIGRATION });
    storedSecrets = await createStoredSecrets(
      'personal',
      db,
      deviceMasterKeyCreationLock,
      undefined,
      { validate: false },
    );
    await applyMigrations(db, undefined, storedSecrets);
    await validateStoredSecrets(db, storedSecrets);
  } else {
    await applyMigrations(db);
    storedSecrets = await createStoredSecrets(profile, db, deviceMasterKeyCreationLock);
  }
  if (personalDatabasePath !== undefined) personalStorage?.hardenSqliteFiles(personalDatabasePath);
  const repo = new SqlRepo(db, { storedSecrets });
  initRepo(repo);
  if (overrides.assertRuntimeProfileData === undefined) await assertRuntimeProfileData();
  else await overrides.assertRuntimeProfileData(repo);
};

const startNodeListener = async (
  profile: RuntimeProfileMode,
  personalRuntime: PersonalRuntime | null,
  port: number,
  overrides: NodeEntryOverrides,
): Promise<NodeEntryInfo> => {
  const localApp = (overrides.createLocalApp ?? createLocalApp)({
    gatewayFetch: app.fetch,
    staticRoot: fileURLToPath(new URL('../../web/dist/client', import.meta.url)),
  });
  const serve = overrides.serve ?? (async (options: NodeServeOptions): Promise<NodeEntryInfo> => {
    const server = createAdaptorServer({
      fetch: localApp.fetch,
      websocket: { server: new WebSocketServer({ noServer: true }) },
    });
    return await listenNodeServer(server, {
      ...options,
      serviceName: 'Floway',
    });
  });
  return await serve({
    displayEndpoint: personalRuntime?.endpoint ?? `http://localhost:${port}`,
    ...(profile === 'personal' ? { hostname: '127.0.0.1' } : {}),
    port,
  });
};

export const runNodeEntry = async (overrides: NodeEntryOverrides = {}): Promise<NodeEntryInfo> => {
  const args = overrides.args ?? process.argv.slice(2);
  const profile = args.length === 0
    ? resolveNodeRuntimeProfile(process.env.FLOWAY_PROFILE)
    : selectNodeRuntimeProfile(args);
  const resolvePersonalPaths = overrides.resolvePersonalRuntimePaths ?? resolvePersonalRuntimePaths;
  const personal = profile === 'personal'
    ? (() => {
        const paths = resolvePersonalPaths();
        const storage = (overrides.initializePersonalStorage ?? initializePersonalStorage)(paths);
        return { paths, storage };
      })()
    : null;
  if (personal !== null) {
    installPersonalLogging(personal.paths.logsDir, { permissions: personal.storage });
  }
  const startupWarnings: string[] = [];
  const personalRuntime = personal === null
    ? null
    : (overrides.loadPersonalRuntime ?? loadPersonalRuntime)({
        paths: personal.paths,
        permissions: personal.storage,
        warn: warning => startupWarnings.push(warning),
      });
  for (const warning of startupWarnings) console.warn(warning);
  const port = personalRuntime?.port ?? Number(process.env.PORT ?? '8788');

  // Passwordless admin login is a dev-only shortcut. Refuse production Node
  // startup without ADMIN_KEY so misconfiguration surfaces before listening.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
    console.error('FATAL: NODE_ENV=production requires ADMIN_KEY. Passwordless admin login is only allowed on dev instances.');
    process.exit(1);
  }

  const start = overrides.start ?? (async () => await startNodeRuntime({
    bootstrap: () => (overrides.bootstrapNodePlatform ?? bootstrapNodePlatform)(
      personal === null
        ? { profile: 'server' }
        : {
            profile: 'personal',
            storage: personal.paths,
            personalStorage: personal.storage,
          },
    ),
    migrate: async bootstrapped => await prepareNodePlatform(
      bootstrapped,
      profile,
      overrides,
      personal?.paths.databasePath,
    ),
    listen: async () => {
      const info = await startNodeListener(profile, personalRuntime, port, overrides);
      startScheduledMaintenance();
      return info;
    },
  }));
  const info = await start();
  console.log(`Floway listening on ${personalRuntime?.endpoint ?? `http://localhost:${info.port}`}`);
  return info;
};
