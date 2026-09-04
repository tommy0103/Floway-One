// Data transfer routes — export/import operator-managed database data as JSON.
//
// Ephemeral stored OpenAI Responses state is omitted from exports and cleared on
// replace imports; clients can regenerate it through normal OpenAI Responses use.
//
// Legacy server exports contain every persisted authentication value. Personal
// mode disables that plaintext path: full recovery data is password-encrypted,
// while the safe export structurally omits every credential-bearing field.

import { BackupArchiveAuthenticationError, createEncryptedBackupArchive, InvalidBackupArchiveError, openEncryptedBackupArchive } from './backup-archive.ts';
import { parseImportData, type SerializedProxy } from './import-schema.ts';
import { parseWebSearchConfigDefault, parseWebSearchConfigStrict } from '../../data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { notifyDisabledBestEffort } from '../../dump/registry.ts';
import { ClientSafeBadRequestError } from '../../middleware/client-safe-error.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_FALLBACK_IDS } from '../../repo/proxy-fallback-list.ts';
import { upstreamStoredSecretsForSafeExport, webSearchStoredSecretsForSafeExport } from '../../repo/stored-secret-fields.ts';
import type { ApiKey, ModelAliasRecord, PerformanceTelemetryRecord, UsageRecord, User, WebSearchUsageRecord } from '../../repo/types.ts';
import { assertRuntimeProfileData, isPersonalRuntimeProfile, runtimeProfileDataError } from '../../runtime/profile-policy.ts';
import { type exportQuery, type fullBackupBody, type importBody } from '../schemas.ts';
import { reportModelsCacheWarmFailure, warmModelsCache } from '../shared/warm-models-cache.ts';
import { type FullSerializedUpstreamRecord, upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

interface ExportPayload {
  version: 20;
  exportedAt: string;
  data: {
    users: User[];
    apiKeys: ApiKey[];
    upstreams: FullSerializedUpstreamRecord[];
    modelAliases: ModelAliasRecord[];
    proxies: SerializedProxy[];
    usage: UsageRecord[];
    searchUsage: WebSearchUsageRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded: boolean;
    searchConfig: WebSearchConfig;
  };
}

const EXPORT_VERSION = 20;

interface CollectedExport {
  payload: ExportPayload;
  upstreams: UpstreamRecord[];
}

const collectExportPayload = async (includePerformance: boolean): Promise<CollectedExport> => {
  const repo = getRepo();
  const [users, apiKeys, usage, webSearchUsage, performance, rawWebSearchConfig, upstreams, modelAliases, proxies] = await Promise.all([
    repo.users.listIncludingDeleted(),
    repo.apiKeys.listIncludingDeleted(),
    repo.usage.listAll(),
    repo.webSearchUsage.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.webSearchConfig.get(),
    repo.upstreams.list(),
    repo.modelAliases.list(),
    repo.proxies.list(),
  ]);

  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      users,
      apiKeys,
      upstreams: upstreams.map(upstreamRecordToFullJson),
      modelAliases,
      proxies: proxies.map(proxy => ({ id: proxy.id, name: proxy.name, url: proxy.url, dial_timeout_seconds: proxy.dialTimeoutSeconds })),
      usage,
      searchUsage: webSearchUsage,
      performanceIncluded: includePerformance,
      searchConfig: rawWebSearchConfig === null ? parseWebSearchConfigDefault() : parseWebSearchConfigStrict(rawWebSearchConfig),
    },
  };
  if (includePerformance) payload.data.performance = performance;
  return { payload, upstreams };
};

const safeExport = ({ payload, upstreams: sourceUpstreams }: CollectedExport) => {
  const users = payload.data.users.map(user => ({
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    upstreamIds: user.upstreamIds === null ? null : [...user.upstreamIds],
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
  }));
  const apiKeys = payload.data.apiKeys.map(apiKey => ({
    id: apiKey.id,
    userId: apiKey.userId,
    name: apiKey.name,
    createdAt: apiKey.createdAt,
    ...(apiKey.lastUsedAt === undefined ? {} : { lastUsedAt: apiKey.lastUsedAt }),
    upstreamIds: apiKey.upstreamIds === null ? null : [...apiKey.upstreamIds],
    deletedAt: apiKey.deletedAt,
    dumpRetentionSeconds: apiKey.dumpRetentionSeconds,
    openaiResponsesRetentionSeconds: apiKey.openaiResponsesRetentionSeconds,
  }));
  const upstreams = sourceUpstreams.map((source, index) => {
    const serialized = payload.data.upstreams[index];
    const storedSecrets = upstreamStoredSecretsForSafeExport(source);
    return {
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      sort_order: source.sortOrder,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      flag_overrides: Object.fromEntries(Object.entries(source.flagOverrides)),
      flag_defaults: Object.fromEntries(Object.entries(serialized.flag_defaults)),
      disabled_public_model_ids: [...source.disabledPublicModelIds],
      proxy_fallback_list: source.proxyFallbackList.map(entry => entry.colos === undefined
        ? { id: entry.id }
        : { id: entry.id, colos: [...entry.colos] }),
      model_prefix: source.modelPrefix === null
        ? null
        : {
            prefix: source.modelPrefix.prefix,
            addressable: [...source.modelPrefix.addressable],
            listed: [...source.modelPrefix.listed],
          },
      hue: source.hue,
      kind: source.kind,
      config: storedSecrets.config,
      state: storedSecrets.state,
    };
  });
  const proxies = payload.data.proxies.map(proxy => ({
    id: proxy.id,
    name: proxy.name,
    dial_timeout_seconds: proxy.dial_timeout_seconds,
  }));
  const { provider, passthroughOpenAiSearch } = payload.data.searchConfig;
  return {
    format: 'floway-safe-export' as const,
    version: 1 as const,
    exportedAt: payload.exportedAt,
    data: {
      users,
      apiKeys,
      upstreams,
      modelAliases: payload.data.modelAliases,
      proxies,
      usage: payload.data.usage,
      searchUsage: payload.data.searchUsage,
      ...(payload.data.performance === undefined ? {} : { performance: payload.data.performance }),
      performanceIncluded: payload.data.performanceIncluded,
      searchConfig: {
        provider,
        credentials: webSearchStoredSecretsForSafeExport(payload.data.searchConfig),
        passthroughOpenAiSearch: {
          enabled: passthroughOpenAiSearch.enabled,
          upstreamId: passthroughOpenAiSearch.upstreamId,
          model: passthroughOpenAiSearch.model,
        },
      },
    },
  };
};

const validateApiKeyIdentities = (records: readonly ApiKey[], existing: readonly ApiKey[], mode: 'merge' | 'replace'): string | null => {
  const ids = new Map<string, number>();
  const rawKeys = new Map<string, string>();
  const serverSecrets = new Map<string, string>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const existingIdIndex = ids.get(record.id);
    if (existingIdIndex !== undefined) return `duplicate apiKeys id ${record.id} at indexes ${existingIdIndex} and ${i}`;
    ids.set(record.id, i);

    const existingRawKeyId = rawKeys.get(record.key);
    if (existingRawKeyId !== undefined) return `duplicate apiKeys raw key used by ${existingRawKeyId} and ${record.id}`;
    rawKeys.set(record.key, record.id);

    const existingServerSecretId = serverSecrets.get(record.serverSecret);
    if (existingServerSecretId !== undefined) return `duplicate apiKeys server secret used by ${existingServerSecretId} and ${record.id}`;
    serverSecrets.set(record.serverSecret, record.id);
  }

  if (mode === 'merge') {
    const existingRawKeys = new Map(existing.map(record => [record.key, record.id]));
    const existingServerSecrets = new Map(existing.map(record => [record.serverSecret, record.id]));
    for (const record of records) {
      const existingId = existingRawKeys.get(record.key);
      if (existingId !== undefined && existingId !== record.id) {
        return `apiKeys raw key for ${record.id} conflicts with existing api key ${existingId}`;
      }
      const existingServerSecretId = existingServerSecrets.get(record.serverSecret);
      if (existingServerSecretId !== undefined && existingServerSecretId !== record.id) {
        return `apiKeys server secret for ${record.id} conflicts with existing api key ${existingServerSecretId}`;
      }
    }
  }

  return null;
};

// Every fallback must resolve in the post-import catalog. Merge mode may refer
// to an existing local proxy; replace mode may only refer to imported proxies
// and the built-in direct transports because it clears the proxy repository.
const validateProxyFallbackReferences = (
  upstreams: readonly UpstreamRecord[],
  proxies: readonly SerializedProxy[],
  existingProxyIds: readonly string[],
): string | null => {
  const knownIds = new Set<string>(proxies.map(proxy => proxy.id));
  for (const id of existingProxyIds) knownIds.add(id);
  for (const id of DIRECT_FALLBACK_IDS) knownIds.add(id);
  for (const upstream of upstreams) {
    for (const ref of upstream.proxyFallbackList) {
      if (!knownIds.has(ref.id)) return `upstream ${upstream.id} references unknown proxy ${ref.id}`;
    }
  }
  return null;
};

const validateModelAliasIdentities = (
  records: readonly ModelAliasRecord[],
  existing: readonly ModelAliasRecord[],
  mode: 'merge' | 'replace',
): string | null => {
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const priorId = ids.get(record.id);
    if (priorId !== undefined) return `duplicate id ${record.id} at indexes ${priorId} and ${index}`;
    ids.set(record.id, index);
    const priorName = names.get(record.name);
    if (priorName !== undefined) return `duplicate name ${record.name} at indexes ${priorName} and ${index}`;
    names.set(record.name, index);
  }

  if (mode === 'merge') {
    const existingByName = new Map(existing.map(record => [record.name, record.id]));
    for (const record of records) {
      const existingId = existingByName.get(record.name);
      if (existingId !== undefined && existingId !== record.id) {
        return `name ${record.name} conflicts with existing alias ${existingId}`;
      }
    }
  }
  return null;
};

export const exportData = async (c: CtxWithQuery<typeof exportQuery>) => {
  const query = c.req.valid('query');
  if (isPersonalRuntimeProfile() && query.kind !== 'safe') {
    return c.json({ error: 'Personal profile exports must be either a password-protected full backup or a safe export.' }, 400);
  }
  const collected = await collectExportPayload(query.include_performance === '1');
  return c.json(query.kind === 'safe' ? safeExport(collected) : collected.payload);
};

export const createFullBackup = async (c: CtxWithJson<typeof fullBackupBody>) => {
  const { password, includePerformance = false } = c.req.valid('json');
  const { payload } = await collectExportPayload(includePerformance);
  return c.json(await createEncryptedBackupArchive(payload, password));
};

export const importData = async (c: CtxWithJson<typeof importBody>) => {
  const request = c.req.valid('json');
  const { mode } = request;
  let rawData: unknown;
  if (request.archive !== undefined) {
    let opened: unknown;
    try {
      opened = await openEncryptedBackupArchive(request.archive, request.password ?? '');
    } catch (cause) {
      if (cause instanceof BackupArchiveAuthenticationError || cause instanceof InvalidBackupArchiveError) {
        throw new ClientSafeBadRequestError(
          'Encrypted Floway backup restore was rejected',
          'The backup could not be authenticated or validated.',
          cause,
        );
      }
      throw cause;
    }
    if (typeof opened !== 'object' || opened === null || !('version' in opened) || opened.version !== EXPORT_VERSION || !('data' in opened)) {
      return c.json({ error: 'The encrypted backup payload is not a current Floway full backup.' }, 400);
    }
    rawData = opened.data;
  } else {
    if (isPersonalRuntimeProfile()) {
      return c.json({ error: 'Personal profile restore requires a password-protected full backup.' }, 400);
    }
    rawData = request.data;
  }
  const parsed = parseImportData(rawData);
  if (parsed.type === 'invalid') return c.json({ error: parsed.error }, 400);
  const { users, apiKeys, upstreams, modelAliases, proxies, usage, searchUsage, performance, performanceIncluded, searchConfig } = parsed.data;

  const profileError = runtimeProfileDataError(users, apiKeys);
  if (profileError) return c.json({ error: `invalid personal profile data: ${profileError}` }, 400);
  const preservePersonalOwner = mode === 'replace' && isPersonalRuntimeProfile();

  const repo = getRepo();
  // Merge mode needs each key's prior dump policy to identify transitions that
  // must disconnect live subscribers after the replacement row is stored.
  const preImportKeys = await repo.apiKeys.listIncludingDeleted();
  const apiKeyIdentityError = validateApiKeyIdentities(apiKeys, mode === 'merge' ? preImportKeys : [], mode);
  if (apiKeyIdentityError) return c.json({ error: `invalid apiKeys: ${apiKeyIdentityError}` }, 400);
  const preImportRetentionById = new Map<string, number | null>(preImportKeys.map(key => [key.id, key.dumpRetentionSeconds]));

  const existingProxyIdsForRefs = mode === 'merge' ? (await repo.proxies.list()).map(proxy => proxy.id) : [];
  const fallbackRefError = validateProxyFallbackReferences(upstreams, proxies, existingProxyIdsForRefs);
  if (fallbackRefError) return c.json({ error: `invalid upstreams: ${fallbackRefError}` }, 400);
  if (modelAliases !== undefined) {
    const existingAliases = mode === 'merge' ? await repo.modelAliases.list() : [];
    const aliasIdentityError = validateModelAliasIdentities(modelAliases, existingAliases, mode);
    if (aliasIdentityError) return c.json({ error: `invalid modelAliases: ${aliasIdentityError}` }, 400);
  }

  const applyImport = async (): Promise<void> => {
    if (mode === 'replace') {
      // D1 does not expose a transaction spanning these repositories. Complete
      // validation therefore happens before this delete wave. Personal Node
      // restore additionally executes the whole wave and every replacement
      // write inside the runtime's SQLite transaction boundary.
      const deletes: Promise<unknown>[] = [
        repo.sessions.deleteAll(),
        repo.apiKeys.deleteAll(),
        repo.usage.deleteAll(),
        repo.webSearchUsage.deleteAll(),
        repo.upstreams.deleteAll(),
        repo.proxies.deleteAll(),
        repo.proxyBackoffs.deleteAll(),
        repo.openaiResponsesSnapshots.deleteAll(),
        repo.openaiResponsesItems.deleteAll(),
      ];
      if (modelAliases !== undefined) deletes.push(repo.modelAliases.deleteAll());
      if (!preservePersonalOwner) deletes.push(repo.users.deleteAll());
      if (performanceIncluded) deletes.push(repo.performance.deleteAll());
      await Promise.all(deletes);
    }

    // Users precede their API keys, and proxies precede upstream fallback refs.
    for (const user of users) {
      if (preservePersonalOwner) await repo.users.upsertForImport(user);
      else await repo.users.save(user);
    }
    for (const proxy of proxies) {
      await repo.proxies.save({
        id: proxy.id,
        name: proxy.name,
        url: proxy.url,
        dialTimeoutSeconds: proxy.dial_timeout_seconds,
      });
    }
    for (const key of apiKeys) await repo.apiKeys.save(key);
    for (const record of usage) await repo.usage.set(record);
    for (const record of searchUsage) await repo.webSearchUsage.set(record);
    for (const upstream of upstreams) await repo.upstreams.save(upstream);
    for (const alias of modelAliases ?? []) {
      if (await repo.modelAliases.getById(alias.id)) await repo.modelAliases.update(alias);
      else await repo.modelAliases.insert(alias);
    }
    for (const record of performance) await repo.performance.set(record);
    await repo.webSearchConfig.save(searchConfig);
    await assertRuntimeProfileData();
  };

  if (isPersonalRuntimeProfile()) {
    if (!repo.transaction) throw new Error('Personal profile restore requires an atomic storage transaction');
    await repo.transaction(applyImport);
  } else {
    await applyImport();
  }

  if (mode === 'replace') {
    for (const key of preImportKeys) await notifyDisabledBestEffort(key.id, 'replace-mode import');
  } else {
    for (const key of apiKeys) {
      const previous = preImportRetentionById.get(key.id) ?? null;
      if (key.dumpRetentionSeconds === null && previous !== null) {
        await notifyDisabledBestEffort(key.id, 'merge-mode retention disable');
      }
    }
  }
  const warmResults = await Promise.allSettled(upstreams.map(upstream => warmModelsCache(upstream, c)));
  for (let index = 0; index < warmResults.length; index++) {
    const result = warmResults[index];
    if (result.status === 'rejected') {
      reportModelsCacheWarmFailure(upstreams[index], 'post-import warm', result.reason);
    }
  }

  return c.json({
    ok: true,
    imported: {
      users: users.length,
      apiKeys: apiKeys.length,
      upstreams: upstreams.length,
      proxies: proxies.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      performance: performance.length,
    },
  });
};
