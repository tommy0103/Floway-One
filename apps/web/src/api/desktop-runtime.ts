import { z } from 'zod';

import packageManifest from '../../package.json' with { type: 'json' };
import { LocalizedError } from '../i18n/localized-error';

const desktopRuntimeStatusSchema = z.object({
  compatibility: z.object({
    contractDigest: z.string().regex(/^[\da-f]{64}$/),
    protocolVersion: z.literal(1),
    releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
  service: z.literal('floway'),
  status: z.literal('ok'),
});

export type DesktopRuntimeStatus = z.infer<typeof desktopRuntimeStatusSchema>;

export const loadDesktopRuntimeStatus = async (
  signal?: AbortSignal,
): Promise<DesktopRuntimeStatus | null> => {
  const response = await fetch('/api/desktop/health', { signal });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new LocalizedError('common.errors.desktopRuntimeUnavailable', {
      cause: new Error(`Desktop runtime health returned HTTP ${response.status}`),
    });
  }
  const parsed = desktopRuntimeStatusSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.compatibility.releaseVersion !== packageManifest.version) {
    throw new LocalizedError('common.errors.desktopCompatibilityMismatch', {
      cause: parsed.success
        ? new Error(
            `Dashboard ${packageManifest.version} received desktop release ${parsed.data.compatibility.releaseVersion}`,
          )
        : parsed.error,
    });
  }
  return parsed.data;
};
