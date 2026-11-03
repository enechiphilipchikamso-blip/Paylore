import type { WorkspaceRole } from "../../server/authorization-policy";

export const WALLET_CONNECTION_HOME_LABELS: Record<WorkspaceRole, string> = {
  organization_admin: "administrator workspace home",
  contributor: "contributor dashboard home",
  finance_auditor: "auditor dashboard home"
};

export function walletConnectionHomeLabel(role: WorkspaceRole): string {
  return WALLET_CONNECTION_HOME_LABELS[role];
}

export function walletDisconnectedToastMessage(role: WorkspaceRole): string {
  return `Go to your ${walletConnectionHomeLabel(role)} and reconnect your wallet to continue.`;
}

export function walletDisconnectedCardMessage(role: WorkspaceRole): string {
  return role === "contributor"
    ? "Your wallet session is still signed in, but the wallet extension is no longer connected. Reconnect it to view compensation and claim payouts."
    : role === "finance_auditor"
      ? "Your wallet session is still signed in, but the wallet extension is no longer connected. Reconnect it to continue reviewing workspace finances."
      : "Your wallet session is still signed in, but the wallet extension is no longer connected. Reconnect it to approve payroll, funding and workspace actions.";
}
