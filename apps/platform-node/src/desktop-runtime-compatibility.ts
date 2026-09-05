import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import packageManifest from '../package.json' with { type: 'json' };

export const DESKTOP_RUNTIME_CONTRACT_ENV = 'FLOWAY_DESKTOP_CONTRACT';
export const DESKTOP_RUNTIME_HEALTH_PATH = '/api/desktop/health';
export const DESKTOP_RUNTIME_PROTOCOL_VERSION = 1;

export interface DesktopRuntimeCompatibility {
  readonly contractDigest: string;
  readonly protocolVersion: typeof DESKTOP_RUNTIME_PROTOCOL_VERSION;
  readonly releaseVersion: string;
}

const exactVersion = /^\d+\.\d+\.\d+$/;

export const loadDesktopRuntimeCompatibility = (
  contractPath: string | undefined,
): DesktopRuntimeCompatibility | null => {
  if (contractPath === undefined) return null;

  let source: string;
  let value: unknown;
  try {
    source = readFileSync(contractPath, 'utf8');
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Floway desktop compatibility contract is unavailable at ${contractPath}`, { cause });
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Floway desktop compatibility contract must be an object');
  }
  const contract = value as {
    compatibility?: { protocolVersion?: unknown; releaseVersion?: unknown };
    schemaVersion?: unknown;
  };
  const protocolVersion = contract.compatibility?.protocolVersion;
  const releaseVersion = contract.compatibility?.releaseVersion;
  if (contract.schemaVersion !== 2) {
    throw new Error(`Floway desktop bundle schema ${String(contract.schemaVersion)} is incompatible with this runtime`);
  }
  if (protocolVersion !== DESKTOP_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Floway desktop protocol ${String(protocolVersion)} is incompatible with runtime protocol ${DESKTOP_RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  if (typeof releaseVersion !== 'string' || !exactVersion.test(releaseVersion)) {
    throw new Error('Floway desktop release version is invalid');
  }
  if (releaseVersion !== packageManifest.version) {
    throw new Error(
      `Floway desktop release ${releaseVersion} is incompatible with sidecar ${packageManifest.version}`,
    );
  }
  return {
    contractDigest: createHash('sha256').update(source).digest('hex'),
    protocolVersion,
    releaseVersion,
  };
};
