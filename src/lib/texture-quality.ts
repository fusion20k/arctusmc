import sharp from "sharp";

export type Rect = { left: number; top: number; width: number; height: number };

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
