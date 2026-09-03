import { WEB_SEARCH_PROVIDER_NAMES, type WebSearchConfig, type WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { StoredSecretContext } from '@floway-dev/platform';

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
}

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
} satisfies ProtectedStoredSecretField);

export const UPSTREAM_STATE_STORED_SECRET_FIELD = Object.freeze({
  id: 'upstream-state',
  location: Object.freeze({ table: 'upstreams', identityColumn: 'id', column: 'state_json' }),
  nullable: true,
  plaintextEmpty: false,
  contextFor: (identity: string | number) => upstreamStateSecretContext(String(identity)),
} satisfies ProtectedStoredSecretField);

type WebSearchSecretConfigKey = 'jina' | 'microsoftWebIq' | 'tavily';
type WebSearchSecretColumn = 'jina_api_key' | 'microsoft_web_iq_api_key' | 'tavily_api_key';

const webSearchApiKeySecretContext = (provider: WebSearchProviderName): StoredSecretContext =>
  `web-search:${provider}:api-key` as StoredSecretContext;

const WEB_SEARCH_STORED_SECRET_FIELD_BY_PROVIDER = {
  tavily: { column: 'tavily_api_key', configKey: 'tavily' },
  'microsoft-web-iq': { column: 'microsoft_web_iq_api_key', configKey: 'microsoftWebIq' },
  jina: { column: 'jina_api_key', configKey: 'jina' },
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
  } satisfies WebSearchStoredSecretField);
}));

export const PROTECTED_STORED_SECRET_FIELDS: readonly ProtectedStoredSecretField[] = Object.freeze([
  UPSTREAM_CONFIG_STORED_SECRET_FIELD,
  UPSTREAM_STATE_STORED_SECRET_FIELD,
  ...WEB_SEARCH_STORED_SECRET_FIELDS,
]);
