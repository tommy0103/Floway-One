import { decodeUpstreamConfig, decodeUpstreamState } from './upstream-codecs.ts';
import { WEB_SEARCH_PROVIDER_NAMES, type WebSearchConfig, type WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { StoredSecretContext } from '@floway-dev/platform';
import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { azureUpstreamConfigForSafeExport } from '@floway-dev/provider-azure';
import { claudeCodeUpstreamConfigForSafeExport, claudeCodeUpstreamStateForSafeExport } from '@floway-dev/provider-claude-code';
import { codexUpstreamConfigForSafeExport, codexUpstreamStateForSafeExport } from '@floway-dev/provider-codex';
import { copilotUpstreamConfigForSafeExport, copilotUpstreamStateForSafeExport } from '@floway-dev/provider-copilot';
import { customUpstreamConfigForSafeExport } from '@floway-dev/provider-custom';
import { ollamaUpstreamConfigForSafeExport, ollamaUpstreamStateForSafeExport } from '@floway-dev/provider-ollama';

export interface StoredSecretSqlLocation {
  readonly table: string;
  readonly identityColumn: string;
  readonly column: string;
}

export interface ProtectedStoredSecretField {
  readonly id: string;
  readonly location: StoredSecretSqlLocation;
  readonly nullable: boolean;
  readonly plaintextEmpty: boolean;
  contextFor(identity: string | number): StoredSecretContext;
  safeExportValue(value: unknown, owner?: UpstreamRecord): unknown;
  validatePlaintext?(plaintext: string, identity: string | number): void;
}

const requireUpstreamOwner = (owner: UpstreamRecord | undefined): UpstreamRecord => {
  if (owner === undefined) throw new Error('Safe export of an upstream stored secret requires its owning upstream');
  return owner;
};

type UpstreamSafeExportProjection = { config: unknown; state: unknown };
type UpstreamSafeExportProjector = (record: UpstreamRecord) => UpstreamSafeExportProjection;

const UPSTREAM_SAFE_EXPORT_PROJECTORS = Object.freeze({
  azure: record => ({ config: azureUpstreamConfigForSafeExport(record), state: null }),
  'claude-code': record => ({
    config: claudeCodeUpstreamConfigForSafeExport(record),
    state: claudeCodeUpstreamStateForSafeExport(record.state),
  }),
  codex: record => ({
    config: codexUpstreamConfigForSafeExport(record),
    state: codexUpstreamStateForSafeExport(record.state),
  }),
  copilot: record => ({
    config: copilotUpstreamConfigForSafeExport(record),
    state: copilotUpstreamStateForSafeExport(record.state),
  }),
  custom: record => ({ config: customUpstreamConfigForSafeExport(record), state: null }),
  ollama: record => ({
    config: ollamaUpstreamConfigForSafeExport(record),
    state: ollamaUpstreamStateForSafeExport(record.state),
  }),
} satisfies Record<UpstreamProviderKind, UpstreamSafeExportProjector>);

const upstreamSafeExportProjection = (record: UpstreamRecord): UpstreamSafeExportProjection =>
  UPSTREAM_SAFE_EXPORT_PROJECTORS[record.kind](record);

export const upstreamConfigSecretContext = (id: string): StoredSecretContext =>
  `upstream:${id}:config` as StoredSecretContext;

export const upstreamStateSecretContext = (id: string): StoredSecretContext =>
  `upstream:${id}:state` as StoredSecretContext;

export const UPSTREAM_CONFIG_STORED_SECRET_FIELD = Object.freeze({
  id: 'upstream-config',
  location: Object.freeze({ table: 'upstreams', identityColumn: 'id', column: 'config_json' }),
  nullable: false,
  plaintextEmpty: false,
  contextFor: (identity: string | number) => upstreamConfigSecretContext(String(identity)),
  safeExportValue: (_value: unknown, owner?: UpstreamRecord) => upstreamSafeExportProjection(requireUpstreamOwner(owner)).config,
  validatePlaintext: (plaintext: string, identity: string | number) => {
    decodeUpstreamConfig(plaintext, String(identity));
  },
} satisfies ProtectedStoredSecretField);

export const UPSTREAM_STATE_STORED_SECRET_FIELD = Object.freeze({
  id: 'upstream-state',
  location: Object.freeze({ table: 'upstreams', identityColumn: 'id', column: 'state_json' }),
  nullable: true,
  plaintextEmpty: false,
  contextFor: (identity: string | number) => upstreamStateSecretContext(String(identity)),
  safeExportValue: (_value: unknown, owner?: UpstreamRecord) => upstreamSafeExportProjection(requireUpstreamOwner(owner)).state,
  validatePlaintext: (plaintext: string, identity: string | number) => {
    decodeUpstreamState(plaintext, String(identity));
  },
} satisfies ProtectedStoredSecretField);

type WebSearchSecretConfigKey = 'jina' | 'microsoftWebIq' | 'tavily';
type WebSearchSecretColumn =
  | 'protected_jina_api_key'
  | 'protected_microsoft_web_iq_api_key'
  | 'protected_tavily_api_key';

const webSearchApiKeySecretContext = (provider: WebSearchProviderName): StoredSecretContext =>
  `web-search:${provider}:api-key` as StoredSecretContext;

const WEB_SEARCH_STORED_SECRET_FIELD_BY_PROVIDER = {
  tavily: { column: 'protected_tavily_api_key', configKey: 'tavily' },
  'microsoft-web-iq': { column: 'protected_microsoft_web_iq_api_key', configKey: 'microsoftWebIq' },
  jina: { column: 'protected_jina_api_key', configKey: 'jina' },
} as const satisfies Record<WebSearchProviderName, {
  readonly column: WebSearchSecretColumn;
  readonly configKey: WebSearchSecretConfigKey;
}>;

export interface WebSearchStoredSecretField extends ProtectedStoredSecretField {
  readonly provider: WebSearchProviderName;
  readonly column: WebSearchSecretColumn;
  readonly configKey: keyof Pick<WebSearchConfig, WebSearchSecretConfigKey>;
  readonly context: StoredSecretContext;
}

export const WEB_SEARCH_STORED_SECRET_FIELDS = Object.freeze(WEB_SEARCH_PROVIDER_NAMES.map(provider => {
  const { column, configKey } = WEB_SEARCH_STORED_SECRET_FIELD_BY_PROVIDER[provider];
  const context = webSearchApiKeySecretContext(provider);
  return Object.freeze({
    id: `web-search-${provider}`,
    provider,
    column,
    configKey,
    context,
    location: Object.freeze({ table: 'search_config', identityColumn: 'id', column }),
    nullable: false,
    plaintextEmpty: true,
    contextFor: () => context,
    safeExportValue: (value: unknown) => ({ configured: typeof value === 'string' && value !== '' }),
  } satisfies WebSearchStoredSecretField);
}));

export const PROTECTED_STORED_SECRET_FIELDS: readonly ProtectedStoredSecretField[] = Object.freeze([
  UPSTREAM_CONFIG_STORED_SECRET_FIELD,
  UPSTREAM_STATE_STORED_SECRET_FIELD,
  ...WEB_SEARCH_STORED_SECRET_FIELDS,
]);

export const upstreamStoredSecretsForSafeExport = (record: UpstreamRecord): UpstreamSafeExportProjection =>
  upstreamSafeExportProjection(record);

export const webSearchStoredSecretsForSafeExport = (config: WebSearchConfig): Record<WebSearchProviderName, unknown> =>
  Object.fromEntries(WEB_SEARCH_STORED_SECRET_FIELDS.map(field => [
    field.provider,
    field.safeExportValue(config[field.configKey].apiKey),
  ])) as Record<WebSearchProviderName, unknown>;
