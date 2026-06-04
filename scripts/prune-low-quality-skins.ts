import { inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { skins, skinTags } from "../src/lib/db/schema.js";
import { analyzeBodyQuality } from "../src/lib/texture-quality.js";

const PAGE_SIZE = 200;
const DELETE_CHUNK_SIZE = 200;
const MAX_BODY_BLACK_FRACTION = 0.85;
const MIN_BODY_UNIQUE_COLORS = 3;

type SkinRow = {
  id: number;
  slug: string;
  texture: Uint8Array;
};

function parseArgs(): { apply: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply || args.includes("--dry-run");
  return { apply, dryRun };
}

async function main() {
  const { dryRun } = parseArgs();
  console.log(`Pruning low-quality skins mode=${dryRun ? "dry-run" : "apply"}`);

  const offenderIds: number[] = [];
  let scanned = 0;
  let invalid = 0;
  let byBlack = 0;
  let byUniform = 0;
  let byBoth = 0;
  let offset = 0;

  while (true) {
    const page = (await db
      .select({
        id: skins.id,
        slug: skins.slug,
        texture: skins.texture,
      })
      .from(skins)
      .limit(PAGE_SIZE)
      .offset(offset)) as SkinRow[];

    if (page.length === 0) break;

    for (const row of page) {
      const stats = await analyzeBodyQuality(Buffer.from(row.texture));
      scanned++;

      if (!stats) {
        invalid++;
        continue;
      }

      const isBlack = stats.bodyBlackFraction > MAX_BODY_BLACK_FRACTION;
      const isUniform = stats.bodyUniqueColors <= MIN_BODY_UNIQUE_COLORS;

      if (isBlack || isUniform) {
        offenderIds.push(row.id);
        if (isBlack && isUniform) byBoth++;
        else if (isBlack) byBlack++;
        else byUniform++;
      }
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (scanned % 1000 === 0) {
      console.log(`  scanned=${scanned} offenders=${offenderIds.length}`);
    }
  }

  console.log(`Scanned skins: ${scanned}`);
  console.log(`Invalid texture dimensions: ${invalid}`);
  console.log(`Offenders total: ${offenderIds.length}`);
  console.log(`  black-only: ${byBlack}`);
  console.log(`  uniform-only: ${byUniform}`);
  console.log(`  both: ${byBoth}`);

  if (offenderIds.length === 0) {
    console.log("No low-quality skins found.");
    return;
  }

  if (dryRun) {
    console.log(`Dry-run: would delete ${offenderIds.length} skins.`);
    return;
  }

  let deleted = 0;
  for (let i = 0; i < offenderIds.length; i += DELETE_CHUNK_SIZE) {
    const ids = offenderIds.slice(i, i + DELETE_CHUNK_SIZE);
    await db.delete(skinTags).where(inArray(skinTags.skin_id, ids));
    await db.delete(skins).where(inArray(skins.id, ids));
    deleted += ids.length;
    console.log(`  deleted=${deleted}/${offenderIds.length}`);
  }

  console.log(`Deleted skins: ${deleted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
