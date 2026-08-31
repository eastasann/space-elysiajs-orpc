CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"category_id" uuid,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"author" text,
	"image_url" text,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "articles_canonical_url_unique" ON "articles" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "articles_fetched_at_idx" ON "articles" USING btree ("fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "articles_category_fetched_at_idx" ON "articles" USING btree ("category_id","fetched_at" DESC NULLS LAST);