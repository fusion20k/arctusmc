import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../src/lib/db/client.js";
import { skins, tags, skinTags } from "../src/lib/db/schema.js";
import { extractColorTags } from "../src/lib/colors.js";
import { generateDescription, generateDisplayName } from "../src/lib/description.js";
import { createBodyRenderer, type BodyRenderer } from "../src/lib/render-body.js";

let bodyRenderer: BodyRenderer | null = null;
async function getBodyRenderer(): Promise<BodyRenderer> {
  if (!bodyRenderer) bodyRenderer = await createBodyRenderer();
  return bodyRenderer;
}

const CONCURRENCY = 3;
const INTER_REQUEST_DELAY_MS = 300;
const BATCH_SIZE = 10;

interface ParsedArgs {
  source: "mojang" | "mineskin";
  file?: string;
  limit: number;
  pages: number;
  minViews: number;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf("--source");
  const source = (sourceIdx !== -1 ? args[sourceIdx + 1] : "mojang") as "mojang" | "mineskin";

  if (source === "mojang") {
    const fileIdx = args.indexOf("--file");
    const limitIdx = args.indexOf("--limit");
    if (fileIdx === -1 || !args[fileIdx + 1]) {
      console.error("Usage (mojang): ingest --file <path> [--limit <n>]");
      process.exit(1);
    }
    return {
      source: "mojang",
      file: args[fileIdx + 1]!,
      limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "100", 10) : 100,
      pages: 0,
      minViews: 0,
    };
  }

  const pagesIdx = args.indexOf("--pages");
  const limitIdx = args.indexOf("--limit");
  return {
    source: "mineskin",
    pages: pagesIdx !== -1 ? parseInt(args[pagesIdx + 1] ?? "200", 10) : 200,
    limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "999999", 10) : 999999,
    minViews: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private count: number;
  private queue: (() => void)[] = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}

async function fetchWithBackoff(
  url: string,
  options?: RequestInit,
  maxRetries = 5,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries - 1) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(
        `  [${res.status}] rate limited / server error, retrying in ${delay}ms...`,
      );
      await sleep(delay);
      attempt++;
      continue;
    }
    return res;
  }
}

interface MojangProfile {
  id: string;
  name: string;
}

interface TextureData {
  url: string;
  model: "classic" | "slim";
}

async function bulkResolveUsernames(
  usernames: string[],
): Promise<MojangProfile[]> {
  const res = await fetchWithBackoff("https://api.mojang.com/profiles/minecraft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(usernames),
  });

  if (!res.ok) {
    console.warn(`  Bulk resolve failed with status ${res.status}`);
    return [];
  }

  return (await res.json()) as MojangProfile[];
}

async function fetchTextureData(uuid: string): Promise<TextureData | null> {
  const res = await fetchWithBackoff(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
  );

  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    console.warn(`  Profile fetch failed for ${uuid}: ${res.status}`);
    return null;
  }

  const profile = (await res.json()) as {
    properties?: { name: string; value: string }[];
  };

  const texProp = profile.properties?.find((p) => p.name === "textures");
  if (!texProp) return null;

  const decoded = JSON.parse(
    Buffer.from(texProp.value, "base64").toString("utf-8"),
  ) as {
    textures?: {
      SKIN?: {
        url: string;
        metadata?: { model?: string };
      };
    };
  };

  const skin = decoded.textures?.SKIN;
  if (!skin?.url) return null;

  return {
    url: skin.url,
    model: skin.metadata?.model === "slim" ? "slim" : "classic",
  };
}

async function downloadTexture(url: string): Promise<Buffer | null> {
  const res = await fetchWithBackoff(url);
  if (!res.ok) {
    console.warn(`  Texture download failed: ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sanitizeUsername(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeSlug(username: string, hash: string): string {
  return `${sanitizeUsername(username)}-${hash.slice(0, 8)}`;
}

async function validateTexture(
  textureBytes: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(textureBytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w === 64 && (h === 64 || h === 32)) {
      return { width: w, height: h };
    }
    console.warn(`  Unexpected dimensions: ${w}x${h}`);
    return null;
  } catch {
    console.warn("  Failed to validate texture with sharp");
    return null;
  }
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

async function renderFaceAvatar(textureBytes: Buffer): Promise<Buffer> {
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

async function extractPixels(
  textureBytes: Buffer,
): Promise<{ data: Buffer; channels: number }> {
  const { data, info } = await sharp(textureBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels };
}

async function upsertTagsAndGetIds(
  tagEntries: { slug: string; name: string; type: string }[],
): Promise<number[]> {
  if (tagEntries.length === 0) return [];

  await db
    .insert(tags)
    .values(
      tagEntries.map((t) => ({ slug: t.slug, name: t.name, type: t.type })),
    )
    .onConflictDoNothing();

  const slugs = tagEntries.map((t) => t.slug);
  const rows = await db
    .select({ id: tags.id, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, slugs));

  return rows.map((r) => r.id);
}

async function processSkin(
  username: string,
  uuid: string,
  semaphore: Semaphore,
): Promise<void> {
  await semaphore.acquire();
  try {
    console.log(`Processing ${username} (${uuid})...`);

    await sleep(INTER_REQUEST_DELAY_MS);
    const textureData = await fetchTextureData(uuid);
    if (!textureData) {
      console.log(`  Skipped: no skin texture found`);
      return;
    }

    await sleep(INTER_REQUEST_DELAY_MS);
    const textureBytes = await downloadTexture(textureData.url);
    if (!textureBytes) {
      console.log(`  Skipped: could not download texture`);
      return;
    }

    const hash = sha256(textureBytes);

    const existing = await db
      .select({ id: skins.id })
      .from(skins)
      .where(eq(skins.texture_hash, hash))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(skins)
        .set({ usage_count: sql`${skins.usage_count} + 1` })
        .where(eq(skins.texture_hash, hash));
      console.log(`  Incremented usage_count for existing texture_hash`);
      return;
    }

    const dims = await validateTexture(textureBytes);
    if (!dims) {
      console.log(`  Skipped: invalid texture dimensions`);
      return;
    }

    let avatarBytes: Buffer;
    try {
      const renderer = await getBodyRenderer();
      avatarBytes = await renderer.render(textureBytes, textureData.model);
      console.log(`  Avatar: 3D playwright render`);
    } catch (e) {
      console.warn(`  Avatar: 3D render failed (${(e as Error).message}); falling back to flat composite`);
      avatarBytes = await renderFaceAvatar(textureBytes);
    }
    const { data: rawPixels, channels } = await extractPixels(textureBytes);
    const colorTags = extractColorTags(rawPixels, channels);

    const allTagEntries: { slug: string; name: string; type: string }[] = [
      {
        slug: textureData.model,
        name: textureData.model === "slim" ? "Slim" : "Classic",
        type: "model",
      },
      ...colorTags.map((t) => ({ slug: t.slug, name: t.name, type: t.type })),
    ];

    const description = generateDescription(username, textureData.model, colorTags);
    const displayName = generateDisplayName(textureData.model, colorTags, hash);
    const slug = makeSlug(username, hash);

    const inserted = await db
      .insert(skins)
      .values({
        slug,
        texture_hash: hash,
        source_username: username,
        source_uuid: uuid,
        model: textureData.model,
        texture: textureBytes,
        avatar: avatarBytes,
        tex_width: dims.width,
        tex_height: dims.height,
        description,
        display_name: displayName,
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ id: skins.id });

    if (inserted.length === 0) {
      console.log(`  Skipped: skin row already exists (slug conflict)`);
      return;
    }

    const skinId = inserted[0]!.id;
    const tagIds = await upsertTagsAndGetIds(allTagEntries);

    if (tagIds.length > 0) {
      await db
        .insert(skinTags)
        .values(tagIds.map((tagId) => ({ skin_id: skinId, tag_id: tagId })))
        .onConflictDoNothing();
    }

    const tagSlugs = allTagEntries.map((t) => t.slug).join(", ");
    console.log(`  Inserted: ${slug} [${tagSlugs}]`);
  } finally {
    semaphore.release();
  }
}

interface MineskinEntry {
  id: number;
  uuid: string;
  url: string;
  time: number;
}

interface MineskinListResponse {
  skins: MineskinEntry[];
  page: {
    index: number;
    amount: number;
    total: number;
  };
}

async function fetchMineskinPage(page: number): Promise<MineskinEntry[]> {
  try {
    const res = await fetchWithBackoff(
      `https://api.mineskin.org/get/list/${page}?size=50&sort=-views`,
      undefined,
      3,
    );
    if (!res.ok) {
      console.warn(`  Mineskin page ${page} failed: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as MineskinListResponse;
    return data.skins ?? [];
  } catch (e) {
    console.warn(`  Mineskin page ${page} error: ${(e as Error).message}`);
    return [];
  }
}

async function processMineskinEntry(
  entry: MineskinEntry,
  semaphore: Semaphore,
  stats: { ok: number; dup: number; skip: number },
): Promise<void> {
  await semaphore.acquire();
  try {
    const textureBytes = await downloadTexture(entry.url);
    if (!textureBytes) {
      stats.skip++;
      return;
    }

    const hash = sha256(textureBytes);

    const existing = await db
      .select({ id: skins.id })
      .from(skins)
      .where(eq(skins.texture_hash, hash))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(skins)
        .set({ usage_count: sql`${skins.usage_count} + 1` })
        .where(eq(skins.texture_hash, hash));
      stats.dup++;
      return;
    }

    const dims = await validateTexture(textureBytes);
    if (!dims) {
      stats.skip++;
      return;
    }

    const { data: rawPixels, channels } = await extractPixels(textureBytes);
    const colorTags = extractColorTags(rawPixels, channels);

    const modelDetect = await detectModel(textureBytes);
    const model: "classic" | "slim" = modelDetect;

    const allTagEntries: { slug: string; name: string; type: string }[] = [
      {
        slug: model,
        name: model === "slim" ? "Slim" : "Classic",
        type: "model",
      },
      ...colorTags.map((t) => ({ slug: t.slug, name: t.name, type: t.type })),
    ];

    const description = generateDescription(null, model, colorTags);
    const displayName = generateDisplayName(model, colorTags, hash);
    const slug = makeSlug("ms", hash);
    let avatarBytes: Buffer;
    try {
      const renderer = await getBodyRenderer();
      avatarBytes = await renderer.render(textureBytes, model);
    } catch {
      avatarBytes = await renderFaceAvatar(textureBytes);
    }

    const inserted = await db
      .insert(skins)
      .values({
        slug,
        texture_hash: hash,
        source_username: null,
        source_uuid: null,
        model,
        texture: textureBytes,
        avatar: avatarBytes,
        tex_width: dims.width,
        tex_height: dims.height,
        description,
        display_name: displayName,
        created_at: Math.floor(entry.time * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: skins.id });

    if (inserted.length === 0) {
      stats.dup++;
      return;
    }

    const skinId = inserted[0]!.id;
    const tagIds = await upsertTagsAndGetIds(allTagEntries);

    if (tagIds.length > 0) {
      await db
        .insert(skinTags)
        .values(tagIds.map((tagId) => ({ skin_id: skinId, tag_id: tagId })))
        .onConflictDoNothing();
    }

    stats.ok++;
    if (stats.ok % 100 === 0) {
      console.log(`  Inserted ${stats.ok} skins so far (dup=${stats.dup} skip=${stats.skip})...`);
    }
  } catch (e) {
    stats.skip++;
    console.warn(`  Error processing entry ${entry.id}: ${(e as Error).message}`);
  } finally {
    semaphore.release();
  }
}

async function detectModel(textureBytes: Buffer): Promise<"classic" | "slim"> {
  try {
    const { data, info } = await sharp(textureBytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const channels = info.channels;

    if (w !== 64) return "classic";
    if (h === 32) return "classic";

    const isTransparent = (x: number, y: number): boolean => {
      const idx = (y * w + x) * channels;
      const a = data[idx + 3] ?? 255;
      return a < 16;
    };

    let slimVotes = 0;
    let classicVotes = 0;

    // Right arm top/bottom row: in CLASSIC width 4, columns 50–51 are inside the
    // arm region (used). In SLIM width 3, those columns are outside (transparent).
    for (let y = 16; y < 20; y++) {
      for (const x of [50, 51]) {
        if (isTransparent(x, y)) slimVotes++;
        else classicVotes++;
      }
    }
    // Left arm top/bottom row (64×64 only): same logic mirrored to x=42,43.
    for (let y = 48; y < 52; y++) {
      for (const x of [42, 43]) {
        if (isTransparent(x, y)) slimVotes++;
        else classicVotes++;
      }
    }
    // Right arm overlay top/bottom: columns 50–51 at y=32–35.
    for (let y = 32; y < 36; y++) {
      for (const x of [50, 51]) {
        if (isTransparent(x, y)) slimVotes++;
        else classicVotes++;
      }
    }

    return slimVotes > classicVotes ? "slim" : "classic";
  } catch {
    return "classic";
  }
}

async function runMojangIngestion(args: ParsedArgs): Promise<void> {
  const raw = await readFile(args.file!, "utf-8");
  const usernames = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, args.limit);

  console.log(`Ingesting ${usernames.length} username(s) from ${args.file}...`);

  const semaphore = new Semaphore(CONCURRENCY);
  const batches: string[][] = [];

  for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
    batches.push(usernames.slice(i, i + BATCH_SIZE));
  }

  let totalProcessed = 0;

  for (const batch of batches) {
    console.log(`\nResolving batch: [${batch.join(", ")}]`);
    const profiles = await bulkResolveUsernames(batch);
    await sleep(500);

    if (profiles.length === 0) {
      console.warn("  No profiles returned for this batch");
      continue;
    }

    const profileMap = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));

    const tasks = batch
      .map((name) => profileMap.get(name.toLowerCase()))
      .filter((p): p is MojangProfile => p !== undefined);

    console.log(
      `  Resolved ${tasks.length}/${batch.length} usernames to UUIDs`,
    );

    await Promise.all(
      tasks.map((profile) =>
        processSkin(profile.name, profile.id, semaphore),
      ),
    );

    totalProcessed += tasks.length;
    await sleep(1000);
  }

  console.log(`\nIngestion complete. Processed ${totalProcessed} profile(s).`);

  const countResult = await db
    .select({ total: skins.id })
    .from(skins);
  console.log(`DB now contains ${countResult.length} skin(s).`);
}

async function runMineskinIngestion(args: ParsedArgs): Promise<void> {
  console.log(`Starting Mineskin ingestion: ${args.pages} pages, limit=${args.limit}`);

  const MINESKIN_CONCURRENCY = 4;
  const semaphore = new Semaphore(MINESKIN_CONCURRENCY);
  const stats = { ok: 0, dup: 0, skip: 0 };

  for (let page = 0; page < args.pages; page++) {
    if (stats.ok >= args.limit) {
      console.log(`Reached limit of ${args.limit} new skins. Stopping.`);
      break;
    }

    console.log(`\nFetching Mineskin page ${page}...`);
    const entries = await fetchMineskinPage(page);

    if (entries.length === 0) {
      console.log(`  No entries on page ${page}, stopping.`);
      break;
    }

    await Promise.all(
      entries.map((entry) => processMineskinEntry(entry, semaphore, stats)),
    );

    const delay = 200 + Math.random() * 300;
    await sleep(delay);

    if (page % 10 === 0) {
      const countResult = await db.select({ total: skins.id }).from(skins);
      console.log(`  [page ${page}] DB total: ${countResult.length} | new=${stats.ok} dup=${stats.dup} skip=${stats.skip}`);
    }
  }

  const countResult = await db.select({ total: skins.id }).from(skins);
  console.log(`\nMineskin ingestion complete.`);
  console.log(`  New skins inserted: ${stats.ok}`);
  console.log(`  Duplicates (usage_count incremented): ${stats.dup}`);
  console.log(`  Skipped (bad texture/error): ${stats.skip}`);
  console.log(`  DB total: ${countResult.length} skins`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  try {
    if (args.source === "mineskin") {
      await runMineskinIngestion(args);
    } else {
      await runMojangIngestion(args);
    }
  } finally {
    if (bodyRenderer) {
      await bodyRenderer.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
