CREATE TABLE `bf_spread` (
	`run_id` text NOT NULL,
	`country_id` text NOT NULL,
	`t` integer NOT NULL,
	PRIMARY KEY(`run_id`, `country_id`, `t`),
	FOREIGN KEY (`run_id`) REFERENCES `sim_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `character` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`lifespan_start` text,
	`lifespan_start_precision` text,
	`lifespan_end` text,
	`lifespan_end_precision` text,
	`role` text NOT NULL,
	`bio` text,
	`portrait_path` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "character_name_non_empty_check" CHECK("character"."name" <> ''),
	CONSTRAINT "character_lifespan_start_format_check" CHECK("character"."lifespan_start" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "character_lifespan_end_format_check" CHECK("character"."lifespan_end" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "character_lifespan_order_check" CHECK("character"."lifespan_end" >= "character"."lifespan_start"),
	CONSTRAINT "character_lifespan_start_precision_check" CHECK("character"."lifespan_start_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "character_lifespan_end_precision_check" CHECK("character"."lifespan_end_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "character_lifespan_start_pair_check" CHECK(("character"."lifespan_start" is null) = ("character"."lifespan_start_precision" is null)),
	CONSTRAINT "character_lifespan_end_pair_check" CHECK(("character"."lifespan_end" is null) = ("character"."lifespan_end_precision" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_save_id_id_unique` ON `character` (`save_id`,`id`);--> statement-breakpoint
CREATE TABLE `character_relation` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`from_character_id` text NOT NULL,
	`to_character_id` text NOT NULL,
	`type` text NOT NULL,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`from_character_id`) REFERENCES `character`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`to_character_id`) REFERENCES `character`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "character_relation_type_check" CHECK("character_relation"."type" in ('parent-of', 'sibling-of', 'spouse-of', 'clone-of')),
	CONSTRAINT "character_relation_not_self_check" CHECK("character_relation"."from_character_id" <> "character_relation"."to_character_id"),
	CONSTRAINT "character_relation_canonical_order_check" CHECK("character_relation"."type" not in ('sibling-of', 'spouse-of') or "character_relation"."from_character_id" < "character_relation"."to_character_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_relation_edge_unique` ON `character_relation` (`save_id`,`from_character_id`,`to_character_id`,`type`);--> statement-breakpoint
CREATE TABLE `country` (
	`id` text PRIMARY KEY NOT NULL,
	`iso_numeric` text(3),
	`alpha3` text(3),
	`name` text NOT NULL,
	`geometry_source` text NOT NULL,
	CONSTRAINT "country_geometry_source_check" CHECK("country"."geometry_source" in ('feature', 'derived'))
);
--> statement-breakpoint
CREATE TABLE `country_override` (
	`save_id` text NOT NULL,
	`country_id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`save_id`, `country_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `country_projection` (
	`run_id` text NOT NULL,
	`country_id` text NOT NULL,
	`year` integer NOT NULL,
	`pop` real NOT NULL,
	`gdp_real` real NOT NULL,
	`gdp_pc` real NOT NULL,
	`sector_mix_json` text NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `country_id`, `year`),
	FOREIGN KEY (`run_id`) REFERENCES `sim_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "country_projection_computed_at_format_check" CHECK("country_projection"."computed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "country_projection_sector_mix_json_check" CHECK(json_valid("country_projection"."sector_mix_json") and json_type("country_projection"."sector_mix_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`when_min` text NOT NULL,
	`when_max` text NOT NULL,
	`when_precision` text NOT NULL,
	`when` text NOT NULL,
	`range_before_event_id` text,
	`range_after_event_id` text,
	`category` text NOT NULL,
	`tech_lane` text,
	`location_id` text,
	`project_id` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`range_before_event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`range_after_event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`location_id`) REFERENCES `location`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`project_id`) REFERENCES `project`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_when_min_format_check" CHECK("event"."when_min" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "event_when_max_format_check" CHECK("event"."when_max" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "event_when_format_check" CHECK("event"."when" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "event_when_order_check" CHECK("event"."when_max" >= "event"."when_min"),
	CONSTRAINT "event_when_in_window_check" CHECK("event"."when" between "event"."when_min" and "event"."when_max"),
	CONSTRAINT "event_when_precision_check" CHECK("event"."when_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "event_category_check" CHECK("event"."category" in ('tech', 'political', 'military', 'disaster', 'scientific', 'cultural', 'personal')),
	CONSTRAINT "event_tech_lane_check" CHECK("event"."tech_lane" in ('energy', 'propulsion', 'computing', 'neural', 'biomedical', 'megastructure')),
	CONSTRAINT "event_tech_lane_requires_tech_check" CHECK("event"."tech_lane" is null or "event"."category" = 'tech'),
	CONSTRAINT "event_not_self_range_before_check" CHECK("event"."id" <> "event"."range_before_event_id"),
	CONSTRAINT "event_not_self_range_after_check" CHECK("event"."id" <> "event"."range_after_event_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_save_id_id_unique` ON `event` (`save_id`,`id`);--> statement-breakpoint
CREATE TABLE `event_actor` (
	`save_id` text NOT NULL,
	`event_id` text NOT NULL,
	`character_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`event_id`, `character_id`, `role`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`character_id`) REFERENCES `character`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_actor_role_normalized_check" CHECK("event_actor"."role" <> '' and "event_actor"."role" = lower(trim("event_actor"."role")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_actor_lifespan_role_unique` ON `event_actor` (`save_id`,`character_id`,`role`) WHERE "event_actor"."role" in ('born', 'died');--> statement-breakpoint
CREATE TABLE `event_tag` (
	`save_id` text NOT NULL,
	`event_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `tag_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `grouping` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grouping_save_id_id_unique` ON `grouping` (`save_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `grouping_save_id_name_unique` ON `grouping` (`save_id`,`name`);--> statement-breakpoint
CREATE TABLE `grouping_country` (
	`save_id` text NOT NULL,
	`grouping_id` text NOT NULL,
	`country_id` text NOT NULL,
	`is_leader` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`save_id`, `country_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`grouping_id`) REFERENCES `grouping`(`save_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grouping_country_leader_unique` ON `grouping_country` (`save_id`,`grouping_id`) WHERE "grouping_country"."is_leader" = 1;--> statement-breakpoint
CREATE TABLE `grouping_metrics` (
	`save_id` text NOT NULL,
	`run_id` text NOT NULL,
	`grouping_id` text NOT NULL,
	`pop` real NOT NULL,
	`gdp_real` real NOT NULL,
	`gdp_pc` real NOT NULL,
	`sector_mix_json` text NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`save_id`, `run_id`, `grouping_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `sim_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`grouping_id`) REFERENCES `grouping`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grouping_metrics_sector_mix_json_check" CHECK(json_valid("grouping_metrics"."sector_mix_json") and json_type("grouping_metrics"."sector_mix_json") = 'object'),
	CONSTRAINT "grouping_metrics_computed_at_format_check" CHECK("grouping_metrics"."computed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `location` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`lat` real,
	`lng` real,
	`country_id` text,
	`grouping_id` text,
	`superseded_by_location_id` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`grouping_id`) REFERENCES `grouping`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`superseded_by_location_id`) REFERENCES `location`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "location_map_ref_check" CHECK("location"."country_id" is null or "location"."grouping_id" is null),
	CONSTRAINT "location_not_self_superseded_check" CHECK("location"."id" <> "location"."superseded_by_location_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_save_id_id_unique` ON `location` (`save_id`,`id`);--> statement-breakpoint
CREATE TABLE `manifest` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`title` text NOT NULL,
	`items_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manifest_items_json_check" CHECK(json_valid("manifest"."items_json") and json_type("manifest"."items_json") = 'array'),
	CONSTRAINT "manifest_created_at_format_check" CHECK("manifest"."created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "manifest_updated_at_format_check" CHECK("manifest"."updated_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `nation_horizontal` (
	`save_id` text NOT NULL,
	`run_id` text NOT NULL,
	`country_id` text NOT NULL,
	`horizontal` text NOT NULL,
	`score` real NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`save_id`, `run_id`, `country_id`, `horizontal`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `sim_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nation_horizontal_computed_at_format_check" CHECK("nation_horizontal"."computed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`date_start` text,
	`date_start_precision` text,
	`date_end` text,
	`date_end_precision` text,
	`status` text NOT NULL,
	`lead_character_id` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`lead_character_id`) REFERENCES `character`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_status_check" CHECK("project"."status" in ('planned', 'active', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "project_date_start_format_check" CHECK("project"."date_start" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "project_date_end_format_check" CHECK("project"."date_end" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "project_date_order_check" CHECK("project"."date_end" >= "project"."date_start"),
	CONSTRAINT "project_date_start_precision_check" CHECK("project"."date_start_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "project_date_end_precision_check" CHECK("project"."date_end_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "project_date_start_pair_check" CHECK(("project"."date_start" is null) = ("project"."date_start_precision" is null)),
	CONSTRAINT "project_date_end_pair_check" CHECK(("project"."date_end" is null) = ("project"."date_end_precision" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_save_id_id_unique` ON `project` (`save_id`,`id`);--> statement-breakpoint
CREATE TABLE `relation` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`from_event_id` text NOT NULL,
	`to_event_id` text NOT NULL,
	`type` text NOT NULL,
	`note` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`from_event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`to_event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "relation_type_check" CHECK("relation"."type" in ('precedes', 'partOf', 'renames')),
	CONSTRAINT "relation_not_self_check" CHECK("relation"."from_event_id" <> "relation"."to_event_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relation_edge_unique` ON `relation` (`save_id`,`from_event_id`,`to_event_id`,`type`);--> statement-breakpoint
CREATE TABLE `save` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	`parent_save_id` text,
	`is_archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`parent_save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "save_id_non_empty_check" CHECK("save"."id" <> ''),
	CONSTRAINT "save_name_non_empty_check" CHECK("save"."name" <> ''),
	CONSTRAINT "save_created_at_format_check" CHECK("save"."created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "save_not_self_parent_check" CHECK("save"."id" <> "save"."parent_save_id")
);
--> statement-breakpoint
CREATE TABLE `sim_run` (
	`id` text PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`save_id` text,
	`params_json` text NOT NULL,
	`input_run_ids_json` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sim_run_params_json_check" CHECK(json_valid("sim_run"."params_json") and json_type("sim_run"."params_json") = 'object'),
	CONSTRAINT "sim_run_input_run_ids_json_check" CHECK(json_valid("sim_run"."input_run_ids_json") and json_type("sim_run"."input_run_ids_json") = 'array'),
	CONSTRAINT "sim_run_started_at_format_check" CHECK("sim_run"."started_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "sim_run_finished_at_format_check" CHECK("sim_run"."finished_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `source_series` (
	`source` text NOT NULL,
	`country_id` text NOT NULL,
	`indicator` text NOT NULL,
	`year` integer NOT NULL,
	`value` real NOT NULL,
	`fetched_at` text NOT NULL,
	`vintage` text NOT NULL,
	PRIMARY KEY(`source`, `country_id`, `indicator`, `year`, `vintage`),
	FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_series_fetched_at_format_check" CHECK("source_series"."fetched_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`is_retired` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_unique` ON `tag` (`name`);--> statement-breakpoint
CREATE TABLE `timeline` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`description` text,
	`membership_rules` text,
	`color` text,
	`era_start` text,
	`era_start_precision` text,
	`era_end` text,
	`era_end_precision` text,
	`project_id` text,
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`project_id`) REFERENCES `project`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "timeline_kind_check" CHECK("timeline"."kind" in ('era', 'thread', 'cluster')),
	CONSTRAINT "timeline_era_bounds_check" CHECK("timeline"."kind" <> 'era' or "timeline"."era_start" is not null),
	CONSTRAINT "timeline_era_start_format_check" CHECK("timeline"."era_start" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "timeline_era_end_format_check" CHECK("timeline"."era_end" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "timeline_era_order_check" CHECK("timeline"."era_end" >= "timeline"."era_start"),
	CONSTRAINT "timeline_era_start_precision_check" CHECK("timeline"."era_start_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "timeline_era_end_precision_check" CHECK("timeline"."era_end_precision" in ('time', 'day', 'month', 'season', 'year', 'decade')),
	CONSTRAINT "timeline_era_start_pair_check" CHECK(("timeline"."era_start" is null) = ("timeline"."era_start_precision" is null)),
	CONSTRAINT "timeline_era_end_pair_check" CHECK(("timeline"."era_end" is null) = ("timeline"."era_end_precision" is null)),
	CONSTRAINT "timeline_membership_rules_json_check" CHECK(json_valid("timeline"."membership_rules") and json_type("timeline"."membership_rules") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timeline_save_id_id_unique` ON `timeline` (`save_id`,`id`);--> statement-breakpoint
CREATE TABLE `timeline_member` (
	`save_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`timeline_id`, `event_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`timeline_id`) REFERENCES `timeline`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`event_id`) REFERENCES `event`(`save_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `timeline_parent` (
	`save_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`parent_id` text NOT NULL,
	PRIMARY KEY(`timeline_id`, `parent_id`),
	FOREIGN KEY (`save_id`) REFERENCES `save`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`timeline_id`) REFERENCES `timeline`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`save_id`,`parent_id`) REFERENCES `timeline`(`save_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "timeline_parent_not_self_check" CHECK("timeline_parent"."timeline_id" <> "timeline_parent"."parent_id")
);
