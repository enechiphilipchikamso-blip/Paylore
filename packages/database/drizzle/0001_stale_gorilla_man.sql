CREATE TYPE "public"."contributor_lifecycle" AS ENUM('invited', 'active', 'left');--> statement-breakpoint
CREATE TYPE "public"."contributor_onboarding_status" AS ENUM('pending', 'complete', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('inactive', 'active', 'cancel_scheduled', 'archived');--> statement-breakpoint
CREATE TABLE "contributor_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributor_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"identity_wallet_address" text NOT NULL,
	"effective_payout_address" text NOT NULL,
	"role" "workspace_role" DEFAULT 'contributor' NOT NULL,
	"lifecycle" "contributor_lifecycle" DEFAULT 'invited' NOT NULL,
	"onboarding_status" "contributor_onboarding_status" DEFAULT 'pending' NOT NULL,
	"organization_label" text,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"mint" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_base_units" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_reserves" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"private_key_nonce" text NOT NULL,
	"private_key_auth_tag" text NOT NULL,
	"encrypted_data_key" text NOT NULL,
	"data_key_nonce" text NOT NULL,
	"data_key_auth_tag" text NOT NULL,
	"encrypted_backup" text NOT NULL,
	"backup_nonce" text NOT NULL,
	"backup_auth_tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"status" "subscription_status" DEFAULT 'inactive' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributor_invitations" ADD CONSTRAINT "contributor_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invitations" ADD CONSTRAINT "contributor_invitations_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invitations" ADD CONSTRAINT "contributor_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_reserves" ADD CONSTRAINT "workspace_reserves_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contributor_invitations_workspace_id_idx" ON "contributor_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contributor_invitations_expires_at_idx" ON "contributor_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contributors_workspace_identity_wallet_uq" ON "contributors" USING btree ("workspace_id","identity_wallet_address");--> statement-breakpoint
CREATE INDEX "contributors_workspace_lifecycle_idx" ON "contributors" USING btree ("workspace_id","lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_signature_uq" ON "subscription_payments" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "subscription_payments_workspace_created_idx" ON "subscription_payments" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_reserves_address_uq" ON "workspace_reserves" USING btree ("address");--> statement-breakpoint
CREATE INDEX "workspace_subscriptions_status_period_end_idx" ON "workspace_subscriptions" USING btree ("status","period_end");