import { describe, expect, it, vi } from 'vitest';

import { startNodeRuntime } from '../src/start-runtime.ts';

describe('Node runtime startup', () => {
  it('does not expose the listener when storage bootstrap fails', async () => {
    const storageError = new Error('storage unavailable');
    const listen = vi.fn();

    await expect(startNodeRuntime({
      bootstrap: () => { throw storageError; },
      migrate: vi.fn(),
      listen,
    })).rejects.toBe(storageError);
    expect(listen).not.toHaveBeenCalled();
  });

  it('does not expose the listener when migration fails', async () => {
    const migrationError = new Error('migration failed');
    const listen = vi.fn();

    await expect(startNodeRuntime({
      bootstrap: () => ({ db: 'database' }),
      migrate: async () => { throw migrationError; },
      listen,
    })).rejects.toBe(migrationError);
    expect(listen).not.toHaveBeenCalled();
  });
});
