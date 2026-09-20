import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { basename, dirname, resolve } from 'node:path';

export const UPDATE_VERIFICATION_VERSION = '0.2.0';

export interface UpdateSigningKey {
  readonly privateKeyPath: string;
  readonly password: string;
  readonly pubkey: string;
}

const pnpmCli = (): string => {
  const cli = process.env.npm_execpath;
  if (cli === undefined) throw new Error('Update fixture tooling requires pnpm to provide npm_execpath');
  return cli;
};

const runPnpm = async (
  repositoryRoot: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  let output = '';
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [pnpmCli(), ...args], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', cause => rejectRun(new Error(`Failed to start pnpm ${args.join(' ')}`, { cause })));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`pnpm ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown status'}\n${output}`));
    });
  });
  return output;
};

const runTauriSigner = async (
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> => await runPnpm(repositoryRoot, ['--filter', '@floway-dev/desktop', 'exec', 'tauri', 'signer', ...args]);

// The packaged verifier generates a throwaway minisign keypair per run; the
// private key never leaves the verifier's temporary directory.
// https://github.com/tauri-apps/tauri-docs/blob/d7a6d117ddd5e00f6ac4d5bd81ea22220dfb1243/src/content/docs/plugin/updater.mdx#signing-updates
export const generateUpdateSigningKey = async (
  repositoryRoot: string,
  directory: string,
): Promise<UpdateSigningKey> => {
  await mkdir(directory, { recursive: true });
  const privateKeyPath = resolve(directory, 'update-verification.key');
  const password = 'floway-update-verification';
  await runTauriSigner(repositoryRoot, [
    'generate',
    '--ci',
    '--force',
    '--password',
    password,
    '--write-keys',
    privateKeyPath,
  ]);
  const pubkey = (await readFile(`${privateKeyPath}.pub`, 'utf8')).trim();
  await chmod(privateKeyPath, 0o600);
  return { privateKeyPath, password, pubkey };
};

export const signUpdateArtifact = async (
  repositoryRoot: string,
  key: UpdateSigningKey,
  artifactPath: string,
): Promise<string> => {
  await runTauriSigner(repositoryRoot, [
    'sign',
    artifactPath,
    '--private-key-path',
    key.privateKeyPath,
    '--password',
    key.password,
  ]);
  return (await readFile(`${artifactPath}.sig`, 'utf8')).trim();
};

// The Tauri updater's macOS installer skips the first tar path component, so
// the archive carries the .app directory at its root.
// https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs
export const packageApplicationArchive = async (
  applicationRoot: string,
  outputPath: string,
): Promise<Buffer> => {
  await rm(outputPath, { force: true });
  await new Promise<void>((resolveTar, rejectTar) => {
    const child = spawn('tar', ['-czf', outputPath, '-C', dirname(applicationRoot), basename(applicationRoot)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', cause => rejectTar(new Error('Failed to start tar for the update artifact', { cause })));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveTar();
      else rejectTar(new Error(`tar exited with ${code ?? signal ?? 'an unknown status'}\n${output}`));
    });
  });
  return await readFile(outputPath);
};

export interface UpdateManifestOptions {
  readonly artifactUrl: string;
  readonly signature: string;
  readonly target: string;
  readonly version: string;
}

// The static Tauri updater manifest shape; the artifact signature inside each
// platform entry is what the updater authenticates before installation.
// https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs
export const updateManifest = (options: UpdateManifestOptions): Record<string, unknown> => ({
  version: options.version,
  notes: `Floway ${options.version} verification update`,
  pub_date: '2026-09-20T00:00:00Z',
  platforms: {
    [options.target]: {
      signature: options.signature,
      url: options.artifactUrl,
    },
  },
});

interface ServedUpdateFixture {
  readonly artifact: Buffer;
  readonly manifest: Record<string, unknown>;
}

// A deterministic loopback fixture server standing in for the GitHub Releases
// update endpoint; the verifier swaps the served manifest and artifact
// between application launches.
export class UpdateFixtureServer {
  private fixture: ServedUpdateFixture | undefined;

  private constructor(private readonly server: Server) {}

  static async start(): Promise<UpdateFixtureServer> {
    const holder = new UpdateFixtureServer(createServer((request, response) => {
      if (request.url === '/manifest.json' && holder.fixture !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(holder.fixture.manifest));
        return;
      }
      if (request.url === '/artifact' && holder.fixture !== undefined) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(holder.fixture.artifact);
        return;
      }
      response.writeHead(404);
      response.end();
    }));
    await new Promise<void>((resolveListen, rejectListen) => {
      holder.server.once('error', rejectListen);
      holder.server.listen(0, '127.0.0.1', resolveListen);
    });
    return holder;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Update fixture server has no loopback port');
    }
    return address.port;
  }

  get manifestUrl(): string {
    return `http://127.0.0.1:${this.port}/manifest.json`;
  }

  get artifactUrl(): string {
    return `http://127.0.0.1:${this.port}/artifact`;
  }

  serve(fixture: ServedUpdateFixture): void {
    this.fixture = fixture;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => this.server.close(error => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
  }
}

export const sha256File = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex');

export const writeUpdateChannelFile = async (
  applicationHome: string,
  channel: 'preview' | 'stable',
): Promise<void> => {
  await mkdir(applicationHome, { recursive: true });
  await writeFile(resolve(applicationHome, 'update-channel.json'), `${JSON.stringify({ channel }, undefined, 2)}\n`, { mode: 0o600 });
};

export interface UpdateStateFile {
  readonly failure: {
    readonly chain: readonly string[];
    readonly phase: string;
    readonly version: string | null;
  } | null;
  readonly lastHealthyVersion: string | null;
  readonly pending: {
    readonly installedAt: number;
    readonly previousVersion: string;
    readonly version: string;
  } | null;
  readonly staged: {
    readonly artifactFile: string;
    readonly signature: string;
    readonly version: string;
  } | null;
}

export const readUpdateState = async (applicationHome: string): Promise<UpdateStateFile> =>
  JSON.parse(await readFile(resolve(applicationHome, 'update-state.json'), 'utf8')) as UpdateStateFile;
