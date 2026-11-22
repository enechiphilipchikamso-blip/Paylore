import "server-only";

import {
  address,
  fetchEncodedAccount,
  getAddressEncoder,
  type createKeyPairSignerFromBytes,
  type createSolanaRpc,
  type Instruction
} from "@solana/kit";
import { closeContextStateProof, ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import {
  classifyProofContextAccount,
  proofContextsReadyForTransfer,
  type ProofContextAccountState
} from "./payroll-confidential-settlement-policy";

type KeySigner = Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
type Rpc = ReturnType<typeof createSolanaRpc>;

/** Why a proof context was left on-chain instead of closed. */
export type ProofContextLeftoverReason = "uninitialized" | "foreign" | "unclosable";

function signerCandidates(signers: readonly KeySigner[]) {
  const encoder = getAddressEncoder();
  return signers.flatMap((signer) => {
    try {
      return [{ signer, addressBytes: new Uint8Array(encoder.encode(address(signer.address))) }];
    } catch {
      return [];
    }
  });
}

async function readProofContextState(
  rpc: Rpc,
  addressText: string,
  candidates: ReturnType<typeof signerCandidates>
): Promise<ProofContextAccountState<KeySigner>> {
  const encoded = await fetchEncodedAccount(rpc, address(addressText));
  const record = encoded as unknown as Record<string, unknown>;
  return classifyProofContextAccount(
    { exists: encoded.exists, owner: record.programAddress ?? record.owner, data: record.data },
    ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
    candidates
  );
}

/**
 * True when all the proof contexts of a confidential transfer are initialised and
 * owned by the Gas Tank, which paid for and owns them. Anything else means proof
 * setup did not really finish, and the transfer must not be sent.
 */
export async function proofContextsReady(
  rpc: Rpc,
  addresses: readonly string[],
  gasSigner: KeySigner,
  signer: KeySigner
): Promise<boolean> {
  const unique = [...new Set(addresses)];
  if (unique.length === 0) return false;
  try {
    const candidates = signerCandidates([gasSigner, signer]);
    const states = await Promise.all(unique.map((item) => readProofContextState(rpc, item, candidates)));
    return proofContextsReadyForTransfer(states, gasSigner.address, unique.length);
  } catch {
    return false;
  }
}

/**
 * Closes every proof context that can be closed and reports whether each is now
 * resolved: gone, closed, or a recorded leftover.
 *
 * A context that is uninitialised (no proof was ever verified into it), owned by
 * another program, or owned by an authority we do not hold cannot be closed by
 * anyone we control. It holds only its rent and is never read again (every attempt
 * uses fresh context addresses), so it is recorded through `onLeftover` and
 * resolved. Treating it as a blocker kept an allocation "Settlement pending" for
 * as long as the account existed, which is forever.
 *
 * A closable context whose close did not finalize stays unresolved: that is a
 * transient failure, and the next check retries it.
 */
export async function closeProofContexts(input: {
  rpc: Rpc;
  addresses: readonly string[];
  gasSigner: KeySigner;
  signer: KeySigner;
  /** Sends one close instruction; true only when it finalized. */
  close: (instruction: Instruction) => Promise<boolean>;
  onLeftover: (address: string, reason: ProofContextLeftoverReason) => void;
}): Promise<boolean> {
  const candidates = signerCandidates([input.gasSigner, input.signer]);
  const resolve = async (addressText: string): Promise<boolean> => {
    try {
      const state = await readProofContextState(input.rpc, addressText, candidates);
      if (state.kind === "absent") return true;
      if (state.kind === "closable") {
        return await input.close(closeContextStateProof({
          contextState: address(addressText),
          authority: state.authority,
          destination: address(state.authority.address)
        }));
      }
      try { input.onLeftover(addressText, state.kind); } catch { /* Logging never blocks cleanup. */ }
      return true;
    } catch {
      return false;
    }
  };
  // The closes are independent, so they confirm together instead of one finality
  // wait after another (three in a row would outlast a synchronous request).
  const resolved = await Promise.all([...new Set(input.addresses)].map(resolve));
  return resolved.every(Boolean);
}
