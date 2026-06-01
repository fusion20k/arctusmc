import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";

async function fetch3dBody(uuid: string): Promise<Buffer | null> {
  const uuidNoDash = uuid.replace(/-/g, "");
  const uuidDash = uuid.includes("-")
    ? uuid
    : `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  const sources = [
    `https://mc-heads.net/body/${uuidNoDash}/320`,
    `https://crafatar.com/renders/body/${uuidNoDash}?overlay&scale=10`,
    `https://visage.surgeplay.com/full/512/${uuidNoDash}`,
    `https://starlightskins.lunareclipse.studio/render/walking/${uuidDash}/full`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) continue;
      if (buf.subarray(0, 4).toString("hex") !== "89504e47") continue;
      const meta = await sharp(buf).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w < 100 || h < 200) continue;
      if (h < w * 1.5) continue;
      return buf;
    } catch {
      continue;
    }
  }
  return null;
}

async function extractRegion(
  textureBytes: Buffer,
  left: number,
  top: number,
  width: number,
  height: number,
  flop = false,
): Promise<Buffer | null> {
  try {
    let pipeline = sharp(textureBytes)
      .extract({ left, top, width, height })
      .ensureAlpha();
    if (flop) pipeline = pipeline.flop();
    return await pipeline.toBuffer();
  } catch {
    return null;
  }
}

async function compositeLayer(
  base: Buffer,
  overlay: Buffer | null,
  width: number,
  height: number,
): Promise<Buffer> {
  if (!overlay) return base;
  return sharp(base)
    .composite([{ input: overlay, blend: "over" }])
    .resize(width, height, { kernel: "nearest" })
    .png()
    .toBuffer();
}

async function renderBodyAvatar(textureBytes: Buffer): Promise<Buffer> {
  const meta = await sharp(textureBytes).metadata();
  const isLegacy = (meta.height ?? 64) === 32;

  const head = await extractRegion(textureBytes, 8, 8, 8, 8);
  const headOverlay = await extractRegion(textureBytes, 40, 8, 8, 8);
  const body = await extractRegion(textureBytes, 20, 20, 8, 12);
  const bodyOverlay = isLegacy ? null : await extractRegion(textureBytes, 20, 36, 8, 12);
  const rArm = await extractRegion(textureBytes, 44, 20, 4, 12);
  const rArmOverlay = isLegacy ? null : await extractRegion(textureBytes, 44, 36, 4, 12);
  const rLeg = await extractRegion(textureBytes, 4, 20, 4, 12);
  const rLegOverlay = isLegacy ? null : await extractRegion(textureBytes, 4, 36, 4, 12);

  const lArm = isLegacy
    ? await extractRegion(textureBytes, 44, 20, 4, 12, true)
    : await extractRegion(textureBytes, 36, 52, 4, 12);
  const lArmOverlay = isLegacy
    ? null
    : await extractRegion(textureBytes, 52, 52, 4, 12);
  const lLeg = isLegacy
    ? await extractRegion(textureBytes, 4, 20, 4, 12, true)
    : await extractRegion(textureBytes, 20, 52, 4, 12);
  const lLegOverlay = isLegacy
    ? null
    : await extractRegion(textureBytes, 4, 52, 4, 12);

  if (!head || !body || !rArm || !rLeg || !lArm || !lLeg) {
    throw new Error("Missing required body region");
  }

  const headLayer = await compositeLayer(head, headOverlay, 8, 8);
  const bodyLayer = await compositeLayer(body, bodyOverlay, 8, 12);
  const rArmLayer = await compositeLayer(rArm, rArmOverlay, 4, 12);
  const lArmLayer = await compositeLayer(lArm, lArmOverlay, 4, 12);
  const rLegLayer = await compositeLayer(rLeg, rLegOverlay, 4, 12);
  const lLegLayer = await compositeLayer(lLeg, lLegOverlay, 4, 12);

  const canvas = await sharp({
    create: {
      width: 16,
      height: 32,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: headLayer, left: 4, top: 0 },
      { input: rArmLayer, left: 0, top: 8 },
      { input: bodyLayer, left: 4, top: 8 },
      { input: lArmLayer, left: 12, top: 8 },
      { input: rLegLayer, left: 4, top: 20 },
      { input: lLegLayer, left: 8, top: 20 },
    ])
    .png()
    .toBuffer();

  return sharp(canvas)
    .resize(128, 256, { kernel: "nearest" })
    .png()
    .toBuffer();
}

async function main() {
  const rows = await db
    .select({ id: skins.id, slug: skins.slug, texture: skins.texture, source_uuid: skins.source_uuid })
    .from(skins);

  console.log(`Re-rendering avatars for ${rows.length} skins (concurrency=8)...`);
  let ok = 0;
  let fail = 0;
  let remote = 0;
  let flat = 0;
  const CONCURRENCY = 8;

  async function processOne(row: typeof rows[number]) {
    try {
      const remoteBuf = row.source_uuid
        ? await fetch3dBody(row.source_uuid)
        : null;
      let avatar: Buffer;
      let source: string;
      if (remoteBuf) {
        remote++;
        avatar = remoteBuf;
        source = "3d";
      } else {
        const textureBuf = Buffer.from(row.texture as Uint8Array);
        avatar = await renderBodyAvatar(textureBuf);
        flat++;
        source = "flat";
      }
      await db.update(skins).set({ avatar }).where(eq(skins.id, row.id));
      ok++;
      if (ok % 50 === 0 || source === "flat") {
        console.log(`  ${ok}/${rows.length} ${row.slug} [${source}]`);
      }
    } catch (e) {
      fail++;
      console.warn(`  fail ${row.slug}: ${(e as Error).message}`);
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const idx = cursor++;
      await processOne(rows[idx]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`Done. ok=${ok} fail=${fail} 3d=${remote} flat=${flat}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
