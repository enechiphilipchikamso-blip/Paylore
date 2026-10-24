ALTER TABLE payroll_allocations
  ADD COLUMN IF NOT EXISTS amount_commitment text;

ALTER TABLE payroll_allocations
  ADD COLUMN IF NOT EXISTS amount_commitment_proof jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE payroll_allocations
  ADD COLUMN IF NOT EXISTS amount_commitment_leaf_index integer NOT NULL DEFAULT 0;

ALTER TABLE payroll_allocations
  ADD CONSTRAINT payroll_allocations_amount_commitment_format
  CHECK (
    amount_commitment IS NULL OR amount_commitment ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE payroll_allocations
  ADD CONSTRAINT payroll_allocations_amount_commitment_proof_format
  CHECK (
    jsonb_typeof(amount_commitment_proof) = 'array'
    AND amount_commitment_leaf_index >= 0
  );
