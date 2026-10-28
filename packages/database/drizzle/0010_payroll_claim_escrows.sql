CREATE TABLE IF NOT EXISTS payroll_claim_escrows (
  allocation_id uuid PRIMARY KEY REFERENCES payroll_allocations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  claim_id text NOT NULL,
  token_account_address text NOT NULL CONSTRAINT payroll_claim_escrows_token_account_address_unique UNIQUE,
  status text NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'ready', 'funding', 'funded', 'settlement_pending', 'recovery_pending', 'claimed', 'recovered', 'failed')),
  encrypted_private_key text,
  private_key_nonce text,
  private_key_auth_tag text,
  encrypted_data_key text,
  data_key_nonce text,
  data_key_auth_tag text,
  encrypted_backup text,
  backup_nonce text,
  backup_auth_tag text,
  account_setup_signature text,
  confidential_setup_signatures jsonb NOT NULL DEFAULT '[]'::jsonb,
  funding_signature text,
  funding_proof_context_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  funding_context_signatures jsonb NOT NULL DEFAULT '[]'::jsonb,
  funding_source_available_before text,
  funding_source_available_after text,
  funding_destination_available_before text,
  funding_destination_available_after text,
  funded_at timestamptz,
  settlement_signature text,
  recovery_signature text,
  recovery_apply_signature text,
  recovery_proof_context_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  recovery_context_signatures jsonb NOT NULL DEFAULT '[]'::jsonb,
  recovery_source_available_before text,
  recovery_source_available_after text,
  recovery_destination_available_before text,
  recovery_destination_available_after text,
  recovered_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_claim_escrows_encrypted_key_complete CHECK (
    (encrypted_private_key IS NULL AND private_key_nonce IS NULL AND private_key_auth_tag IS NULL
      AND encrypted_data_key IS NULL AND data_key_nonce IS NULL AND data_key_auth_tag IS NULL
      AND encrypted_backup IS NULL AND backup_nonce IS NULL AND backup_auth_tag IS NULL)
    OR
    (encrypted_private_key IS NOT NULL AND private_key_nonce IS NOT NULL AND private_key_auth_tag IS NOT NULL
      AND encrypted_data_key IS NOT NULL AND data_key_nonce IS NOT NULL AND data_key_auth_tag IS NOT NULL
      AND encrypted_backup IS NOT NULL AND backup_nonce IS NOT NULL AND backup_auth_tag IS NOT NULL)
  ),
  CONSTRAINT payroll_claim_escrows_funding_balances CHECK (
    (funding_source_available_before IS NULL AND funding_source_available_after IS NULL
      AND funding_destination_available_before IS NULL AND funding_destination_available_after IS NULL)
    OR
    (funding_source_available_before ~ '^(0|[1-9][0-9]*)$'
      AND funding_source_available_after ~ '^(0|[1-9][0-9]*)$'
      AND funding_destination_available_before ~ '^(0|[1-9][0-9]*)$'
      AND funding_destination_available_after ~ '^(0|[1-9][0-9]*)$')
  ),
  CONSTRAINT payroll_claim_escrows_recovery_balances CHECK (
    (recovery_source_available_before IS NULL AND recovery_source_available_after IS NULL
      AND recovery_destination_available_before IS NULL AND recovery_destination_available_after IS NULL)
    OR
    (recovery_source_available_before ~ '^(0|[1-9][0-9]*)$'
      AND recovery_source_available_after ~ '^(0|[1-9][0-9]*)$'
      AND recovery_destination_available_before ~ '^(0|[1-9][0-9]*)$'
      AND recovery_destination_available_after ~ '^(0|[1-9][0-9]*)$')
  )
);

CREATE INDEX IF NOT EXISTS payroll_claim_escrows_workspace_status_idx
  ON payroll_claim_escrows(workspace_id, status);

