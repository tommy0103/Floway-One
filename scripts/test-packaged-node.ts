import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const verifier = spawn(pnpm, ['--filter', '@floway-dev/platform-node', 'run', 'test:packaged'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
const [code, signal] = await once(verifier, 'exit') as [number | null, NodeJS.Signals | null];
if (code !== 0) {
  throw new Error(`Packaged Node verifier exited with ${code ?? signal ?? 'an unknown status'}`);
}
