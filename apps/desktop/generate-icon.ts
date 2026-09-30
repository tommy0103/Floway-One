import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// Regenerates src-tauri/icons/icon.generated.png from the Floway mark
// (src-tauri/icons/floway-mark.svg, the owner's mark). Run with
// `pnpm run generate:icon`.
// 512px is the largest source the bundler's icns packer accepts: its largest
// entry is 512@2x, and a 1024@1x source fails with "No matching IconType".
// https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-bundler/src/bundle/macos/icon.rs
const SIZE = 512;

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const markSource = resolve(desktopRoot, 'src-tauri/icons/floway-mark.svg');
const output = resolve(desktopRoot, 'src-tauri/icons/icon.generated.png');

await sharp(readFileSync(markSource), { density: 300 })
  .resize(SIZE, SIZE)
  .png()
  .toFile(output);
console.log(`Wrote ${output}`);
