import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeInfo } from '../../src/api/runtime-info';

afterEach(() => { vi.unstubAllGlobals(); });

describe('runtime capability loading', () => {
  it('retains the original transport failure in its error chain', async () => {
    const transportError = new Error('connection refused');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportError));

    const caught = await loadRuntimeInfo().then(() => null, (error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('connection refused');
    expect((caught as Error).cause).toMatchObject({ cause: transportError });
  });
});
