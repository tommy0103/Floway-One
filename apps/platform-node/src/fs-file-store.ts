import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { InitializedPersonalStorage } from './personal-storage.ts';
import type { FileStore } from '@floway-dev/platform';

// Filesystem-backed FileStore. Every key resolves to a path under `root`.
// Keys use forward-slash POSIX separators (matching R2's surface) and are
// translated to native path segments on the way in/out so the same key reads
// identically on Windows and POSIX hosts.
//
// Server deployments retain their operator-owned umask/mount boundary.
// Personal composition supplies a private-storage policy so every directory
// and body is current-user-only without changing the stored bytes.
export class FsFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string, private readonly permissions?: InitializedPersonalStorage) {
    // Resolve once so `pathFor` can verify resolved paths still live under it.
    this.root = resolve(root);
    // Standalone/server stores own root creation. Personal stores receive a
    // nominal capability whose factory already created and hardened this root.
    if (permissions === undefined) mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    if (this.permissions === undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      return;
    }
    // A root-level body inherits the already-hardened root. Only nested keys
    // create a new directory that needs explicit hardening.
    const parent = dirname(path);
    if (parent !== this.root) this.permissions.ensureDirectory(parent);
    await writeFile(path, body, { mode: 0o600 });
    this.permissions.hardenFile(path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(async key => await rm(this.pathFor(key), { force: true })));
  }

  // Resolve a key against `root` and reject paths that escape it. Even though
  // the FileStore contract treats keys as opaque, callers are not required
  // to scrub user-controlled segments and a `..`-laden key would otherwise
  // walk to arbitrary host paths under R2 it would simply be a strange key.
  private pathFor(key: string): string {
    if (isAbsolute(key)) throw new Error(`FsFileStore: absolute keys are not supported (${key})`);
    const path = resolve(this.root, ...key.split('/'));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`FsFileStore: key escapes root (${key})`);
    }
    return path;
  }
}
