import type { UpstreamModelConfig } from './model-config.ts';
import { BILLING_METRICS, type ModelEndpointKey, type ModelEndpoints, type PricingCoordinateValue } from '@floway-dev/protocols/common';

const SAFE_EXPORT_ENDPOINT_KEYS = [
  'openaiCompletions',
  'openaiChatCompletions',
  'openaiResponses',
  'anthropicMessages',
  'openaiEmbeddings',
  'openaiImagesGenerations',
  'openaiImagesEdits',
  'rerank',
  'openaiAudioTranscriptions',
] as const satisfies readonly ModelEndpointKey[];

export const routingUrlForSafeExport = (value: string): string => {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
};

export const modelEndpointsForSafeExport = (source: ModelEndpoints): ModelEndpoints => {
  const endpoints: ModelEndpoints = {};
  for (const key of SAFE_EXPORT_ENDPOINT_KEYS) {
    if (source[key] !== undefined) endpoints[key] = {};
  }
  return endpoints;
};

const pricingCoordinateForSafeExport = (value: PricingCoordinateValue): PricingCoordinateValue =>
  typeof value === 'string' ? value : { operator: value.operator, value: value.value };

const modelPricingForSafeExport = (model: UpstreamModelConfig): unknown => model.pricing === undefined
  ? undefined
  : {
      entries: model.pricing.entries.map(entry => ({
        ...(entry.selector === undefined
          ? {}
          : {
              selector: Object.fromEntries(Object.entries(entry.selector).map(([key, value]) => [
                key,
                pricingCoordinateForSafeExport(value),
              ])),
            }),
        rates: Object.fromEntries(BILLING_METRICS.flatMap(metric => {
          const rate = entry.rates[metric];
          return rate === undefined ? [] : [[metric, rate]];
        })),
      })),
    };

const modelChatForSafeExport = (model: UpstreamModelConfig): unknown => {
  const chat = model.chat;
  if (chat === undefined) return undefined;
  const reasoning = chat.reasoning;
  return {
    ...(chat.modalities === undefined
      ? {}
      : {
          modalities: {
            input: [...chat.modalities.input],
            output: [...chat.modalities.output],
          },
        }),
    ...(reasoning === undefined
      ? {}
      : {
          reasoning: {
            ...(reasoning.effort === undefined
              ? {}
              : {
                  effort: {
                    supported: [...reasoning.effort.supported],
                    default: reasoning.effort.default,
                  },
                }),
            ...(reasoning.budget_tokens === undefined
              ? {}
              : {
                  budget_tokens: {
                    ...(reasoning.budget_tokens.min === undefined ? {} : { min: reasoning.budget_tokens.min }),
                    ...(reasoning.budget_tokens.max === undefined ? {} : { max: reasoning.budget_tokens.max }),
                  },
                }),
            ...(reasoning.adaptive === undefined ? {} : { adaptive: reasoning.adaptive }),
            ...(reasoning.mandatory === undefined ? {} : { mandatory: reasoning.mandatory }),
          },
        }),
  };
};

export const upstreamModelsForSafeExport = (models: readonly UpstreamModelConfig[]): unknown[] =>
  models.map(model => {
    const pricing = modelPricingForSafeExport(model);
    const chat = modelChatForSafeExport(model);
    return {
      kind: model.kind,
      endpoints: modelEndpointsForSafeExport(model.endpoints),
      ...(model.display_name === undefined ? {} : { display_name: model.display_name }),
      ...(model.limits === undefined
        ? {}
        : {
            limits: {
              ...(model.limits.max_output_tokens === undefined ? {} : { max_output_tokens: model.limits.max_output_tokens }),
              ...(model.limits.max_context_window_tokens === undefined ? {} : { max_context_window_tokens: model.limits.max_context_window_tokens }),
              ...(model.limits.max_prompt_tokens === undefined ? {} : { max_prompt_tokens: model.limits.max_prompt_tokens }),
            },
          }),
      ...(pricing === undefined ? {} : { pricing }),
      ...(chat === undefined ? {} : { chat }),
      ...(model.rerankTarget === undefined
        ? {}
        : {
            rerankTarget: {
              protocol: model.rerankTarget.protocol,
              ...(model.rerankTarget.path === undefined ? {} : { path: model.rerankTarget.path }),
            },
          }),
      upstreamModelId: model.upstreamModelId,
      ...(model.publicModelId === undefined ? {} : { publicModelId: model.publicModelId }),
      ...(model.flagOverrides === undefined
        ? {}
        : { flagOverrides: Object.fromEntries(Object.entries(model.flagOverrides)) }),
    };
  });
