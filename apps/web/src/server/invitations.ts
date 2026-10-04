import "server-only";

import {
  findInvitationEntryTarget,
  type Database
} from "@paylore/database";
import { hashOpaqueToken } from "./security";

export async function findInvitationEntry(
  db: Database,
  token: string
) {
  if (!token) {
    return null;
  }

  return findInvitationEntryTarget(
    db,
    hashOpaqueToken(token),
    new Date()
  );
}

export function invitationWalletMatches(
  expectedWalletAddress: string,
  authenticatedWalletAddress: string
): boolean {
  return (
    expectedWalletAddress ===
    authenticatedWalletAddress
  );
}