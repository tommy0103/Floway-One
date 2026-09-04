import { describe, expect, test } from 'vitest';

import { deferDisposableDesktopPaths } from './desktop-verification.ts';
import { withFailureSafeCleanup } from '../../src/failure-chain.ts';

const phases = ['app', 'sidecar', 'listener', 'credential', 'data'] as const;

describe('failure-safe desktop verification lifecycle', () => {
  test.each(phases)('cleans every acquired resource when the %s phase fails', async failedPhase => {
    const live = new Set<string>();
    const failure = new Error(`forced ${failedPhase} phase failure`);

    await expect(withFailureSafeCleanup(async cleanup => {
      for (const phase of phases) {
        live.add(phase);
        cleanup.defer(phase, async () => { live.delete(phase); });
        if (phase === failedPhase) throw failure;
      }
    })).rejects.toBe(failure);

    expect([...live]).toEqual([]);
  });

  test('preserves the primary failure and aggregates every cleanup chain', async () => {
    const primary = new Error('primary verification failure');
    const processCleanup = new Error('process cleanup failure');
    const credentialCleanup = new Error('credential cleanup failure');
    let error: AggregateError | undefined;
    try {
      await withFailureSafeCleanup(async cleanup => {
        cleanup.defer('credential', async () => { throw credentialCleanup; });
        cleanup.defer('process', async () => { throw processCleanup; });
        throw primary;
      });
    } catch (value) {
      error = value as AggregateError;
    }

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.cause).toBe(primary);
    expect(error?.errors[0]).toBe(primary);
    expect((error?.errors[1] as Error).cause).toBe(processCleanup);
    expect((error?.errors[2] as Error).cause).toBe(credentialCleanup);
  });

  test('desktop output cleanup retains the verifier failure and every simultaneous removal failure', async () => {
    const primary = new Error('primary desktop verifier failure');
    const failures = new Map([
      ['/target/arm64', new Error('arm64 cleanup failure')],
      ['/distribution/arm64', new Error('distribution cleanup failure')],
      ['/bundle-inputs', new Error('bundle cleanup failure')],
    ]);
    const attempted: string[] = [];
    let error: AggregateError | undefined;
    try {
      await withFailureSafeCleanup(async cleanup => {
        deferDisposableDesktopPaths(cleanup, [...failures].map(([path]) => ({ label: path, path })), async path => {
          attempted.push(path);
          throw failures.get(path);
        });
        throw primary;
      });
    } catch (value) {
      error = value as AggregateError;
    }

    expect(attempted).toEqual(['/bundle-inputs', '/distribution/arm64', '/target/arm64']);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.cause).toBe(primary);
    expect(error?.errors[0]).toBe(primary);
    expect(error?.errors.slice(1).map(item => (item as Error).cause)).toEqual([
      failures.get('/bundle-inputs'),
      failures.get('/distribution/arm64'),
      failures.get('/target/arm64'),
    ]);
  });
});
