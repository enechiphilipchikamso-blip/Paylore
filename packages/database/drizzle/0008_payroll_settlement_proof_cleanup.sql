ALTER TABLE "payroll_allocations" ADD COLUMN "settlement_proof_context_addresses" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "payroll_allocations" ADD COLUMN "settlement_context_signatures" jsonb NOT NULL DEFAULT '[]'::jsonb;
