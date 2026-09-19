import { describe, expect, it } from 'vitest';

import {
  mergeOverviewSnapshot,
  type OverviewRegion,
  type OverviewSnapshot,
} from '../../../src/components/overview/data';

const region = <T>(value: T): OverviewRegion<T> => ({ value, failure: null });
const failed = <T>(message: string, at: number): OverviewRegion<T> => ({ value: null, failure: { at, message } });

const snapshot = (upstreams: OverviewSnapshot['upstreams'], gatheredAt = 1_000): OverviewSnapshot => ({
  gatheredAt,
  health: region({ ok: true }),
  upstreams,
  keys: region({ total: 1, lastUsedAt: null }),
  recentRequest: region({ kind: 'capture-off' }),
});

describe('mergeOverviewSnapshot', () => {
  it('keeps an unread failure when a background run fails again', () => {
    const current = snapshot(failed('first failure', 1_000));
    const next = snapshot(failed('second failure', 2_000), 2_000);

    const merged = mergeOverviewSnapshot(current, next, { background: true });

    expect(merged.upstreams).toEqual(failed('first failure', 1_000));
    expect(merged.gatheredAt).toBe(2_000);
  });

  it('lets a background success resolve a shown failure', () => {
    const current = snapshot(failed('first failure', 1_000));
    const next = snapshot(region({ total: 1, failing: 0 }), 2_000);

    const merged = mergeOverviewSnapshot(current, next, { background: true });

    expect(merged.upstreams).toEqual(region({ total: 1, failing: 0 }));
  });

  it('shows a background failure that has not been seen', () => {
    const current = snapshot(region({ total: 1, failing: 0 }));
    const next = snapshot(failed('fresh failure', 2_000), 2_000);

    const merged = mergeOverviewSnapshot(current, next, { background: true });

    expect(merged.upstreams).toEqual(failed('fresh failure', 2_000));
  });

  it('commits everything on a foreground run', () => {
    const current = snapshot(failed('first failure', 1_000));
    const next = snapshot(failed('foreground failure', 2_000), 2_000);

    const merged = mergeOverviewSnapshot(current, next, { background: false });

    expect(merged).toBe(next);
  });
});
