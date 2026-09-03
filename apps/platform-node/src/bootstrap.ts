import { createDeviceMasterKeyCreationLock, type DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { EventTargetChannelBroker } from './event-target-channel-broker.ts';
import { createNodeExternalResourceFetcher } from './external-resource-fetcher.ts';
import { nodeFetch } from './fetch.ts';
import { FsFileStore } from './fs-file-store.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import type { PersonalRuntimePaths } from './personal-runtime.ts';
import { PersonalStorageHardener } from './personal-storage.ts';
import { nodeRuntimeRootCAs } from './runtime-root-cas.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCacheStore } from './sqlite-image-cache-store.ts';
import { timingSafeEqual } from './timing-safe-equal.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump-codec';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  getEnvOptional,
  IMAGE_CACHE_POLICY,
  initEnv,
  initExternalResourceFetcher,
  initFetch,
  initFileStore,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initRuntimeProfile,
  initSocketDial,
  initTimingSafeEqual,
  type RuntimeProfileMode,
  type SqlDatabase,
} from '@floway-dev/platform';

interface NodeStoragePaths {
  readonly databasePath: string;
  readonly filesDir: string;
}

export type BootstrapNodePlatformOptions =
  | {
    readonly personalStorage?: PersonalStorageHardener;
    readonly profile: 'personal';
    readonly storage: PersonalRuntimePaths;
  }
  | { readonly profile: 'server'; readonly storage?: NodeStoragePaths };

export interface BootstrapNodePlatformDependencies {
  readonly createDeviceMasterKeyCreationLock?: typeof createDeviceMasterKeyCreationLock;
}

export interface BootstrappedNodePlatform {
  readonly db: SqlDatabase;
  readonly deviceMasterKeyCreationLock?: DeviceMasterKeyCreationLock;
  readonly personalStorage?: PersonalStorageHardener;
}
export const resolveNodeRuntimeProfile = (value: string | undefined): RuntimeProfileMode => {
  const profile = value ?? 'server';
  if (profile === 'personal' || profile === 'server') return profile;
  throw new Error(`Unsupported FLOWAY_PROFILE: ${JSON.stringify(profile)}`);
};

export const bootstrapNodePlatform = (
  options: BootstrapNodePlatformOptions,
  dependencies: BootstrapNodePlatformDependencies = {},
): BootstrappedNodePlatform => {
  const { profile } = options;
  initEnv(name => process.env[name]);
  initRuntimeKind('node');
  initRuntimeProfile(options.profile);
  initTimingSafeEqual(timingSafeEqual);
  initExternalResourceFetcher(createNodeExternalResourceFetcher());
  initFetch(nodeFetch);

  const filesDir = options.storage?.filesDir ?? getEnvOptional('FLOWAY_FILES_DIR', './data/files');
  const dbPath = options.storage?.databasePath ?? getEnvOptional('FLOWAY_DB_PATH', './data/floway.db');
  const personalStorage = profile === 'personal'
    ? (options.personalStorage ?? new PersonalStorageHardener(options.storage))
    : undefined;
  personalStorage?.initialize();

  const files = new FsFileStore(filesDir, personalStorage);
  initFileStore(files);
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(dbPath, { permissions: personalStorage });
  initImageCacheStore(new SqliteImageCacheStore(db, IMAGE_CACHE_POLICY));
  initImageProcessor(createSharpImageProcessor());
  initDumpStore(new FileDumpStore(db, files));
  initDumpBroker(new EventTargetChannelBroker<DumpMetadata>(dumpCodec));
  const deviceMasterKeyCreationLock = profile === 'personal'
    ? (dependencies.createDeviceMasterKeyCreationLock ?? createDeviceMasterKeyCreationLock)()
    : undefined;
  return { db, deviceMasterKeyCreationLock, personalStorage };
};
