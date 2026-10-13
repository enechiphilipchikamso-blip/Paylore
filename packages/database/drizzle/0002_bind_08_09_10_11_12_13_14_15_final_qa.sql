CREATE TABLE "contributor_confidential_accounts" (
	"contributor_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_wallet_address" text NOT NULL,
	"token_account_address" text NOT NULL,
	"status" text DEFAULT 'setup_pending' NOT NULL,
	"setup_transaction_signature" text,
	"close_transaction_signature" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributor_offboarding" (
	"contributor_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"manual_account_close" boolean,
	"close_transaction_signature" text,
	"automatic_cleanup_eligible_at" timestamp with time zone,
	"association_removed_at" timestamp with time zone,
	"status" text DEFAULT 'requested' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gas_tank_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation_type" text NOT NULL,
	"request_digest" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"transaction_signature" text,
	"fee_lamports" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"amount_base_units" text NOT NULL,
	"claim_id" text NOT NULL,
	"claim_address" text,
	"status" text DEFAULT 'unclaimed' NOT NULL,
	"transaction_signature" text,
	"claimed_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reason_note" text,
	"status" text DEFAULT 'prepared' NOT NULL,
	"transaction_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"import_digest" text NOT NULL,
	"allocation_commitment" text,
	"total_amount_base_units" text NOT NULL,
	"status" text DEFAULT 'awaiting_confirmation' NOT NULL,
	"submission_signature" text,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solana_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"transaction_signature" text,
	"account_address" text,
	"event_type" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"transaction_slot" text,
	"finalized_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_gas_tanks" (
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
	"balance_lamports" text DEFAULT '0' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"category" text NOT NULL,
	"entry_type" text NOT NULL,
	"status" text NOT NULL,
	"amount_base_units" text,
	"mint" text,
	"reference_type" text,
	"reference_id" text,
	"transaction_signature" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
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
CREATE TABLE "workspace_retention" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deletion_scheduled_at" timestamp with time zone,
	"deletion_canceled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_notice_day" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributor_confidential_accounts" ADD CONSTRAINT "contributor_confidential_accounts_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_confidential_accounts" ADD CONSTRAINT "contributor_confidential_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_offboarding" ADD CONSTRAINT "contributor_offboarding_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_offboarding" ADD CONSTRAINT "contributor_offboarding_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gas_tank_operations" ADD CONSTRAINT "gas_tank_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_recoveries" ADD CONSTRAINT "payroll_recoveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_recoveries" ADD CONSTRAINT "payroll_recoveries_allocation_id_payroll_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."payroll_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_recoveries" ADD CONSTRAINT "payroll_recoveries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_gas_tanks" ADD CONSTRAINT "workspace_gas_tanks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_ledger_entries" ADD CONSTRAINT "workspace_ledger_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_notifications" ADD CONSTRAINT "workspace_notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_retention" ADD CONSTRAINT "workspace_retention_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "confidential_accounts_token_account_uq" ON "contributor_confidential_accounts" USING btree ("token_account_address");--> statement-breakpoint
CREATE INDEX "confidential_accounts_workspace_status_idx" ON "contributor_confidential_accounts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "contributor_offboarding_workspace_status_idx" ON "contributor_offboarding" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "contributor_offboarding_cleanup_idx" ON "contributor_offboarding" USING btree ("automatic_cleanup_eligible_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gas_tank_operations_workspace_idempotency_uq" ON "gas_tank_operations" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gas_tank_operations_workspace_created_idx" ON "gas_tank_operations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_allocations_run_claim_uq" ON "payroll_allocations" USING btree ("payroll_run_id","claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_allocations_claim_address_uq" ON "payroll_allocations" USING btree ("claim_address");--> statement-breakpoint
CREATE INDEX "payroll_allocations_workspace_status_idx" ON "payroll_allocations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "payroll_allocations_contributor_idx" ON "payroll_allocations" USING btree ("contributor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_recoveries_allocation_uq" ON "payroll_recoveries" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "payroll_recoveries_workspace_created_idx" ON "payroll_recoveries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_workspace_idempotency_uq" ON "payroll_runs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payroll_runs_workspace_created_idx" ON "payroll_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "solana_webhook_events_provider_event_uq" ON "solana_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "solana_webhook_events_status_retry_idx" ON "solana_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "solana_webhook_events_signature_idx" ON "solana_webhook_events" USING btree ("transaction_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_gas_tanks_address_uq" ON "workspace_gas_tanks" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_ledger_workspace_idempotency_uq" ON "workspace_ledger_entries" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workspace_ledger_workspace_created_idx" ON "workspace_ledger_entries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_ledger_workspace_category_idx" ON "workspace_ledger_entries" USING btree ("workspace_id","category","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_notifications_event_recipient_uq" ON "workspace_notifications" USING btree ("workspace_id","event_key","recipient_key");--> statement-breakpoint
CREATE INDEX "workspace_notifications_recipient_read_idx" ON "workspace_notifications" USING btree ("recipient_key","read_at","created_at");--> statement-breakpoint
CREATE INDEX "workspace_retention_activity_idx" ON "workspace_retention" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "workspace_retention_deletion_idx" ON "workspace_retention" USING btree ("deletion_scheduled_at");