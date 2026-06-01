CREATE TABLE `skin_tags` (
	`skin_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`skin_id`, `tag_id`),
	FOREIGN KEY (`skin_id`) REFERENCES `skins`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `skin_tags_tag_id_idx` ON `skin_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `skins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`texture_hash` text NOT NULL,
	`source_username` text,
	`source_uuid` text,
	`model` text NOT NULL,
	`texture` blob NOT NULL,
	`avatar` blob NOT NULL,
	`tex_width` integer,
	`tex_height` integer,
	`description` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skins_slug_unique` ON `skins` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `skins_texture_hash_unique` ON `skins` (`texture_hash`);--> statement-breakpoint
CREATE INDEX `skins_created_at_idx` ON `skins` (`created_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);