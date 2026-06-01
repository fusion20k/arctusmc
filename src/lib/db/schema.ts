import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const skins = sqliteTable(
  "skins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").unique().notNull(),
    texture_hash: text("texture_hash").unique().notNull(),
    source_username: text("source_username"),
    source_uuid: text("source_uuid"),
    model: text("model").notNull(),
    texture: blob("texture", { mode: "buffer" }).notNull(),
    avatar: blob("avatar", { mode: "buffer" }).notNull(),
    tex_width: integer("tex_width"),
    tex_height: integer("tex_height"),
    description: text("description").notNull(),
    display_name: text("display_name"),
    usage_count: integer("usage_count").notNull().default(1),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("skins_created_at_idx").on(table.created_at),
    index("skins_usage_count_idx").on(table.usage_count),
  ],
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").unique().notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
});

export const skinTags = sqliteTable(
  "skin_tags",
  {
    skin_id: integer("skin_id")
      .notNull()
      .references(() => skins.id),
    tag_id: integer("tag_id")
      .notNull()
      .references(() => tags.id),
  },
  (table) => [
    primaryKey({ columns: [table.skin_id, table.tag_id] }),
    index("skin_tags_tag_id_idx").on(table.tag_id),
  ],
);
