import { eq, sql, desc, asc, count, inArray } from "drizzle-orm";
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
    .orderBy(sql`RANDOM()`)
    .limit(n);
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
