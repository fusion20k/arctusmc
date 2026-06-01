ALTER TABLE `skins` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `skins` ADD `usage_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `skins_usage_count_idx` ON `skins` (`usage_count`);