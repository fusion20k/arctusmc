import { eq, sql, desc, asc, count, inArray, or, like } from "drizzle-orm";
import { db } from "./client";
import { skins, tags, skinTags } from "./schema";

export interface SkinCardData {
  slug: string;
  display_name: string | null;
  source_username: string | null;
  model: string;
  description: string;
  created_at: number;
  tags: { slug: string; name: string; type: string }[];
}

export interface SkinDetail {
  id: number;
  slug: string;
  texture_hash: string;
  display_name: string | null;
  source_username: string | null;
  source_uuid: string | null;
  model: string;
  tex_width: number | null;
  tex_height: number | null;
  description: string;
  created_at: number;
  tags: { slug: string; name: string; type: string }[];
}

export interface TagSummary {
  slug: string;
  name: string;
  type: string;
  count: number;
}

async function getTagsForSkinIds(
  ids: number[],
): Promise<{ skin_id: number; slug: string; name: string; type: string }[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      skin_id: skinTags.skin_id,
      slug: tags.slug,
      name: tags.name,
      type: tags.type,
    })
    .from(skinTags)
    .innerJoin(tags, eq(skinTags.tag_id, tags.id))
    .where(inArray(skinTags.skin_id, ids));
}

function toCardData(
  skinRows: {
    id: number;
    slug: string;
    display_name: string | null;
    source_username: string | null;
    model: string;
    description: string;
    created_at: number;
  }[],
  tagRows: { skin_id: number; slug: string; name: string; type: string }[],
): SkinCardData[] {
  const tagMap = new Map<number, { slug: string; name: string; type: string }[]>();
  for (const row of tagRows) {
    const existing = tagMap.get(row.skin_id) ?? [];
    existing.push({ slug: row.slug, name: row.name, type: row.type });
    tagMap.set(row.skin_id, existing);
  }
  return skinRows.map((s) => ({
    slug: s.slug,
    display_name: s.display_name,
    source_username: s.source_username,
    model: s.model,
    description: s.description,
    created_at: s.created_at,
    tags: tagMap.get(s.id) ?? [],
  }));
}

export async function getRandomSkins(n: number): Promise<SkinCardData[]> {
  const [{ total }] = await db.select({ total: count() }).from(skins);
  if (total === 0) return [];

  const offsets = new Set<number>();
  while (offsets.size < Math.min(n, total)) {
    offsets.add(Math.floor(Math.random() * total));
  }

  const rowArrays = await Promise.all(
    Array.from(offsets).map((offset) =>
      db
        .select({
          id: skins.id,
          slug: skins.slug,
          display_name: skins.display_name,
          source_username: skins.source_username,
          model: skins.model,
          description: skins.description,
          created_at: skins.created_at,
        })
        .from(skins)
        .orderBy(asc(skins.id))
        .limit(1)
        .offset(offset),
    ),
  );

  const rows = rowArrays.flat().filter((r): r is NonNullable<typeof r> => r !== undefined);
  const tagRows = await getTagsForSkinIds(rows.map((r) => r.id));
  return toCardData(rows, tagRows);
}

export async function getRecentSkins(n: number): Promise<SkinCardData[]> {
  const rows = await db
    .select({
      id: skins.id,
      slug: skins.slug,
      display_name: skins.display_name,
      source_username: skins.source_username,
      model: skins.model,
      description: skins.description,
      created_at: skins.created_at,
    })
    .from(skins)
    .orderBy(desc(skins.created_at))
    .limit(n);
  const tagRows = await getTagsForSkinIds(rows.map((r) => r.id));
  return toCardData(rows, tagRows);
}

export async function getPopularSkins(n: number): Promise<SkinCardData[]> {
  const rows = await db
    .select({
      id: skins.id,
      slug: skins.slug,
      display_name: skins.display_name,
      source_username: skins.source_username,
      model: skins.model,
      description: skins.description,
      created_at: skins.created_at,
    })
    .from(skins)
    .orderBy(desc(skins.usage_count), desc(skins.created_at))
    .limit(n);
  const tagRows = await getTagsForSkinIds(rows.map((r) => r.id));
  return toCardData(rows, tagRows);
}

export async function getSkinBySlug(slug: string): Promise<SkinDetail | null> {
  const rows = await db
    .select({
      id: skins.id,
      slug: skins.slug,
      texture_hash: skins.texture_hash,
      display_name: skins.display_name,
      source_username: skins.source_username,
      source_uuid: skins.source_uuid,
      model: skins.model,
      tex_width: skins.tex_width,
      tex_height: skins.tex_height,
      description: skins.description,
      created_at: skins.created_at,
    })
    .from(skins)
    .where(eq(skins.slug, slug))
    .limit(1);

  if (rows.length === 0) return null;

  const skin = rows[0]!;
  const tagRows = await getTagsForSkinIds([skin.id]);

  return {
    ...skin,
    tags: tagRows.map((t) => ({ slug: t.slug, name: t.name, type: t.type })),
  };
}

export async function getTextureBlob(
  slug: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const rows = await db
    .select({ texture: skins.texture })
    .from(skins)
    .where(eq(skins.slug, slug))
    .limit(1);

  if (rows.length === 0 || !rows[0]!.texture) return null;

  return { bytes: rows[0]!.texture, contentType: "image/png" };
}

export async function getAvatarBlob(
  slug: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const rows = await db
    .select({ avatar: skins.avatar })
    .from(skins)
    .where(eq(skins.slug, slug))
    .limit(1);

  if (rows.length === 0 || !rows[0]!.avatar) return null;

  return { bytes: rows[0]!.avatar, contentType: "image/png" };
}

export async function getSkinsByTag(
  tagSlug: string,
  page: number,
  perPage: number,
): Promise<{ items: SkinCardData[]; total: number; tag: TagSummary | null }> {
  const tagRows = await db
    .select()
    .from(tags)
    .where(eq(tags.slug, tagSlug))
    .limit(1);

  if (tagRows.length === 0) {
    return { items: [], total: 0, tag: null };
  }

  const tag = tagRows[0]!;

  const [countResult, skinRows] = await Promise.all([
    db
      .select({ total: count() })
      .from(skinTags)
      .where(eq(skinTags.tag_id, tag.id)),
    db
      .select({
        id: skins.id,
        slug: skins.slug,
        display_name: skins.display_name,
        source_username: skins.source_username,
        model: skins.model,
        description: skins.description,
        created_at: skins.created_at,
      })
      .from(skins)
      .innerJoin(skinTags, eq(skins.id, skinTags.skin_id))
      .where(eq(skinTags.tag_id, tag.id))
      .orderBy(desc(skins.created_at))
      .limit(perPage)
      .offset((page - 1) * perPage),
  ]);

  const total = countResult[0]?.total ?? 0;
  const tagRowsForSkins = await getTagsForSkinIds(skinRows.map((r) => r.id));
  const items = toCardData(skinRows, tagRowsForSkins);

  return {
    items,
    total,
    tag: { slug: tag.slug, name: tag.name, type: tag.type, count: total },
  };
}

// Simple synonym map: when a user searches one term, also try these.
// Keep small and obvious — false positives are worse than misses.
const SEARCH_SYNONYMS: Record<string, string[]> = {
  slime: ["green"],
  grass: ["green"],
  frog: ["green"],
  zombie: ["green"],
  creeper: ["green"],
  lava: ["orange", "red"],
  fire: ["orange", "red"],
  water: ["blue"],
  ocean: ["blue"],
  sky: ["blue"],
  ice: ["white", "blue"],
  snow: ["white"],
  ghost: ["white"],
  shadow: ["black"],
  night: ["black"],
  dark: ["black"],
  void: ["black"],
  ender: ["black"],
  gold: ["yellow"],
  honey: ["yellow"],
  sun: ["yellow"],
  rose: ["red", "pink"],
  blood: ["red"],
  king: ["yellow"],
  queen: ["pink"],
  princess: ["pink"],
  knight: ["gray", "white"],
  steel: ["gray"],
  iron: ["gray"],
  stone: ["gray"],
  diamond: ["blue"],
  emerald: ["green"],
  ruby: ["red"],
  rainbow: ["colorful"],
  girl: ["slim"],
  female: ["slim"],
  woman: ["slim"],
  boy: ["classic"],
  male: ["classic"],
  man: ["classic"],
};

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokensFor(raw: string): string[] {
  const norm = normalizeQuery(raw);
  if (!norm) return [];
  const base = norm.split(/\s+/).filter((t) => t.length >= 2);
  const expanded = new Set<string>(base);
  for (const tok of base) {
    const syns = SEARCH_SYNONYMS[tok];
    if (syns) syns.forEach((s) => expanded.add(s));
  }
  return Array.from(expanded);
}

export async function searchSkins(
  rawQuery: string,
  page: number,
  perPage: number,
): Promise<{
  items: SkinCardData[];
  total: number;
  matchedTags: TagSummary[];
  query: string;
}> {
  const normalized = normalizeQuery(rawQuery);
  const toks = tokensFor(rawQuery);

  if (toks.length === 0) {
    return { items: [], total: 0, matchedTags: [], query: normalized };
  }

  // Find all matching tags (slug LIKE %tok% OR name LIKE %tok% for any token).
  const tagConds = toks.flatMap((t) => [
    like(tags.slug, `%${t}%`),
    like(sql`lower(${tags.name})`, `%${t}%`),
  ]);
  const tagMatches = await db
    .select({ id: tags.id, slug: tags.slug, name: tags.name, type: tags.type })
    .from(tags)
    .where(or(...tagConds)!)
    .limit(50);

  const tagIds = tagMatches.map((t) => t.id);

  // Collect candidate skin IDs from two sources:
  // (a) skins linked to any matching tag
  // (b) skins whose description/source_username/display_name match the raw phrase
  //     or any single token (we OR everything together).
  const skinTextConds = toks.flatMap((t) => [
    like(sql`lower(${skins.description})`, `%${t}%`),
    like(sql`lower(${skins.source_username})`, `%${t}%`),
    like(sql`lower(${skins.display_name})`, `%${t}%`),
    like(skins.slug, `%${t}%`),
  ]);

  const idSet = new Set<number>();

  if (tagIds.length > 0) {
    const tagSkinRows = await db
      .select({ skin_id: skinTags.skin_id })
      .from(skinTags)
      .where(inArray(skinTags.tag_id, tagIds));
    for (const r of tagSkinRows) idSet.add(r.skin_id);
  }

  if (skinTextConds.length > 0) {
    const textRows = await db
      .select({ id: skins.id })
      .from(skins)
      .where(or(...skinTextConds)!)
      .limit(2000);
    for (const r of textRows) idSet.add(r.id);
  }

  const allIds = Array.from(idSet);
  const total = allIds.length;

  if (total === 0) {
    return {
      items: [],
      total: 0,
      matchedTags: tagMatches.map((t) => ({
        slug: t.slug, name: t.name, type: t.type, count: 0,
      })),
      query: normalized,
    };
  }

  // Pull the page of skins, ordered by created_at desc for stability.
  const pageRows = await db
    .select({
      id: skins.id,
      slug: skins.slug,
      display_name: skins.display_name,
      source_username: skins.source_username,
      model: skins.model,
      description: skins.description,
      created_at: skins.created_at,
    })
    .from(skins)
    .where(inArray(skins.id, allIds))
    .orderBy(desc(skins.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  const tagRowsForSkins = await getTagsForSkinIds(pageRows.map((r) => r.id));
  const items = toCardData(pageRows, tagRowsForSkins);

  // Aggregate counts for matched tags (best-effort, single query).
  let matchedTags: TagSummary[] = [];
  if (tagIds.length > 0) {
    const countRows = await db
      .select({ tag_id: skinTags.tag_id, c: count() })
      .from(skinTags)
      .where(inArray(skinTags.tag_id, tagIds))
      .groupBy(skinTags.tag_id);
    const countMap = new Map(countRows.map((r) => [r.tag_id, r.c]));
    matchedTags = tagMatches
      .map((t) => ({
        slug: t.slug, name: t.name, type: t.type, count: countMap.get(t.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }

  return { items, total, matchedTags, query: normalized };
}

export async function listTags(): Promise<TagSummary[]> {
  const rows = await db
    .select({
      slug: tags.slug,
      name: tags.name,
      type: tags.type,
      total: count(skinTags.skin_id),
    })
    .from(tags)
    .leftJoin(skinTags, eq(tags.id, skinTags.tag_id))
    .groupBy(tags.id)
    .orderBy(desc(count(skinTags.skin_id)));

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    type: r.type,
    count: r.total,
  }));
}

export async function countSkins(): Promise<number> {
  const result = await db.select({ total: count() }).from(skins);
  return result[0]?.total ?? 0;
}

export async function getSlugsPage(page: number, size: number): Promise<string[]> {
  const rows = await db
    .select({ slug: skins.slug })
    .from(skins)
    .orderBy(asc(skins.created_at))
    .limit(size)
    .offset(page * size);

  return rows.map((r) => r.slug);
}
