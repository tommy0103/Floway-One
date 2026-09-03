import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeInfo } from '../../src/api/runtime-info';
import { LocalizedError } from '../../src/i18n/localized-error';

afterEach(() => { vi.unstubAllGlobals(); });

describe('runtime capability loading', () => {
  it('retains the original transport failure in its error chain', async () => {
    const transportError = new Error('connection refused');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportError));

    const caught = await loadRuntimeInfo().then(() => null, (error: unknown) => error);

    expect(caught).toBeInstanceOf(LocalizedError);
    expect((caught as LocalizedError).translationKey).toBe('common.errors.runtimeCapabilitiesUnavailable');
    expect((caught as LocalizedError).message).not.toContain('connection refused');
    expect((caught as LocalizedError).stackWithMessage('Localized runtime message'))
      .toMatch(/^LocalizedError: Localized runtime message\n/);
    expect((caught as LocalizedError).cause).toMatchObject({ cause: transportError });
  });
});
