import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareDesktopBundle } from './src/bundle.ts';
import {
  architectureForTargetTriple,
  readPackagedNodeVersion,
} from './src/release-contract.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(desktopRoot, '../..');
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE
  ?? (await execFileAsync('rustc', ['--print', 'host-tuple'])).stdout.trim();
const nodeArchitecture = architectureForTargetTriple(targetTriple);
const nodeExecutable = process.env.FLOWAY_DESKTOP_NODE_EXECUTABLE ?? process.execPath;
const executeNode = process.env.FLOWAY_DESKTOP_EXECUTE_NODE === undefined
  ? nodeExecutable === process.execPath
  : process.env.FLOWAY_DESKTOP_EXECUTE_NODE === '1';
const nodeVersion = await readPackagedNodeVersion(desktopRoot);

const generateRuntime = async (outputRoot: string): Promise<void> => {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      resolve(repositoryRoot, 'scripts/generate-node-runtime.ts'),
      outputRoot,
      '--node-linker=hoisted',
      '--target-platform=darwin',
      `--target-architecture=${nodeArchitecture}`,
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
  nodeArchitecture,
  nodeExecutable,
  nodePlatform: 'darwin',
  nodeVersion,
  targetTriple,
  executeNode,
});
