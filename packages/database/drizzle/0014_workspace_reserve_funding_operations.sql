CREATE TABLE "workspace_reserve_funding_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "active_workspace_id" uuid,
  "wallet_address" text NOT NULL,
  "wrap_signature" text NOT NULL,
  "amount_base_units" text NOT NULL,
  "status" text DEFAULT 'wrap_verified' NOT NULL,
  "wrap_public_balance_before" text,
  "wrap_public_balance_after" text,
  "deposit_signature" text,
  "deposit_blockhash" text,
  "deposit_last_valid_block_height" text,
  "apply_signature" text,
  "apply_blockhash" text,
  "apply_last_valid_block_height" text,
  "apply_instruction_data" text,
  "apply_instruction_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "public_balance_before" text,
  "public_balance_after" text,
  "pending_balance_before" text,
  "pending_balance_after" text,
  "available_balance_before" text,
  "available_balance_after" text,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "workspace_reserve_funding_operations_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "workspace_reserve_funding_status"
    CHECK ("status" IN ('wrap_verified', 'deposit_building', 'deposit_pending', 'deposit_finalized', 'apply_building', 'apply_pending', 'completed', 'failed')),
  CONSTRAINT "workspace_reserve_funding_amount"
    CHECK ("amount_base_units" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "workspace_reserve_funding_balance_format"
    CHECK (
      ("wrap_public_balance_before" IS NULL OR "wrap_public_balance_before" ~ '^(0|[1-9][0-9]*)$') AND
      ("wrap_public_balance_after" IS NULL OR "wrap_public_balance_after" ~ '^(0|[1-9][0-9]*)$') AND
      ("public_balance_before" IS NULL OR "public_balance_before" ~ '^(0|[1-9][0-9]*)$') AND
      ("public_balance_after" IS NULL OR "public_balance_after" ~ '^(0|[1-9][0-9]*)$') AND
      ("pending_balance_before" IS NULL OR "pending_balance_before" ~ '^(0|[1-9][0-9]*)$') AND
      ("pending_balance_after" IS NULL OR "pending_balance_after" ~ '^(0|[1-9][0-9]*)$') AND
      ("available_balance_before" IS NULL OR "available_balance_before" ~ '^(0|[1-9][0-9]*)$') AND
      ("available_balance_after" IS NULL OR "available_balance_after" ~ '^(0|[1-9][0-9]*)$')
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_reserve_funding_wrap_signature_uq"
  ON "workspace_reserve_funding_operations" USING btree ("wrap_signature");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_reserve_funding_active_workspace_uq"
  ON "workspace_reserve_funding_operations" USING btree ("active_workspace_id");
--> statement-breakpoint
CREATE INDEX "workspace_reserve_funding_workspace_status_created_idx"
  ON "workspace_reserve_funding_operations" USING btree ("workspace_id", "status", "created_at");
