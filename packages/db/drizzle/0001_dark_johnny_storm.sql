CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"feed_url" text NOT NULL,
	"site_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_feed_url_unique" ON "sources" USING btree ("feed_url");--> statement-breakpoint
CREATE INDEX "sources_active_idx" ON "sources" USING btree ("is_active") WHERE "sources"."is_active" = true;