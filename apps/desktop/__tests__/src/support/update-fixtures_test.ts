import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { generateUpdateSigningKey, nextUpdateVerificationVersion, signUpdateArtifact, UpdateFixtureServer } from './update-fixtures.ts';

test.each([
  ['0.1.0', '0.2.0'], ['0.2.0', '0.3.0'], ['1.9.7', '1.10.0'], ['10.20.30', '10.21.0'],
])('Floway packaged upgrade verification advances the current release %s to %s', (current, expected) => {
  expect(nextUpdateVerificationVersion(current)).toBe(expected);
});

test('Floway loopback fixture instruments real manifest and artifact requests', async () => {
  const server = await UpdateFixtureServer.start();
  try {
    server.serve({ artifact: Buffer.from('fixture'), manifest: { version: '0.2.0' } });
    expect(server.requestCount).toBe(0);
    expect(await (await fetch(server.manifestUrl)).json()).toEqual({ version: '0.2.0' });
    expect(server.requestCount).toBe(1);
    expect(await (await fetch(server.artifactUrl)).text()).toBe('fixture');
    expect(server.requestCount).toBe(2);
  } finally {
    await server.close();
  }
});

test('Floway fixture signer uses its temporary key when publisher credentials are present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-fixture-signer-'));
  const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  process.env.TAURI_SIGNING_PRIVATE_KEY = 'publisher-credential-must-not-reach-the-fixture';
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'publisher-password';
  try {
    const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const key = await generateUpdateSigningKey(repositoryRoot, join(root, 'key'));
    const artifact = join(root, 'fixture.tar.gz');
    await writeFile(artifact, Buffer.from('Floway fixture artifact'));
    const signature = await signUpdateArtifact(repositoryRoot, key, artifact);
    expect(signature).toBe((await readFile(`${artifact}.sig`, 'utf8')).trim());
    const publicPacket = Buffer.from(Buffer.from(key.pubkey, 'base64').toString('utf8').split('\n')[1]!, 'base64');
    const signaturePacket = Buffer.from(Buffer.from(signature, 'base64').toString('utf8').split('\n')[1]!, 'base64');
    expect(publicPacket).toHaveLength(42);
    expect(signaturePacket).toHaveLength(74);
    expect(signaturePacket.subarray(2, 10)).toEqual(publicPacket.subarray(2, 10));
  } finally {
    if (privateKey === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    else process.env.TAURI_SIGNING_PRIVATE_KEY = privateKey;
    if (password === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    else process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);
