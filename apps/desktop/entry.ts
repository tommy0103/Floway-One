import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareDesktopBundle } from './src/bundle.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(desktopRoot, '../..');
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE
  ?? (await execFileAsync('rustc', ['--print', 'host-tuple'])).stdout.trim();

const generateRuntime = async (outputRoot: string): Promise<void> => {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      resolve(repositoryRoot, 'scripts/generate-node-runtime.ts'),
      outputRoot,
      '--node-linker=hoisted',
    ], { cwd: repositoryRoot, env: process.env, stdio: 'inherit' });
    child.once('error', cause => rejectRun(new Error('Failed to start the Node runtime assembler', { cause })));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Node runtime assembler exited with ${code ?? signal ?? 'an unknown status'}`));
    });
  });
};

await prepareDesktopBundle({
  desktopRoot,
  generateRuntime,
  nodeArchitecture: process.arch,
  nodeExecutable: process.execPath,
  nodePlatform: process.platform,
  nodeVersion: process.versions.node,
  targetTriple,
});
