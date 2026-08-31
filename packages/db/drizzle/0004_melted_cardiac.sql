ALTER TABLE "sources" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_modified" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_error" text;