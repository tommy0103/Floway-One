import { expect, test } from 'vitest';

import { nodeDistributionForTarget } from '../../src/node-distribution.ts';

test('associates each macOS target with its own locked Node archive and checksum', () => {
  expect(nodeDistributionForTarget('24.19.0', 'aarch64-apple-darwin')).toEqual({
    archive: 'node-v24.19.0-darwin-arm64.tar.gz',
    sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  });
  expect(nodeDistributionForTarget('24.19.0', 'x86_64-apple-darwin')).toEqual({
    archive: 'node-v24.19.0-darwin-x64.tar.gz',
    sha256: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  });
  expect(() => nodeDistributionForTarget('24.19.1', 'aarch64-apple-darwin')).toThrow(
    'No locked Node.js 24.19.1 distribution',
  );
});
