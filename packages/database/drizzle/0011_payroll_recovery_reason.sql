ALTER TABLE payroll_claim_escrows
  ADD COLUMN IF NOT EXISTS recovery_reason text,
  ADD COLUMN IF NOT EXISTS recovery_reason_note text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_claim_escrows_token_account_address_key'
      AND conrelid = 'payroll_claim_escrows'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_claim_escrows_token_account_address_unique'
      AND conrelid = 'payroll_claim_escrows'::regclass
  ) THEN
    ALTER TABLE payroll_claim_escrows
      RENAME CONSTRAINT payroll_claim_escrows_token_account_address_key
      TO payroll_claim_escrows_token_account_address_unique;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_claim_escrows_recovery_reason'
      AND conrelid = 'payroll_claim_escrows'::regclass
  ) THEN
    ALTER TABLE payroll_claim_escrows ADD CONSTRAINT payroll_claim_escrows_recovery_reason
      CHECK (recovery_reason IS NULL OR recovery_reason IN (
        'incorrect_allocation', 'contributor_left_before_claim', 'payroll_correction', 'other'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_claim_escrows_recovery_reason_note'
      AND conrelid = 'payroll_claim_escrows'::regclass
  ) THEN
    ALTER TABLE payroll_claim_escrows ADD CONSTRAINT payroll_claim_escrows_recovery_reason_note
      CHECK (recovery_reason_note IS NULL OR char_length(recovery_reason_note) <= 500);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_claim_escrows_recovery_other_note_required'
      AND conrelid = 'payroll_claim_escrows'::regclass
  ) THEN
    ALTER TABLE payroll_claim_escrows ADD CONSTRAINT payroll_claim_escrows_recovery_other_note_required
      CHECK (recovery_reason IS DISTINCT FROM 'other' OR char_length(btrim(recovery_reason_note)) > 0);
  END IF;
END $$;


ALTER TABLE workspace_reserves
  ADD COLUMN IF NOT EXISTS confidential_account_setup_signature text,
  ADD COLUMN IF NOT EXISTS program_reserve_setup_signature text;
