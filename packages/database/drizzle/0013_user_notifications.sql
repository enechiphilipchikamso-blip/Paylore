CREATE TABLE "user_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workspace_name" text NOT NULL,
  "recipient_key" text NOT NULL,
  "event_key" text NOT NULL,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "destination" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_notifications_recipient_event_uq" ON "user_notifications" USING btree ("recipient_key","event_key");
--> statement-breakpoint
CREATE INDEX "user_notifications_recipient_read_idx" ON "user_notifications" USING btree ("recipient_key","read_at","created_at");
