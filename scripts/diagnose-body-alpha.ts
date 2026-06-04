import { sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";

type Rect = { left: number; top: number; width: number; height: number };

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
): {
  total: number;
  alphaZero: number;
  alphaLt255: number;
  alpha255: number;
  alphaZeroRgbZero: number;
} {
  let total = 0;
  let alphaZero = 0;
  let alphaLt255 = 0;
  let alpha255 = 0;
  let alphaZeroRgbZero = 0;

  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const idx = (y * imgWidth + x) * channels;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const a = data[idx + 3] ?? 255;
      total++;
      if (a === 0) {
        alphaZero++;
        if (r === 0 && g === 0 && b === 0) alphaZeroRgbZero++;
      }
      if (a < 255) alphaLt255++;
      if (a === 255) alpha255++;
    }
  }

  return { total, alphaZero, alphaLt255, alpha255, alphaZeroRgbZero };
}

async function main() {
  const rows = await db
    .select({ id: skins.id, slug: skins.slug, texture: skins.texture, model: skins.model })
    .from(skins)
    .orderBy(sql`RANDOM()`)
    .limit(5);

  if (rows.length === 0) {
    console.log("No skins found.");
    return;
  }

  let mostlyTransparentCount = 0;

  for (const row of rows) {
    const texture = Buffer.from(row.texture as Uint8Array);
    const { data, info } = await sharp(texture)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rects = getLayer1BodyRects(info.height);
    let total = 0;
    let alphaZero = 0;
    let alphaLt255 = 0;
    let alpha255 = 0;
    let alphaZeroRgbZero = 0;

    for (const rect of rects) {
      const stats = analyzeRect(data, info.width, info.channels, rect);
      total += stats.total;
      alphaZero += stats.alphaZero;
      alphaLt255 += stats.alphaLt255;
      alpha255 += stats.alpha255;
      alphaZeroRgbZero += stats.alphaZeroRgbZero;
    }

    const zeroPct = total > 0 ? (alphaZero / total) * 100 : 0;
    const lt255Pct = total > 0 ? (alphaLt255 / total) * 100 : 0;
    const zeroRgbZeroPct = alphaZero > 0 ? (alphaZeroRgbZero / alphaZero) * 100 : 0;

    const mostlyTransparent = alphaZero / Math.max(total, 1) >= 0.7;
    if (mostlyTransparent) mostlyTransparentCount++;

    console.log(
      `${row.id} ${row.slug} model=${row.model} size=${info.width}x${info.height} ` +
        `alpha0=${alphaZero}/${total} (${zeroPct.toFixed(1)}%) ` +
        `alpha<255=${alphaLt255}/${total} (${lt255Pct.toFixed(1)}%) ` +
        `alpha0_rgb0=${alphaZeroRgbZero}/${Math.max(alphaZero, 1)} (${zeroRgbZeroPct.toFixed(1)}%) ` +
        `mostlyTransparent=${mostlyTransparent}`,
    );
  }

  console.log(`Summary: ${mostlyTransparentCount}/${rows.length} samples mostly transparent in layer1 body base region`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
