import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// Regenerates src-tauri/icons/icon.generated.png, the source the bundler turns
// into the application icon: the Floway mark on a full-bleed macOS squircle in
// the brand rose gradient. Run with `pnpm run generate:icon`.
const SIZE = 1024;

// A full-bleed macOS icon is a superellipse, not a rounded rect: |x|^n+|y|^n=1
// with n=4.6 tracks the continuous corner the system draws since Big Sur.
// https://developer.apple.com/design/human-interface-guidelines/app-icons
const SQUIRCLE_EXPONENT = 4.6;

const squirclePath = (size: number): string => {
  const half = size / 2;
  const points: string[] = [];
  for (let index = 0; index <= 128; index++) {
    const angle = (index / 128) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push(
      `${(half + half * Math.sign(cos) * Math.abs(cos) ** (2 / SQUIRCLE_EXPONENT)).toFixed(1)},` +
      `${(half + half * Math.sign(sin) * Math.abs(sin) ** (2 / SQUIRCLE_EXPONENT)).toFixed(1)}`,
    );
  }
  return `M ${points.join(' L ')} Z`;
};

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const markSource = resolve(desktopRoot, '../web/src/assets/emoji-cherry-blossom.svg');
const output = resolve(desktopRoot, 'src-tauri/icons/icon.generated.png');

const background = Buffer.from(`<svg width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="g" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#ffbdd2"/>
      <stop offset="1" stop-color="#c93a6f"/>
    </linearGradient>
  </defs>
  <path d="${squirclePath(SIZE)}" fill="url(#g)"/>
</svg>`);

const markSize = Math.round(SIZE * 0.66);
const mark = await sharp(readFileSync(markSource), { density: 300 }).resize(markSize, markSize).png().toBuffer();
// tint preserves alpha, so this is the mark's silhouette for the soft shadow.
const shadow = await sharp(mark).tint('#7e2547').blur(16).toBuffer();

const offset = Math.round((SIZE - markSize) / 2);
await sharp(background)
  .composite([
    { input: shadow, left: offset, top: offset + 14 },
    { input: mark, left: offset, top: offset },
  ])
  .png()
  .toFile(output);
console.log(`Wrote ${output}`);
