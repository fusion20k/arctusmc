import sharp from "sharp";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";

type Rect = { left: number; top: number; width: number; height: number };

type SkinRow = {
  id: number;
  slug: string;
  texture: Uint8Array;
  model: string;
};

type BodyStats = {
  total: number;
  blackRgb: number;
  uniqueRgbCount: number;
};

type ResultRow = {
  id: number;
  slug: string;
  model: string;
  bodyBlackFraction: number;
  bodyUniqueColors: number;
  texture: Buffer;
};

function getLayer1BodyRects(height: number): Rect[] {
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

function analyzeRect(
  data: Buffer,
  imgWidth: number,
  channels: number,
  rect: Rect,
  uniqueColors: Set<number>,
): { total: number; blackRgb: number } {
  let total = 0;
  let blackRgb = 0;

  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const idx = (y * imgWidth + x) * channels;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const rgb = (r << 16) | (g << 8) | b;

      uniqueColors.add(rgb);
      total++;

      if (r === 0 && g === 0 && b === 0) {
        blackRgb++;
      }
    }
  }

  return { total, blackRgb };
}

async function main() {
  const rows = (await db
    .select({
      id: skins.id,
      slug: skins.slug,
      texture: skins.texture,
      model: skins.model,
    })
    .from(skins)) as SkinRow[];

  if (rows.length === 0) {
    console.log("No skins found.");
    return;
  }

  let processed = 0;
  let skipped = 0;
  const analyzed: ResultRow[] = [];

  for (const row of rows) {
    const texture = Buffer.from(row.texture);
    const { data, info } = await sharp(texture)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== 64 || (info.height !== 32 && info.height !== 64)) {
      skipped++;
      continue;
    }

    const rects = getLayer1BodyRects(info.height);
    const uniqueColors = new Set<number>();
    const stats: BodyStats = {
      total: 0,
      blackRgb: 0,
      uniqueRgbCount: 0,
    };

    for (const rect of rects) {
      const s = analyzeRect(data, info.width, info.channels, rect, uniqueColors);
      stats.total += s.total;
      stats.blackRgb += s.blackRgb;
    }

    stats.uniqueRgbCount = uniqueColors.size;

    const bodyBlackFraction = stats.total > 0 ? stats.blackRgb / stats.total : 0;
    analyzed.push({
      id: row.id,
      slug: row.slug,
      model: row.model,
      bodyBlackFraction,
      bodyUniqueColors: stats.uniqueRgbCount,
      texture,
    });

    processed++;
  }

  const ge90 = analyzed.filter((r) => r.bodyBlackFraction >= 0.9);
  const ge95 = analyzed.filter((r) => r.bodyBlackFraction >= 0.95);
  const le2 = analyzed.filter((r) => r.bodyUniqueColors <= 2);
  const le5 = analyzed.filter((r) => r.bodyUniqueColors <= 5);

  const toSave = [...ge95].sort((a, b) => b.bodyBlackFraction - a.bodyBlackFraction).slice(0, 5);
  const savedFiles: string[] = [];

  for (const row of toSave) {
    const out = `/Users/david/Desktop/skinora/.tmp-black-${row.id}.png`;
    await sharp(row.texture).png().toFile(out);
    savedFiles.push(`.\\.tmp-black-${row.id}.png`);
  }

  console.log(`Total skins in DB: ${rows.length}`);
  console.log(`Processed valid textures: ${processed}`);
  console.log(`Skipped invalid dimensions: ${skipped}`);
  console.log(`body_black_fraction >= 0.90: ${ge90.length}`);
  console.log(`body_black_fraction >= 0.95: ${ge95.length}`);
  console.log(`body_unique_colors <= 2: ${le2.length}`);
  console.log(`body_unique_colors <= 5: ${le5.length}`);

  if (savedFiles.length > 0) {
    console.log(`Saved ${savedFiles.length} textures from >=0.95 group:`);
    for (const file of savedFiles) {
      console.log(file);
    }
  } else {
    console.log("No textures in >=0.95 group to save.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
