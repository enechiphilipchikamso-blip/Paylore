use anchor_lang::prelude::*;

declare_id!("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");

pub const MAX_ID_LENGTH: usize = 64;

#[program]
pub mod paylore_payroll {
    use super::*;

    pub fn initialize_workspace(
        ctx: Context<InitializeWorkspace>,
        workspace_id: String,
        workspace_seed: [u8; 32],
    ) -> Result<()> {
        validate_identifier(&workspace_id)?;
        let workspace = &mut ctx.accounts.workspace;
        if validate_workspace_initialization(
            workspace,
            ctx.accounts.authority.key(),
            &workspace_id,
            workspace_seed,
        )? {
            return Ok(());
        }
        workspace.authority = ctx.accounts.authority.key();
        workspace.workspace_id = workspace_id;
        workspace.workspace_seed = workspace_seed;
        workspace.bump = ctx.bumps.workspace;
        Ok(())
    }

    pub fn create_claim(
        ctx: Context<CreateClaim>,
        claim_id: [u8; 32],
        allocation_commitment: [u8; 32],
    ) -> Result<()> {
        let claim = &mut ctx.accounts.claim;
        if validate_claim_initialization(
            claim,
            ctx.accounts.workspace.key(),
            ctx.accounts.contributor.key(),
            claim_id,
            allocation_commitment,
        )? {
            return Ok(());
        }
        claim.workspace = ctx.accounts.workspace.key();
        claim.contributor = ctx.accounts.contributor.key();
        claim.claim_id = claim_id;
        claim.allocation_commitment = allocation_commitment;
        claim.status = ClaimStatus::Unclaimed;
        claim.bump = ctx.bumps.claim;
        Ok(())
    }

    pub fn mark_claimed(_ctx: Context<MarkClaimed>) -> Result<()> {
        ensure_financial_settlement_is_implemented()
    }

    pub fn recover_claim(
        _ctx: Context<RecoverClaim>,
        _recovery_reason_commitment: [u8; 32],
    ) -> Result<()> {
        ensure_financial_settlement_is_implemented()
    }
}

fn ensure_financial_settlement_is_implemented() -> Result<()> {
    err!(PayrollError::FinancialSettlementUnavailable)
}

fn validate_claim_initialization(
    claim: &ClaimState,
    workspace: Pubkey,
    contributor: Pubkey,
    claim_id: [u8; 32],
    allocation_commitment: [u8; 32],
) -> Result<bool> {
    if claim.workspace == Pubkey::default() {
        return Ok(false);
    }
    require!(
        claim.workspace == workspace
            && claim.contributor == contributor
            && claim.claim_id == claim_id
            && claim.allocation_commitment == allocation_commitment
            && claim.status == ClaimStatus::Unclaimed,
        PayrollError::ClaimInitializationConflict
    );
    Ok(true)
}

fn validate_workspace_initialization(
    workspace: &WorkspaceState,
    authority: Pubkey,
    workspace_id: &str,
    workspace_seed: [u8; 32],
) -> Result<bool> {
    if workspace.authority == Pubkey::default() {
        return Ok(false);
    }
    require!(
        workspace.authority == authority
            && workspace.workspace_id == workspace_id
            && workspace.workspace_seed == workspace_seed,
        PayrollError::WorkspaceInitializationConflict
    );
    Ok(true)
}

fn validate_identifier(value: &str) -> Result<()> {
    require!(
        !value.trim().is_empty() && value.len() <= MAX_ID_LENGTH,
        PayrollError::InvalidIdentifier
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(workspace_id: String, workspace_seed: [u8; 32])]
pub struct InitializeWorkspace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = WorkspaceState::SPACE,
        seeds = [
            b"workspace",
            authority.key().as_ref(),
            workspace_seed.as_ref()
        ],
        bump
    )]
    pub workspace: Account<'info, WorkspaceState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claim_id: [u8; 32], allocation_commitment: [u8; 32])]
pub struct CreateClaim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The contributor is an identity key, not an account the program reads.
    pub contributor: UncheckedAccount<'info>,
    #[account(
        has_one = authority,
        seeds = [
            b"workspace",
            authority.key().as_ref(),
            workspace.workspace_seed.as_ref()
        ],
        bump = workspace.bump
    )]
    pub workspace: Account<'info, WorkspaceState>,
    #[account(
        init_if_needed,
        payer = authority,
        space = ClaimState::SPACE,
        seeds = [
            b"claim",
            workspace.key().as_ref(),
            contributor.key().as_ref(),
            claim_id.as_ref()
        ],
        bump
    )]
    pub claim: Account<'info, ClaimState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkClaimed<'info> {
    pub contributor: Signer<'info>,
    #[account(mut,
        seeds = [
            b"claim",
            claim.workspace.as_ref(),
            contributor.key().as_ref(),
            claim.claim_id.as_ref()
        ],
        bump = claim.bump,
        has_one = contributor
    )]
    pub claim: Account<'info, ClaimState>,
}

#[derive(Accounts)]
pub struct RecoverClaim<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The contributor identity is bound to the Claim PDA seeds.
    pub contributor: UncheckedAccount<'info>,
    #[account(
        has_one = authority,
        seeds = [
            b"workspace",
            authority.key().as_ref(),
            workspace.workspace_seed.as_ref()
        ],
        bump = workspace.bump
    )]
    pub workspace: Account<'info, WorkspaceState>,
    #[account(
        mut,
        seeds = [
            b"claim",
            workspace.key().as_ref(),
            contributor.key().as_ref(),
            claim.claim_id.as_ref()
        ],
        bump = claim.bump,
        has_one = workspace,
        constraint = claim.contributor == contributor.key()
    )]
    pub claim: Account<'info, ClaimState>,
}

#[account]
pub struct WorkspaceState {
    pub authority: Pubkey,
    pub workspace_id: String,
    pub workspace_seed: [u8; 32],
    pub bump: u8,
}

impl WorkspaceState {
    pub const SPACE: usize = 8 + 32 + 4 + MAX_ID_LENGTH + 32 + 1;
}

#[account]
pub struct ClaimState {
    pub workspace: Pubkey,
    pub contributor: Pubkey,
    pub claim_id: [u8; 32],
    pub allocation_commitment: [u8; 32],
    pub status: ClaimStatus,
    pub bump: u8,
}

impl ClaimState {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ClaimStatus {
    Unclaimed,
    Claimed,
    Recovered,
}

#[error_code]
pub enum PayrollError {
    #[msg("The identifier must contain 1 to 64 bytes.")]
    InvalidIdentifier,
    #[msg("This contributor claim has already been completed.")]
    InvalidClaimTransition,
    #[msg("A recovery reason commitment is required.")]
    InvalidRecoveryReason,
    #[msg("The workspace PDA already belongs to a different workspace identity.")]
    WorkspaceInitializationConflict,
    #[msg("The claim PDA already belongs to a different or completed allocation.")]
    ClaimInitializationConflict,
    #[msg("Financial claim and recovery settlement is not implemented.")]
    FinancialSettlementUnavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_pda_is_scoped_to_authority_and_workspace_id() {
        let authority = Pubkey::new_unique();
        let other_authority = Pubkey::new_unique();
        let workspace_seed = [3; 32];
        let (first, _) = Pubkey::find_program_address(
            &[b"workspace", authority.as_ref(), &workspace_seed],
            &crate::ID,
        );
        let (same, _) = Pubkey::find_program_address(
            &[b"workspace", authority.as_ref(), &workspace_seed],
            &crate::ID,
        );
        let (other, _) = Pubkey::find_program_address(
            &[b"workspace", other_authority.as_ref(), &workspace_seed],
            &crate::ID,
        );

        assert_eq!(first, same);
        assert_ne!(first, other);
    }

    #[test]
    fn claim_pda_is_scoped_to_workspace_contributor_and_claim_id() {
        let workspace = Pubkey::new_unique();
        let contributor = Pubkey::new_unique();
        let claim_id = [7; 32];
        let (first, _) = Pubkey::find_program_address(
            &[
                b"claim",
                workspace.as_ref(),
                contributor.as_ref(),
                &claim_id,
            ],
            &crate::ID,
        );
        let other_id = [8; 32];
        let (other_claim, _) = Pubkey::find_program_address(
            &[
                b"claim",
                workspace.as_ref(),
                contributor.as_ref(),
                &other_id,
            ],
            &crate::ID,
        );

        assert_ne!(first, other_claim);
    }

    #[test]
    fn financial_claim_operations_fail_closed_without_settlement() {
        assert!(ensure_financial_settlement_is_implemented().is_err());
    }

    #[test]
    fn repeated_unclaimed_claim_creation_is_safe_but_mismatched_commitments_are_not() {
        let claim = ClaimState {
            workspace: Pubkey::default(),
            contributor: Pubkey::default(),
            claim_id: [0; 32],
            allocation_commitment: [0; 32],
            status: ClaimStatus::Unclaimed,
            bump: 0,
        };
        assert!(matches!(
            validate_claim_initialization(
                &claim,
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                [1; 32],
                [2; 32],
            ),
            Ok(false)
        ));
        let existing = ClaimState {
            workspace: Pubkey::new_unique(),
            contributor: Pubkey::new_unique(),
            claim_id: [1; 32],
            allocation_commitment: [2; 32],
            status: ClaimStatus::Unclaimed,
            bump: 0,
        };
        assert!(validate_claim_initialization(
            &existing,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            [1; 32],
            [2; 32],
        )
        .is_err());
        let matching = ClaimState {
            workspace: existing.workspace,
            contributor: existing.contributor,
            claim_id: existing.claim_id,
            allocation_commitment: existing.allocation_commitment,
            status: ClaimStatus::Unclaimed,
            bump: existing.bump,
        };
        assert!(matches!(
            validate_claim_initialization(
                &matching,
                existing.workspace,
                existing.contributor,
                existing.claim_id,
                existing.allocation_commitment
            ),
            Ok(true)
        ));
        let completed = ClaimState {
            workspace: matching.workspace,
            contributor: matching.contributor,
            claim_id: matching.claim_id,
            allocation_commitment: matching.allocation_commitment,
            status: ClaimStatus::Claimed,
            bump: matching.bump,
        };
        assert!(validate_claim_initialization(
            &completed,
            existing.workspace,
            existing.contributor,
            existing.claim_id,
            existing.allocation_commitment
        )
        .is_err());
    }

    #[test]
    fn repeated_workspace_initialization_requires_the_original_identity() {
        let workspace = WorkspaceState {
            authority: Pubkey::new_unique(),
            workspace_id: "workspace-a".to_string(),
            workspace_seed: [9; 32],
            bump: 0,
        };
        assert!(matches!(
            validate_workspace_initialization(
                &workspace,
                workspace.authority,
                "workspace-a",
                [9; 32]
            ),
            Ok(true)
        ));
        assert!(validate_workspace_initialization(
            &workspace,
            Pubkey::new_unique(),
            "workspace-a",
            [9; 32]
        )
        .is_err());
    }
}
