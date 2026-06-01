import { eq, and, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../src/lib/db/client.js";
import { skins, tags, skinTags } from "../src/lib/db/schema.js";

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

    for (let y = 16; y < 20; y++) {
      for (const x of [50, 51]) {
        if (isTransparent(x, y)) slimVotes++;
        else classicVotes++;
      }
    }
    for (let y = 48; y < 52; y++) {
      for (const x of [42, 43]) {
        if (isTransparent(x, y)) slimVotes++;
        else classicVotes++;
      }
    }
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

async function main() {
  const classicTag = await db
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.slug, "classic"))
    .limit(1);
  const slimTag = await db
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.slug, "slim"))
    .limit(1);

  if (classicTag.length === 0) {
    await db.insert(tags).values({ slug: "classic", name: "Classic", type: "model" }).onConflictDoNothing();
  }
  if (slimTag.length === 0) {
    await db.insert(tags).values({ slug: "slim", name: "Slim", type: "model" }).onConflictDoNothing();
  }

  const classicTagId = (
    await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, "classic")).limit(1)
  )[0]!.id;
  const slimTagId = (
    await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, "slim")).limit(1)
  )[0]!.id;

  const rows = await db
    .select({ id: skins.id, slug: skins.slug, model: skins.model, texture: skins.texture })
    .from(skins);

  console.log(`Re-detecting model for ${rows.length} skins...`);

  let changed = 0;
  let kept = 0;
  let errors = 0;
  let i = 0;

  for (const row of rows) {
    i++;
    try {
      const tex = Buffer.from(row.texture as Uint8Array);
      const detected = await detectModel(tex);
      if (detected !== row.model) {
        await db.update(skins).set({ model: detected }).where(eq(skins.id, row.id));

        const oldTagId = row.model === "slim" ? slimTagId : classicTagId;
        const newTagId = detected === "slim" ? slimTagId : classicTagId;

        await db
          .delete(skinTags)
          .where(and(eq(skinTags.skin_id, row.id), inArray(skinTags.tag_id, [oldTagId, newTagId])));
        await db
          .insert(skinTags)
          .values({ skin_id: row.id, tag_id: newTagId })
          .onConflictDoNothing();

        changed++;
        if (changed % 50 === 0) {
          console.log(`  ${i}/${rows.length} changed=${changed} kept=${kept}`);
        }
      } else {
        kept++;
      }
    } catch (e) {
      errors++;
      console.warn(`  err ${row.slug}: ${(e as Error).message}`);
    }
  }

  console.log(`\nDone. changed=${changed} kept=${kept} errors=${errors}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
