import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Tauri names each external binary with the Rust target triple shown in its
// immutable sidecar documentation examples.
// https://github.com/tauri-apps/tauri-docs/blob/d7a6d117ddd5e00f6ac4d5bd81ea22220dfb1243/src/content/docs/develop/sidecar.mdx#L34-L43
export const HOST_TARGET_TRIPLES = {
  darwin: {
    arm64: 'aarch64-apple-darwin',
    x64: 'x86_64-apple-darwin',
  },
  linux: {
    arm64: 'aarch64-unknown-linux-gnu',
    x64: 'x86_64-unknown-linux-gnu',
  },
  win32: {
    arm64: 'aarch64-pc-windows-msvc',
    x64: 'x86_64-pc-windows-msvc',
  },
} as const;

export type DesktopHostPlatform = keyof typeof HOST_TARGET_TRIPLES;
export type DesktopHostArchitecture = keyof (typeof HOST_TARGET_TRIPLES)[DesktopHostPlatform];
export type DesktopTargetTriple = (typeof HOST_TARGET_TRIPLES)[DesktopHostPlatform][DesktopHostArchitecture];

export const MACOS_TARGET_TRIPLES = Object.freeze([
  HOST_TARGET_TRIPLES.darwin.arm64,
  HOST_TARGET_TRIPLES.darwin.x64,
] as const);

export const DESKTOP_COMPATIBILITY_VERSION = 1;

const exactVersion = /^\d+\.\d+\.\d+$/;

export const targetTripleForHost = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): DesktopTargetTriple => {
  const targets = HOST_TARGET_TRIPLES[platform as DesktopHostPlatform] as Partial<Record<NodeJS.Architecture, DesktopTargetTriple>> | undefined;
  const target = targets?.[architecture];
  if (target === undefined) {
    throw new Error(`Desktop Node sidecar packaging does not support ${platform}/${architecture}`);
  }
  return target;
};

export const architectureForTargetTriple = (targetTriple: string): 'arm64' | 'x64' => {
  for (const [architecture, candidate] of Object.entries(HOST_TARGET_TRIPLES.darwin)) {
    if (candidate === targetTriple) return architecture as 'arm64' | 'x64';
  }
  throw new Error(`Desktop macOS verification does not support target ${targetTriple}`);
};

export const readPackagedNodeVersion = async (desktopRoot: string): Promise<string> => {
  const versionPath = resolve(desktopRoot, '.node-version');
  let version: string;
  try {
    version = (await readFile(versionPath, 'utf8')).trim();
  } catch (cause) {
    throw new Error(`Desktop Node version authority is unavailable at ${versionPath}`, { cause });
  }
  // Node publishes this versioned directory and its immutable SHASUMS file.
  // https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
  if (!exactVersion.test(version)) {
    throw new Error(`Desktop Node version authority is invalid at ${versionPath}`);
  }
  return version;
};

export const readDesktopReleaseVersion = async (desktopRoot: string): Promise<string> => {
  const manifestPath = resolve(desktopRoot, 'package.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`Desktop release version authority is unavailable at ${manifestPath}`, { cause });
  }
  const version = typeof value === 'object' && value !== null && 'version' in value
    ? (value as { version?: unknown }).version
    : undefined;
  if (typeof version !== 'string' || !exactVersion.test(version)) {
    throw new Error(`Desktop release version authority is invalid at ${manifestPath}`);
  }
  return version;
};
