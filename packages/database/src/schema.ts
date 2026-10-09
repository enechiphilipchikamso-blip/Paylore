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