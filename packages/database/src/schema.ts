import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const workspaceRoleEnum =
  pgEnum("workspace_role", [
    "organization_admin",
    "finance_auditor",
    "contributor"
  ]);

export const subscriptionStatusEnum =
  pgEnum("subscription_status", [
    "inactive",
    "active",
    "cancel_scheduled",
    "archived"
  ]);

export const contributorLifecycleEnum =
  pgEnum("contributor_lifecycle", [
    "invited",
    "active",
    "left"
  ]);

export const contributorOnboardingEnum =
  pgEnum("contributor_onboarding_status", [
    "pending",
    "complete",
    "incomplete"
  ]);

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .defaultRandom()
      .primaryKey(),

    createdAt: timestamp(
      "created_at",
      {
        withTimezone: true
      }
    )
      .notNull()
      .defaultNow()
  },
  (table) => [
    index(
      "users_created_at_idx"
    ).on(table.createdAt)
  ]
);

export const walletIdentities =
  pgTable(
    "wallet_identities",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      userId: uuid("user_id")
        .notNull()
        .references(
          () => users.id,
          {
            onDelete:
              "cascade"
          }
        ),

      address: text("address")
        .notNull(),

      createdAt: timestamp(
        "created_at",
        {
          withTimezone: true
        }
      )
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex(
        "wallet_identities_address_uq"
      ).on(table.address),

      index(
        "wallet_identities_user_id_idx"
      ).on(table.userId)
    ]
  );

export const authChallenges =
  pgTable(
    "auth_challenges",
    {
      nonce: text("nonce")
        .primaryKey(),

      walletAddress: text(
        "wallet_address"
      ).notNull(),

      input: jsonb("input")
        .notNull(),

      message: text("message")
        .notNull(),

      issuedAt: timestamp(
        "issued_at",
        {
          withTimezone: true
        }
      ).notNull(),

      expirationTime: timestamp(
        "expiration_time",
        {
          withTimezone: true
        }
      ).notNull(),

      consumedAt: timestamp(
        "consumed_at",
        {
          withTimezone: true
        }
      ),

      createdAt: timestamp(
        "created_at",
        {
          withTimezone: true
        }
      )
        .notNull()
        .defaultNow()
    },
    (table) => [
      index(
        "auth_challenges_wallet_address_idx"
      ).on(
        table.walletAddress
      ),

      index(
        "auth_challenges_expiration_idx"
      ).on(
        table.expirationTime
      )
    ]
  );

export const sessions =
  pgTable(
    "sessions",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      tokenHash: text(
        "token_hash"
      ).notNull(),

      userId: uuid("user_id")
        .notNull()
        .references(
          () => users.id,
          {
            onDelete:
              "cascade"
          }
        ),

      walletIdentityId:
        uuid(
          "wallet_identity_id"
        )
          .notNull()
          .references(
            () =>
              walletIdentities.id,
            {
              onDelete:
                "cascade"
            }
          ),

      issuedAt: timestamp(
        "issued_at",
        {
          withTimezone: true
        }
      ).notNull(),

      lastSeenAt: timestamp(
        "last_seen_at",
        {
          withTimezone: true
        }
      ).notNull(),

      expiresAt: timestamp(
        "expires_at",
        {
          withTimezone: true
        }
      ).notNull(),

      revokedAt: timestamp(
        "revoked_at",
        {
          withTimezone: true
        }
      )
    },
    (table) => [
      uniqueIndex(
        "sessions_token_hash_uq"
      ).on(
        table.tokenHash
      ),

      index(
        "sessions_user_id_idx"
      ).on(table.userId),

      index(
        "sessions_wallet_identity_id_idx"
      ).on(
        table.walletIdentityId
      ),

      index(
        "sessions_expires_at_idx"
      ).on(
        table.expiresAt
      )
    ]
  );

export const workspaces =
  pgTable(
    "workspaces",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      name: text("name")
        .notNull(),

      createdByUserId:
        uuid(
          "created_by_user_id"
        )
          .notNull()
          .references(
            () => users.id,
            {
              onDelete:
                "restrict"
            }
          ),

      createdAt: timestamp(
        "created_at",
        {
          withTimezone: true
        }
      )
        .notNull()
        .defaultNow()
    },
    (table) => [
      index(
        "workspaces_created_by_user_id_idx"
      ).on(
        table.createdByUserId
      )
    ]
  );

export const workspaceSubscriptions =
  pgTable(
    "workspace_subscriptions",
    {
      workspaceId:
        uuid("workspace_id")
          .primaryKey()
          .references(
            () => workspaces.id,
            { onDelete: "cascade" }
          ),

      status:
        subscriptionStatusEnum(
          "status"
        )
          .notNull()
          .default("inactive"),

      periodStart:
        timestamp("period_start", {
          withTimezone: true
        }),

      periodEnd:
        timestamp("period_end", {
          withTimezone: true
        }),

      cancelAtPeriodEnd:
        boolean("cancel_at_period_end")
          .notNull()
          .default(false),

      createdAt:
        timestamp("created_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow(),

      updatedAt:
        timestamp("updated_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow()
    },
    (table) => [
      index(
        "workspace_subscriptions_status_period_end_idx"
      ).on(table.status, table.periodEnd)
    ]
  );

export const subscriptionPayments =
  pgTable(
    "subscription_payments",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      workspaceId:
        uuid("workspace_id")
          .notNull()
          .references(
            () => workspaces.id,
            { onDelete: "cascade" }
          ),

      userId:
        uuid("user_id")
          .notNull()
          .references(
            () => users.id,
            { onDelete: "restrict" }
          ),

      signature:
        text("signature")
          .notNull(),

      mint:
        text("mint")
          .notNull(),

      recipient:
        text("recipient")
          .notNull(),

      amountBaseUnits:
        text("amount_base_units")
          .notNull(),

      periodStart:
        timestamp("period_start", {
          withTimezone: true
        }).notNull(),

      periodEnd:
        timestamp("period_end", {
          withTimezone: true
        }).notNull(),

      verifiedAt:
        timestamp("verified_at", {
          withTimezone: true
        }).notNull(),

      createdAt:
        timestamp("created_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow()
    },
    (table) => [
      uniqueIndex(
        "subscription_payments_signature_uq"
      ).on(table.signature),
      index(
        "subscription_payments_workspace_created_idx"
      ).on(table.workspaceId, table.createdAt)
    ]
  );

export const subscriptionPaymentAttempts = pgTable(
  "subscription_payment_attempts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    payerWalletAddress: text("payer_wallet_address").notNull(),
    recipient: text("recipient").notNull(),
    mint: text("mint").notNull(),
    amountBaseUnits: text("amount_base_units").notNull(),
    memo: text("memo").notNull(),
    blockhash: text("blockhash").notNull(),
    lastValidBlockHeight: integer("last_valid_block_height").notNull(),
    status: text("status").notNull().default("prepared"),
    signature: text("signature"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("subscription_payment_attempts_memo_uq").on(table.memo),
    uniqueIndex("subscription_payment_attempts_signature_uq").on(table.signature),
    index("subscription_payment_attempts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    index("subscription_payment_attempts_payer_status_idx").on(
      table.payerWalletAddress,
      table.status
    )
  ]
);

export const workspaceMemberships =
  pgTable(
    "workspace_memberships",
    {
      workspaceId:
        uuid(
          "workspace_id"
        )
          .notNull()
          .references(
            () =>
              workspaces.id,
            {
              onDelete:
                "cascade"
            }
          ),

      userId: uuid("user_id")
        .notNull()
        .references(
          () => users.id,
          {
            onDelete:
              "cascade"
          }
        ),

      role:
        workspaceRoleEnum(
          "role"
        ).notNull(),

      createdAt: timestamp(
        "created_at",
        {
          withTimezone: true
        }
      )
        .notNull()
        .defaultNow()
    },
    (table) => [
      primaryKey({
        columns: [
          table.workspaceId,
          table.userId
        ]
      }),

      index(
        "workspace_memberships_user_id_idx"
      ).on(table.userId),

      index(
        "workspace_memberships_workspace_id_idx"
      ).on(
        table.workspaceId
      )
    ]
  );

export const invitationEntryTargets =
  pgTable(
    "invitation_entry_targets",
    {
      tokenHash:
        text("token_hash")
          .primaryKey(),

      workspaceId:
        uuid("workspace_id")
          .notNull()
          .references(
            () =>
              workspaces.id,
            {
              onDelete:
                "cascade"
            }
          ),

      contributorWalletAddress:
        text(
          "contributor_wallet_address"
        ).notNull(),

      expiresAt:
        timestamp(
          "expires_at",
          {
            withTimezone: true
          }
        ).notNull(),

      createdAt:
        timestamp(
          "created_at",
          {
            withTimezone: true
          }
        )
          .notNull()
          .defaultNow()
    },
    (table) => [
      index(
        "invitation_entry_targets_workspace_id_idx"
      ).on(
        table.workspaceId
      ),

      index(
        "invitation_entry_targets_expires_at_idx"
      ).on(
        table.expiresAt
      )
    ]
  );

export const contributors =
  pgTable(
    "contributors",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      workspaceId:
        uuid("workspace_id")
          .notNull()
          .references(
            () => workspaces.id,
            { onDelete: "cascade" }
          ),

      displayName:
        text("display_name")
          .notNull(),

      identityWalletAddress:
        text("identity_wallet_address")
          .notNull(),

      effectivePayoutAddress:
        text("effective_payout_address")
          .notNull(),

      role:
        workspaceRoleEnum("role")
          .notNull()
          .default("contributor"),

      lifecycle:
        contributorLifecycleEnum(
          "lifecycle"
        )
          .notNull()
          .default("invited"),

      onboardingStatus:
        contributorOnboardingEnum(
          "onboarding_status"
        )
          .notNull()
          .default("pending"),

      organizationLabel:
        text("organization_label"),

      adminNote:
        text("admin_note"),

      createdAt:
        timestamp("created_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow(),

      updatedAt:
        timestamp("updated_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow()
    },
    (table) => [
      uniqueIndex(
        "contributors_workspace_identity_wallet_uq"
      ).on(
        table.workspaceId,
        table.identityWalletAddress
      ),
      index(
        "contributors_workspace_lifecycle_idx"
      ).on(table.workspaceId, table.lifecycle)
    ]
  );

export const contributorInvitations =
  pgTable(
    "contributor_invitations",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      tokenHash:
        text("token_hash")
          .notNull()
          .unique(),

      workspaceId:
        uuid("workspace_id")
          .notNull()
          .references(
            () => workspaces.id,
            { onDelete: "cascade" }
          ),

      contributorId:
        uuid("contributor_id")
          .notNull()
          .references(
            () => contributors.id,
            { onDelete: "cascade" }
          ),

      createdByUserId:
        uuid("created_by_user_id")
          .notNull()
          .references(
            () => users.id,
            { onDelete: "restrict" }
          ),

      expiresAt:
        timestamp("expires_at", {
          withTimezone: true
        }).notNull(),

      acceptedAt:
        timestamp("accepted_at", {
          withTimezone: true
        }),

      createdAt:
        timestamp("created_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow()
    },
    (table) => [
      index(
        "contributor_invitations_workspace_id_idx"
      ).on(table.workspaceId),
      index(
        "contributor_invitations_expires_at_idx"
      ).on(table.expiresAt)
    ]
  );

export const workspaceReserves =
  pgTable(
    "workspace_reserves",
    {
      workspaceId:
        uuid("workspace_id")
          .primaryKey()
          .references(
            () => workspaces.id,
            { onDelete: "cascade" }
          ),

      address:
        text("address")
          .notNull(),

      encryptedPrivateKey:
        text("encrypted_private_key")
          .notNull(),

      privateKeyNonce:
        text("private_key_nonce")
          .notNull(),

      privateKeyAuthTag:
        text("private_key_auth_tag")
          .notNull(),

      encryptedDataKey:
        text("encrypted_data_key")
          .notNull(),

      dataKeyNonce:
        text("data_key_nonce")
          .notNull(),

      dataKeyAuthTag:
        text("data_key_auth_tag")
          .notNull(),

      encryptedBackup:
        text("encrypted_backup")
          .notNull(),

      backupNonce:
        text("backup_nonce")
          .notNull(),

      backupAuthTag:
        text("backup_auth_tag")
          .notNull(),

      createdAt:
        timestamp("created_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow(),

      updatedAt:
        timestamp("updated_at", {
          withTimezone: true
        })
          .notNull()
          .defaultNow()
    },
    (table) => [
      uniqueIndex(
        "workspace_reserves_address_uq"
      ).on(table.address)
    ]
  );

export const workspaceGasTanks =
  pgTable(
    "workspace_gas_tanks",
    {
      workspaceId: uuid("workspace_id")
        .primaryKey()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      address: text("address").notNull(),
      encryptedPrivateKey: text("encrypted_private_key").notNull(),
      privateKeyNonce: text("private_key_nonce").notNull(),
      privateKeyAuthTag: text("private_key_auth_tag").notNull(),
      encryptedDataKey: text("encrypted_data_key").notNull(),
      dataKeyNonce: text("data_key_nonce").notNull(),
      dataKeyAuthTag: text("data_key_auth_tag").notNull(),
      encryptedBackup: text("encrypted_backup").notNull(),
      backupNonce: text("backup_nonce").notNull(),
      backupAuthTag: text("backup_auth_tag").notNull(),
      balanceLamports: text("balance_lamports").notNull().default("0"),
      lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("workspace_gas_tanks_address_uq").on(table.address)
    ]
  );

export const gasTankOperations =
  pgTable(
    "gas_tank_operations",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      idempotencyKey: text("idempotency_key").notNull(),
      operationType: text("operation_type").notNull(),
      requestDigest: text("request_digest").notNull(),
      status: text("status").notNull().default("prepared"),
      transactionSignature: text("transaction_signature"),
      feeLamports: text("fee_lamports"),
      failureCode: text("failure_code"),
      lastValidBlockHeight: text("last_valid_block_height"),
      operationData: jsonb("operation_data"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("gas_tank_operations_workspace_idempotency_uq").on(
        table.workspaceId,
        table.idempotencyKey
      ),
      index("gas_tank_operations_workspace_created_idx").on(
        table.workspaceId,
        table.createdAt
      )
    ]
  );

export const payrollRuns =
  pgTable(
    "payroll_runs",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      createdByUserId: uuid("created_by_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      idempotencyKey: text("idempotency_key").notNull(),
      importDigest: text("import_digest").notNull(),
      allocationCommitment: text("allocation_commitment"),
      totalAmountBaseUnits: text("total_amount_base_units").notNull(),
      status: text("status").notNull().default("awaiting_confirmation"),
      managerConfirmedAt: timestamp("manager_confirmed_at", {
        withTimezone: true
      }),
      submissionSignature: text("submission_signature"),
      finalizedAt: timestamp("finalized_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("payroll_runs_workspace_idempotency_uq").on(
        table.workspaceId,
        table.idempotencyKey
      ),
      index("payroll_runs_workspace_created_idx").on(
        table.workspaceId,
        table.createdAt
      )
    ]
  );

export const payrollAllocations =
  pgTable(
    "payroll_allocations",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      payrollRunId: uuid("payroll_run_id")
        .notNull()
        .references(() => payrollRuns.id, { onDelete: "cascade" }),
      contributorId: uuid("contributor_id")
        .notNull()
        .references(() => contributors.id, { onDelete: "restrict" }),
      amountBaseUnits: text("amount_base_units").notNull(),
      claimId: text("claim_id").notNull(),
      claimAddress: text("claim_address"),
      status: text("status").notNull().default("unclaimed"),
      transactionSignature: text("transaction_signature"),
      settlementSignature: text("settlement_signature"),
      settlementSourceAvailableBefore: text("settlement_source_available_before"),
      claimedAt: timestamp("claimed_at", { withTimezone: true }),
      recoveredAt: timestamp("recovered_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("payroll_allocations_run_claim_uq").on(
        table.payrollRunId,
        table.claimId
      ),
      uniqueIndex("payroll_allocations_claim_address_uq").on(
        table.claimAddress
      ),
      index("payroll_allocations_workspace_status_idx").on(
        table.workspaceId,
        table.status
      ),
      index("payroll_allocations_contributor_idx").on(
        table.contributorId,
        table.createdAt
      )
    ]
  );

export const contributorConfidentialAccounts =
  pgTable(
    "contributor_confidential_accounts",
    {
      contributorId: uuid("contributor_id")
        .primaryKey()
        .references(() => contributors.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      ownerWalletAddress: text("owner_wallet_address").notNull(),
      tokenAccountAddress: text("token_account_address").notNull(),
      status: text("status").notNull().default("setup_pending"),
      setupTransactionSignature: text("setup_transaction_signature"),
      closeTransactionSignature: text("close_transaction_signature"),
      closedAt: timestamp("closed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("confidential_accounts_token_account_uq").on(
        table.tokenAccountAddress
      ),
      index("confidential_accounts_workspace_status_idx").on(
        table.workspaceId,
        table.status
      )
    ]
  );

export const contributorOffboarding =
  pgTable(
    "contributor_offboarding",
    {
      contributorId: uuid("contributor_id")
        .primaryKey()
        .references(() => contributors.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      requestedAt: timestamp("requested_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      manualAccountClose: boolean("manual_account_close"),
      closeTransactionSignature: text("close_transaction_signature"),
      automaticCleanupEligibleAt: timestamp(
        "automatic_cleanup_eligible_at",
        { withTimezone: true }
      ),
      associationRemovedAt: timestamp("association_removed_at", {
        withTimezone: true
      }),
      status: text("status").notNull().default("requested")
    },
    (table) => [
      index("contributor_offboarding_workspace_status_idx").on(
        table.workspaceId,
        table.status
      ),
      index("contributor_offboarding_cleanup_idx").on(
        table.automaticCleanupEligibleAt
      )
    ]
  );

export const payrollRecoveries =
  pgTable(
    "payroll_recoveries",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      allocationId: uuid("allocation_id")
        .notNull()
        .references(() => payrollAllocations.id, { onDelete: "restrict" }),
      actorUserId: uuid("actor_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
      reason: text("reason").notNull(),
      reasonNote: text("reason_note"),
      status: text("status").notNull().default("prepared"),
      transactionSignature: text("transaction_signature"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      confirmedAt: timestamp("confirmed_at", { withTimezone: true })
    },
    (table) => [
      uniqueIndex("payroll_recoveries_allocation_uq").on(table.allocationId),
      index("payroll_recoveries_workspace_created_idx").on(
        table.workspaceId,
        table.createdAt
      )
    ]
  );

export const solanaWebhookEvents =
  pgTable(
    "solana_webhook_events",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      provider: text("provider").notNull(),
      providerEventId: text("provider_event_id").notNull(),
      transactionSignature: text("transaction_signature"),
      accountAddress: text("account_address"),
      eventType: text("event_type"),
      payload: jsonb("payload").notNull(),
      status: text("status").notNull().default("received"),
      attempts: integer("attempts").notNull().default(0),
      nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
      lastErrorCode: text("last_error_code"),
      transactionSlot: text("transaction_slot"),
      finalizedAt: timestamp("finalized_at", { withTimezone: true }),
      receivedAt: timestamp("received_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      processedAt: timestamp("processed_at", { withTimezone: true })
    },
    (table) => [
      uniqueIndex("solana_webhook_events_provider_event_uq").on(
        table.provider,
        table.providerEventId
      ),
      index("solana_webhook_events_status_retry_idx").on(
        table.status,
        table.nextAttemptAt
      ),
      index("solana_webhook_events_signature_idx").on(
        table.transactionSignature
      )
    ]
  );

export const workspaceLedgerEntries =
  pgTable(
    "workspace_ledger_entries",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      idempotencyKey: text("idempotency_key").notNull(),
      category: text("category").notNull(),
      entryType: text("entry_type").notNull(),
      status: text("status").notNull(),
      amountBaseUnits: text("amount_base_units"),
      mint: text("mint"),
      referenceType: text("reference_type"),
      referenceId: text("reference_id"),
      transactionSignature: text("transaction_signature"),
      metadata: jsonb("metadata").notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("workspace_ledger_workspace_idempotency_uq").on(
        table.workspaceId,
        table.idempotencyKey
      ),
      index("workspace_ledger_workspace_created_idx").on(
        table.workspaceId,
        table.createdAt
      ),
      index("workspace_ledger_workspace_category_idx").on(
        table.workspaceId,
        table.category,
        table.status
      )
    ]
  );

export const workspaceNotifications =
  pgTable(
    "workspace_notifications",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      recipientKey: text("recipient_key").notNull(),
      eventKey: text("event_key").notNull(),
      category: text("category").notNull(),
      title: text("title").notNull(),
      body: text("body").notNull(),
      destination: text("destination"),
      readAt: timestamp("read_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      uniqueIndex("workspace_notifications_event_recipient_uq").on(
        table.workspaceId,
        table.eventKey,
        table.recipientKey
      ),
      index("workspace_notifications_recipient_read_idx").on(
        table.recipientKey,
        table.readAt,
        table.createdAt
      )
    ]
  );

export const workspaceRetention =
  pgTable(
    "workspace_retention",
    {
      workspaceId: uuid("workspace_id")
        .primaryKey()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      closedAt: timestamp("closed_at", { withTimezone: true }),
      deletionRequestedAt: timestamp("deletion_requested_at", {
        withTimezone: true
      }),
      deletionScheduledAt: timestamp("deletion_scheduled_at", {
        withTimezone: true
      }),
      deletionCanceledAt: timestamp("deletion_canceled_at", {
        withTimezone: true
      }),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      lastNoticeDay: integer("last_notice_day").notNull().default(0),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    },
    (table) => [
      index("workspace_retention_activity_idx").on(table.lastActivityAt),
      index("workspace_retention_deletion_idx").on(table.deletionScheduledAt)
    ]
  );

// Keep one minimal deletion outcome after the workspace's application rows are purged.
export const workspaceDeletionAudit =
  pgTable(
    "workspace_deletion_audit",
    {
      workspaceId: uuid("workspace_id").primaryKey(),
      requestedAt: timestamp("requested_at", { withTimezone: true }),
      scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
      canceledAt: timestamp("canceled_at", { withTimezone: true }),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      outcome: text("outcome").notNull().default("not_requested"),
      blockerCode: text("blocker_code"),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
    }
  );

export const workspaceCreationRateLimits =
  pgTable(
    "workspace_creation_rate_limits",
    {
      userId:
        uuid("user_id")
          .primaryKey()
          .references(
            () => users.id,
            {
              onDelete:
                "cascade"
            }
          ),

      windowStartedAt:
        timestamp(
          "window_started_at",
          {
            withTimezone: true
          }
        ).notNull(),

      attemptCount:
        integer(
          "attempt_count"
        ).notNull()
    }
  );
