#!/usr/bin/env node
/**
 * The site's one image encoder.
 *
 * The committed sets are archival: `docs/screenshots/2026-08-29/` holds 2x PNGs
 * (a window shot is 3200x2000, ~2.5 MB) and the sample stills are 1400 px JPEGs.
 * Shipping those verbatim is what made the Gallery slow — 49 plates at a
 * megabyte each is a page that trickles in rather than appearing.
 *
 * So every raster the site serves is re-encoded here to WebP: same picture, a
 * tenth of the bytes, and still 2x or better at the size it is actually drawn
 * (a gallery card is ~300 CSS px, a figure in the guide ~690). The masters are
 * untouched — they stay the source for print, for GitHub's own rendering of
 * docs/*.md, and for a future re-encode at different settings.
 *
 *   PNG/JPEG -> .webp, quality 82, long edge capped (see LIMITS)
 *   everything else (mp4, gif, json) -> copied verbatim
 *
 * 82 is where the artefacts stop being visible on these pictures: the flat UI
 * panels and the smooth greys of an MRI slice are both clean at it, and a step
 * to 90 costs ~60% more bytes for a difference no viewer can see.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import sharp from 'sharp';

export const QUALITY = 82;

/**
 * The cap is per axis, not on the long edge: the tall, narrow panel crops
 * (`ui-layer-panel.png` is 576x1870) are already close to the width they are
 * drawn at, and a long-edge rule would shrink them below 2x to satisfy a limit
 * their width never approached.
 */
export const LIMITS = { width: 1600, height: 2000 };

const RASTER = new Set(['.png', '.jpg', '.jpeg']);

/** Is this a raster this module re-encodes, rather than an asset it copies? */
export function isRaster(file) {
  return RASTER.has(extname(file).toLowerCase());
}

/** The name `file` is served under: a re-encoded raster becomes `.webp`. */
export function webName(file) {
  return isRaster(file) ? file.slice(0, -extname(file).length) + '.webp' : file;
}

/** Rewrite the asset references in one markdown/HTML body to the served names. */
export function rewriteRasterRefs(body, prefix) {
  const pattern = new RegExp(`(${prefix}[^"'()\\s]+)\\.(png|jpe?g)\\b`, 'gi');
  return body.replace(pattern, '$1.webp');
}

/** Re-encode one raster to `outPath` (already `.webp`). Returns its size in bytes. */
export async function encode(srcPath, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const image = sharp(srcPath);
  const { width, height } = await image.metadata();
  const resize =
    width > LIMITS.width || height > LIMITS.height
      ? {
          width: Math.min(width, LIMITS.width),
          height: Math.min(height, LIMITS.height),
          fit: 'inside',
        }
      : null;
  const pipeline = resize === null ? image : image.resize(resize);
  const { size } = await pipeline.webp({ quality: QUALITY, effort: 5 }).toFile(outPath);
  return size;
}

/**
 * Mirror `srcDir` into `outDir`, re-encoding rasters and copying the rest.
 * `filter(absolutePath)` drops entries (sync.mjs uses it to keep .md out of
 * public/, where VitePress would pick it up as a page).
 */
export async function mirror(srcDir, outDir, { filter = () => true } = {}) {
  let encoded = 0;
  let bytes = 0;
  const walk = async (dir) => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name);
      if (!filter(from)) continue;
      if (statSync(from).isDirectory()) {
        await walk(from);
        continue;
      }
      const to = join(outDir, webName(relative(srcDir, from)));
      if (isRaster(from)) {
        bytes += await encode(from, to);
        encoded += 1;
      } else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    }
  };
  await walk(srcDir);
  return { encoded, bytes };
}
