import { expect, test } from 'vitest';

import { nextUpdateVerificationVersion, UpdateFixtureServer } from './update-fixtures.ts';

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
