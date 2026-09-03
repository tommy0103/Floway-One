import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { runNodeEntry } from '../../entry.ts';
import type { PersonalRuntimePaths } from '../../src/personal-runtime.ts';

const [mode, dataDir] = process.argv.slice(2);
if (mode === undefined || dataDir === undefined) throw new Error('Expected a failure mode and data directory');

process.env.FLOWAY_PROFILE = 'personal';
if (mode !== 'profile-invariant') delete process.env.NODE_ENV;

const paths: PersonalRuntimePaths = {
  dataDir,
  databasePath: join(dataDir, 'floway.db'),
  filesDir: join(dataDir, 'files'),
  logsDir: join(dataDir, 'logs'),
  runtimeStatePath: join(dataDir, 'runtime.json'),
};

if (mode === 'corrupt-state') {
  writeFileSync(paths.runtimeStatePath, '{');
} else if (mode === 'invalid-port') {
  process.env.PORT = 'invalid';
} else if (mode === 'state-write') {
  writeFileSync(paths.runtimeStatePath, '{ "version": 1, "port": 8788 }');
  mkdirSync(`${paths.runtimeStatePath}.${process.pid}.tmp`);
  process.env.PORT = '9876';
}

if (mode === 'corrupt-state' || mode === 'invalid-port' || mode === 'state-write') {
  await runNodeEntry({
    resolvePersonalRuntimePaths: () => paths,
  });
} else if (mode === 'migration') {
  await runNodeEntry({
    resolvePersonalRuntimePaths: () => paths,
    start: async () => {
      throw new Error('forced migration failure', { cause: new Error('forced SQLite cause') });
    },
  });
} else if (mode === 'after-listen-server' || mode === 'after-listen-rejection') {
  await runNodeEntry({
    resolvePersonalRuntimePaths: () => paths,
    start: async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('injected listener has no TCP address');
      setImmediate(() => {
        const cause = new Error('forced after-listen cause');
        const failure = new Error(`forced ${mode} fatal failure`, { cause });
        if (mode === 'after-listen-server') server.emit('error', failure);
        else void Promise.reject(failure);
      });
      return address;
    },
  });
} else if (mode === 'profile-invariant') {
  await runNodeEntry({
    resolvePersonalRuntimePaths: () => paths,
  });
} else {
  throw new Error(`Unsupported failure mode: ${mode}`);
}
