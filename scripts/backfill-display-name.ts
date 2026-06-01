import { isNull, eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { skins, tags, skinTags } from "../src/lib/db/schema.js";
import { generateDisplayName } from "../src/lib/description.js";

async function main() {
  const rows = await db
    .select({
      id: skins.id,
      texture_hash: skins.texture_hash,
      model: skins.model,
      display_name: skins.display_name,
    })
    .from(skins)
    .where(isNull(skins.display_name));

  console.log(`Backfilling display_name for ${rows.length} skins without one...`);

  if (rows.length === 0) {
    console.log("All skins already have display_name. Done.");
    return;
  }

  const skinIds = rows.map((r) => r.id);
  const tagRows = await db
    .select({
      skin_id: skinTags.skin_id,
      slug: tags.slug,
      type: tags.type,
    })
    .from(skinTags)
    .innerJoin(tags, eq(skinTags.tag_id, tags.id))
    .where(inArray(skinTags.skin_id, skinIds));

  const tagMap = new Map<number, { slug: string; type: string }[]>();
  for (const row of tagRows) {
    const existing = tagMap.get(row.skin_id) ?? [];
    existing.push({ slug: row.slug, type: row.type });
    tagMap.set(row.skin_id, existing);
  }

  let updated = 0;
  let failed = 0;
  const BATCH = 50;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (row) => {
        try {
          const colorTags = (tagMap.get(row.id) ?? []).filter(
            (t) => t.type === "color",
          );
          const model = (row.model as "classic" | "slim") === "slim" ? "slim" : "classic";
          const displayName = generateDisplayName(model, colorTags, row.texture_hash);
          await db
            .update(skins)
            .set({ display_name: displayName })
            .where(eq(skins.id, row.id));
          updated++;
        } catch (e) {
          failed++;
          console.warn(`  Failed for id=${row.id}: ${(e as Error).message}`);
        }
      }),
    );
    if ((i + BATCH) % 500 === 0 || i + BATCH >= rows.length) {
      console.log(`  Updated ${updated}/${rows.length}...`);
    }
  }

  console.log(`Done. updated=${updated} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
