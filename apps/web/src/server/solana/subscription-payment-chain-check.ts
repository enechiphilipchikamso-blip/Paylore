type RecordValue = Record<string, unknown>;

export type SubscriptionPaymentExpectation = {
  signature: string;
  payerAddress: string;
  recipient: string;
  mint: string;
  amountBaseUnits: string;
};

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenOwnerBalance(
  balances: unknown,
  accountIndex: number,
  mint: string,
  owner: string
): boolean {
  if (!Array.isArray(balances)) return false;
  return balances.some((raw) => {
    if (!record(raw)) return false;
    return raw.accountIndex === accountIndex &&
      raw.mint === mint &&
      raw.owner === owner;
  });
}

/**
 * Confirms a finalized parsed transaction matches the server-prepared payment
 * intent. A Helius callback is only a trigger; it is never the payment proof.
 */
export function isExactSubscriptionPaymentTransaction(
  value: unknown,
  expected: SubscriptionPaymentExpectation
): boolean {
  if (!record(value)) return false;
  const transaction = record(value.transaction) ? value.transaction : null;
  const message = transaction && record(transaction.message)
    ? transaction.message
    : null;
  const meta = record(value.meta) ? value.meta : null;
  const signatures = transaction?.signatures;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;

  if (
    !meta ||
    meta.err !== null ||
    !Array.isArray(signatures) ||
    !signatures.includes(expected.signature) ||
    !Array.isArray(accountKeys) ||
    !Array.isArray(instructions) ||
    !expected.signature ||
    !expected.payerAddress ||
    !expected.recipient ||
    !expected.mint ||
    !/^\d+$/.test(expected.amountBaseUnits)
  ) {
    return false;
  }

  const payerSigned = accountKeys.some((raw) =>
    record(raw) &&
    raw.pubkey === expected.payerAddress &&
    raw.signer === true
  );
  if (!payerSigned) return false;

  let verifiedAmount = 0n;
  for (const raw of instructions) {
    if (!record(raw) || (raw.program !== "spl-token" && raw.program !== "spl-token-2022")) {
      continue;
    }
    const parsed = record(raw.parsed) ? raw.parsed : null;
    const info = parsed && record(parsed.info) ? parsed.info : null;
    if (
      parsed?.type !== "transferChecked" ||
      !info ||
      typeof info.source !== "string" ||
      typeof info.destination !== "string" ||
      info.mint !== expected.mint
    ) {
      continue;
    }

    const tokenAmount = record(info.tokenAmount) ? info.tokenAmount : null;
    const amount = tokenAmount?.amount;
    const decimals = tokenAmount?.decimals;
    if (
      typeof amount !== "string" ||
      !/^\d+$/.test(amount) ||
      decimals !== 6
    ) {
      continue;
    }

    const sourceIndex = accountKeys.findIndex((raw) =>
      typeof raw === "string"
        ? raw === info.source
        : record(raw) && raw.pubkey === info.source
    );
    const destinationIndex = accountKeys.findIndex((raw) =>
      typeof raw === "string"
        ? raw === info.destination
        : record(raw) && raw.pubkey === info.destination
    );
    if (
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      !tokenOwnerBalance(meta.preTokenBalances, sourceIndex, expected.mint, expected.payerAddress) ||
      !tokenOwnerBalance(meta.postTokenBalances, destinationIndex, expected.mint, expected.recipient)
    ) {
      continue;
    }

    verifiedAmount += BigInt(amount);
  }

  return verifiedAmount === BigInt(expected.amountBaseUnits);
}
