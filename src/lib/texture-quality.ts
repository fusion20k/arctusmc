import sharp from "sharp";

export type Rect = { left: number; top: number; width: number; height: number };

export async function expandLegacySkin(textureBytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(textureBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 64 || info.height !== 32) {
    return textureBytes;
  }

  const channels = info.channels;
  const out = Buffer.alloc(64 * 64 * channels, 0);

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const srcIdx = (y * 64 + x) * channels;
      const dstIdx = (y * 64 + x) * channels;
      out[dstIdx] = data[srcIdx] ?? 0;
      out[dstIdx + 1] = data[srcIdx + 1] ?? 0;
      out[dstIdx + 2] = data[srcIdx + 2] ?? 0;
      out[dstIdx + 3] = data[srcIdx + 3] ?? 0;
    }
  }

  const mirrorRegion = (srcLeft: number, srcTop: number, dstLeft: number, dstTop: number) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const sx = srcLeft + (15 - x);
        const sy = srcTop + y;
        const dx = dstLeft + x;
        const dy = dstTop + y;
        const srcIdx = (sy * 64 + sx) * channels;
        const dstIdx = (dy * 64 + dx) * channels;
        out[dstIdx] = data[srcIdx] ?? 0;
        out[dstIdx + 1] = data[srcIdx + 1] ?? 0;
        out[dstIdx + 2] = data[srcIdx + 2] ?? 0;
        out[dstIdx + 3] = data[srcIdx + 3] ?? 0;
      }
    }
  };

  mirrorRegion(40, 16, 32, 48);
  mirrorRegion(0, 16, 16, 48);

  return sharp(out, {
    raw: {
      width: 64,
      height: 64,
      channels,
    },
  })
    .png()
    .toBuffer();
}

export interface BodyQualityStats {
  bodyPixelCount: number;
  blackPixelCount: number;
  bodyBlackFraction: number;
  bodyUniqueColors: number;
}

export function getLayer1BodyRects(height: number): Rect[] {
  const common: Rect[] = [
    { left: 16, top: 16, width: 24, height: 16 },
    { left: 0, top: 16, width: 16, height: 16 },
    { left: 40, top: 16, width: 16, height: 16 },
  ];
  if (height === 64) {
    return [
      ...common,
      { left: 16, top: 48, width: 16, height: 16 },
      { left: 32, top: 48, width: 16, height: 16 },
    ];
  }
  return common;
}

export async function normalizeLayer1BodyAlpha(textureBytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(textureBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 64 || (info.height !== 64 && info.height !== 32)) {
    return textureBytes;
  }

  const patched = Buffer.from(data);
  const rects = getLayer1BodyRects(info.height);

  for (const rect of rects) {
    for (let y = rect.top; y < rect.top + rect.height; y++) {
      for (let x = rect.left; x < rect.left + rect.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (patched[idx + 3]! < 255) {
          if (patched[idx] === 0 && patched[idx + 1] === 0 && patched[idx + 2] === 0) {
            patched[idx] = 56;
            patched[idx + 1] = 56;
            patched[idx + 2] = 56;
          }
          patched[idx + 3] = 255;
        }
      }
    }
  }

  return sharp(patched, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  })
    .png()
    .toBuffer();
}

export async function analyzeBodyQuality(textureBytes: Buffer): Promise<BodyQualityStats | null> {
  const { data, info } = await sharp(textureBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 64 || (info.height !== 64 && info.height !== 32)) {
    return null;
  }

  const rects = getLayer1BodyRects(info.height);
  const uniqueColors = new Set<number>();
  let bodyPixelCount = 0;
  let blackPixelCount = 0;

  for (const rect of rects) {
    for (let y = rect.top; y < rect.top + rect.height; y++) {
      for (let x = rect.left; x < rect.left + rect.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;

        uniqueColors.add((r << 16) | (g << 8) | b);
        bodyPixelCount++;

        if (r === 0 && g === 0 && b === 0) {
          blackPixelCount++;
        }
      }
    }
  }

  const bodyBlackFraction = bodyPixelCount > 0 ? blackPixelCount / bodyPixelCount : 0;

  return {
    bodyPixelCount,
    blackPixelCount,
    bodyBlackFraction,
    bodyUniqueColors: uniqueColors.size,
  };
}
