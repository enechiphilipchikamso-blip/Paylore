import {
  createDatabase,
  listHeliusMonitoredAddresses
} from "../../packages/database/src/index";
import { parseConfig, loadPayloreConfig } from "../../apps/web/src/server/config";
import {
  reconcileHeliusWebhook,
  getStableHeliusMonitoredAddresses,
  HeliusWebhookManagementError
} from "../../apps/web/src/server/solana/helius-webhook-management";

export const config = {
  schedule: "*/5 * * * *"
};

export default async function syncHeliusWebhookAddresses() {
  const appConfig = parseConfig(process.env);
  const payloreConfig = loadPayloreConfig();
  const required = [
    ["PAYLORE_HELIUS_MANAGEMENT_API_KEY", payloreConfig.PAYLORE_HELIUS_MANAGEMENT_API_KEY],
    ["PAYLORE_HELIUS_WEBHOOK_ID", payloreConfig.PAYLORE_HELIUS_WEBHOOK_ID],
    ["PAYLORE_HELIUS_WEBHOOK_SECRET", payloreConfig.PAYLORE_HELIUS_WEBHOOK_SECRET],
    ["PAYLORE_PAYROLL_PROGRAM_ID", payloreConfig.PAYLORE_PAYROLL_PROGRAM_ID]
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new Error(`Helius webhook reconciliation is missing required configuration: ${missing.join(", ")}`);
  }

  const { db, client } = createDatabase(appConfig.DATABASE_URL);
  try {
    const databaseAddresses = await listHeliusMonitoredAddresses(db);
    const stableAddresses = getStableHeliusMonitoredAddresses({
      payrollProgramId: payloreConfig.PAYLORE_PAYROLL_PROGRAM_ID,
      tokenWrapProgramId: payloreConfig.TOKEN_WRAP_PROGRAM_ID,
      subscriptionUsdcMint: payloreConfig.PAYLORE_SUBSCRIPTION_USDC_MINT,
      wrappedUsdcMint: payloreConfig.PAYLORE_WRAPPED_USDC_MINT,
      subscriptionRecipient: payloreConfig.PAYLORE_SUBSCRIPTION_RECIPIENT,
      deploymentAddress: payloreConfig.PAYLORE_HELIUS_DEPLOYMENT_ADDRESS
    });
    const result = await reconcileHeliusWebhook({
      managementApiKey: payloreConfig.PAYLORE_HELIUS_MANAGEMENT_API_KEY!,
      webhookId: payloreConfig.PAYLORE_HELIUS_WEBHOOK_ID!,
      webhookSecret: payloreConfig.PAYLORE_HELIUS_WEBHOOK_SECRET!,
      monitoredAddresses: [...stableAddresses, ...databaseAddresses]
    });

    console.log(JSON.stringify({
      event: "helius_webhook_address_reconciliation_completed",
      updated: result.updated,
      reactivated: result.reactivated,
      monitoredAddressCount: result.monitoredAddressCount
    }));
  } catch (error) {
    const code = error instanceof HeliusWebhookManagementError
      ? error.code
      : "helius_webhook_reconciliation_failed";
    console.error(JSON.stringify({ event: code }));
    throw new Error("Helius webhook reconciliation failed.");
  } finally {
    await client.end({ timeout: 5 });
  }
}
