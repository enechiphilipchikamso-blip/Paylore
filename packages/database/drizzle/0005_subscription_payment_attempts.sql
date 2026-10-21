CREATE TABLE "subscription_payment_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "payer_wallet_address" text NOT NULL,
  "recipient" text NOT NULL,
  "mint" text NOT NULL,
  "amount_base_units" text NOT NULL,
  "memo" text NOT NULL,
  "blockhash" text NOT NULL,
  "last_valid_block_height" integer NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "signature" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subscription_payment_attempts_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "subscription_payment_attempts_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_attempts_memo_uq"
  ON "subscription_payment_attempts" USING btree ("memo");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_attempts_signature_uq"
  ON "subscription_payment_attempts" USING btree ("signature");
--> statement-breakpoint
CREATE INDEX "subscription_payment_attempts_workspace_created_idx"
  ON "subscription_payment_attempts" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX "subscription_payment_attempts_payer_status_idx"
  ON "subscription_payment_attempts" USING btree ("payer_wallet_address", "status");
