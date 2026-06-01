export interface ColorTag {
  slug: string;
  name: string;
  type: "color";
}

interface PaletteEntry {
  slug: string;
  name: string;
  rgb: [number, number, number];
}

const PALETTE: PaletteEntry[] = [
  { slug: "red", name: "Red", rgb: [200, 50, 50] },
  { slug: "orange", name: "Orange", rgb: [220, 140, 60] },
  { slug: "yellow", name: "Yellow", rgb: [220, 220, 60] },
  { slug: "green", name: "Green", rgb: [60, 180, 60] },
  { slug: "blue", name: "Blue", rgb: [60, 100, 200] },
  { slug: "purple", name: "Purple", rgb: [130, 60, 200] },
  { slug: "pink", name: "Pink", rgb: [220, 100, 180] },
  { slug: "brown", name: "Brown", rgb: [140, 90, 50] },
  { slug: "black", name: "Black", rgb: [30, 30, 30] },
  { slug: "white", name: "White", rgb: [230, 230, 230] },
  { slug: "gray", name: "Gray", rgb: [130, 130, 130] },
];

function sqDist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function nearestPalette(r: number, g: number, b: number): PaletteEntry {
  let best = PALETTE[0]!;
  let bestDist = Infinity;
  for (const p of PALETTE) {
    const d = sqDist([r, g, b], p.rgb);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function extractColorTags(
  rawPixels: Buffer,
  channels = 4,
  topN = 3,
): ColorTag[] {
  const counts = new Map<string, number>();
  let totalLuminance = 0;
  let totalSaturation = 0;
  let validPixels = 0;

  for (let i = 0; i + channels - 1 < rawPixels.length; i += channels) {
    const r = rawPixels[i]!;
    const g = rawPixels[i + 1]!;
    const b = rawPixels[i + 2]!;
    const a = channels === 4 ? (rawPixels[i + 3] ?? 255) : 255;

    if (a < 128) continue;

    validPixels++;
    const entry = nearestPalette(r, g, b);
    counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1);

    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    totalLuminance += l;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    totalSaturation += s;
  }

  if (validPixels === 0) return [];

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  const result: ColorTag[] = sorted.map(([slug]) => {
    const entry = PALETTE.find((p) => p.slug === slug)!;
    return { slug: entry.slug, name: entry.name, type: "color" as const };
  });

  const avgLuminance = (totalLuminance / validPixels) * 100;
  const avgSaturation = (totalSaturation / validPixels) * 100;

  if (avgLuminance < 25) {
    result.push({ slug: "dark", name: "Dark", type: "color" });
  } else if (avgLuminance > 75) {
    result.push({ slug: "light", name: "Light", type: "color" });
  }

  if (avgSaturation > 40) {
    result.push({ slug: "colorful", name: "Colorful", type: "color" });
  } else if (avgSaturation < 15) {
    result.push({ slug: "monochrome", name: "Monochrome", type: "color" });
  }

  return result;
}
