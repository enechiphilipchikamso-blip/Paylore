CREATE TABLE "workspace_deletion_audit" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"outcome" text DEFAULT 'not_requested' NOT NULL,
	"blocker_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
