ALTER TABLE "gas_tank_operations" ADD COLUMN "last_valid_block_height" text;
--> statement-breakpoint
ALTER TABLE "gas_tank_operations" ADD COLUMN "operation_data" jsonb;
