use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked}
};

declare_id!("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");

pub const MAX_ID_LENGTH: usize = 64;
const TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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

    pub fn configure_workspace_reserve(
        ctx: Context<ConfigureWorkspaceReserve>,
    ) -> Result<()> {
        validate_token_account_identity(
            &ctx.accounts.reserve_token_account.to_account_info(),
            ctx.accounts.reserve_authority.key(),
            ctx.accounts.mint.key(),
        )?;
        require_keys_eq!(
            *ctx.accounts.mint.owner,
            TOKEN_2022_PROGRAM_ID,
            PayrollError::InvalidTokenAccount
        );

        let state = &mut ctx.accounts.reserve_state;
        if state.workspace != Pubkey::default() {
            require!(
                state.workspace == ctx.accounts.workspace.key()
                    && state.reserve_authority == ctx.accounts.reserve_authority.key()
                    && state.reserve_token_account == ctx.accounts.reserve_token_account.key()
                    && state.mint == ctx.accounts.mint.key(),
                PayrollError::ReserveConfigurationConflict
            );
            return Ok(());
        }

        state.workspace = ctx.accounts.workspace.key();
        state.reserve_authority = ctx.accounts.reserve_authority.key();
        state.reserve_token_account = ctx.accounts.reserve_token_account.key();
        state.mint = ctx.accounts.mint.key();
        state.bump = ctx.bumps.reserve_state;
        Ok(())
    }

    pub fn mark_claimed(_ctx: Context<MarkClaimed>) -> Result<()> {
        // A transfer's ciphertext proof does not yet bind its hidden amount to
        // this allocation's stored commitment. Failing closed prevents a tiny
        // unrelated transfer from consuming a larger payroll entitlement.
        err!(PayrollError::SettlementAmountBindingUnavailable)
    }

    pub fn recover_claim(
        ctx: Context<RecoverClaim>,
        recovery_reason_commitment: [u8; 32],
    ) -> Result<()> {
        require!(
            recovery_reason_commitment != [0; 32],
            PayrollError::InvalidRecoveryReason
        );

        // Payroll entitlements are funded from the shared reserve only when
        // claimed. Cancelling an unclaimed entitlement releases the reservation;
        // no token transfer is needed because the reserve has not been debited.
        transition_claim_to_recovered(&mut ctx.accounts.claim)
    }
}

fn transition_claim_to_claimed(claim: &mut ClaimState) -> Result<()> {
    require!(
        claim.status == ClaimStatus::Unclaimed,
        PayrollError::InvalidClaimTransition
    );
    claim.status = ClaimStatus::Claimed;
    Ok(())
}

fn transition_claim_to_recovered(claim: &mut ClaimState) -> Result<()> {
    require!(
        claim.status == ClaimStatus::Unclaimed,
        PayrollError::InvalidClaimTransition
    );
    claim.status = ClaimStatus::Recovered;
    Ok(())
}

fn validate_token_account_identity(
    account: &AccountInfo,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *account.owner,
        TOKEN_2022_PROGRAM_ID,
        PayrollError::InvalidTokenAccount
    );
    let data = account.try_borrow_data()?;
    require!(data.len() >= 165, PayrollError::InvalidTokenAccount);
    let expected_mint_bytes = expected_mint.to_bytes();
    let expected_owner_bytes = expected_owner.to_bytes();
    require!(
        data[0..32] == expected_mint_bytes[..]
            && data[32..64] == expected_owner_bytes[..],
        PayrollError::InvalidTokenAccount
    );
    Ok(())
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
pub struct ConfigureWorkspaceReserve<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
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
        space = WorkspaceReserveState::SPACE,
        seeds = [b"reserve", workspace.key().as_ref()],
        bump
    )]
    pub reserve_state: Account<'info, WorkspaceReserveState>,
    /// CHECK: The reserve key is persisted in this state; the key must own the
    /// registered Token-2022 account and sign every settlement transfer.
    pub reserve_authority: UncheckedAccount<'info>,
    /// CHECK: The identity and token-account header are checked before storing.
    pub reserve_token_account: UncheckedAccount<'info>,
    /// CHECK: The mint is validated against the Token-2022 program owner.
    pub mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkClaimed<'info> {
    pub contributor: Signer<'info>,
    #[account(
        seeds = [
            b"workspace",
            workspace.authority.as_ref(),
            workspace.workspace_seed.as_ref()
        ],
        bump = workspace.bump,
        constraint = claim.workspace == workspace.key()
    )]
    pub workspace: Account<'info, WorkspaceState>,
    #[account(
        seeds = [b"reserve", workspace.key().as_ref()],
        bump = reserve_state.bump,
        has_one = workspace
    )]
    pub reserve_state: Account<'info, WorkspaceReserveState>,
    #[account(address = reserve_state.reserve_authority)]
    pub reserve_authority: Signer<'info>,
    #[account(address = reserve_state.reserve_token_account)]
    /// CHECK: Identity is confirmed against the configured reserve owner and mint.
    pub reserve_token_account: UncheckedAccount<'info>,
    #[account(address = reserve_state.mint)]
    /// CHECK: The mint is bound to the configured Token-2022 reserve account.
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Identity is confirmed against this claim's contributor and mint.
    pub destination_token_account: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            b"claim",
            claim.workspace.as_ref(),
            contributor.key().as_ref(),
            claim.claim_id.as_ref()
        ],
        bump = claim.bump,
        has_one = contributor,
        constraint = claim.workspace == workspace.key()
    )]
    pub claim: Account<'info, ClaimState>,
    /// CHECK: The program reads the current transaction's instruction list only.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
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
pub struct WorkspaceReserveState {
    pub workspace: Pubkey,
    pub reserve_authority: Pubkey,
    pub reserve_token_account: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

impl WorkspaceReserveState {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 1;
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
    #[msg("The configured reserve, token account, or mint identity is invalid.")]
    InvalidTokenAccount,
    #[msg("The workspace reserve is already configured with a different identity.")]
    ReserveConfigurationConflict,
    #[msg("Confidential settlement cannot yet prove the transferred amount matches this allocation.")]
    SettlementAmountBindingUnavailable,
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
    fn claim_status_transitions_are_one_way_and_reject_replays() {
        let mut claim = ClaimState {
            workspace: Pubkey::new_unique(),
            contributor: Pubkey::new_unique(),
            claim_id: [1; 32],
            allocation_commitment: [2; 32],
            status: ClaimStatus::Unclaimed,
            bump: 0,
        };
        assert!(transition_claim_to_claimed(&mut claim).is_ok());
        assert_eq!(claim.status, ClaimStatus::Claimed);
        assert!(transition_claim_to_recovered(&mut claim).is_err());
        assert!(transition_claim_to_claimed(&mut claim).is_err());

        let mut recoverable = ClaimState {
            workspace: Pubkey::new_unique(),
            contributor: Pubkey::new_unique(),
            claim_id: [3; 32],
            allocation_commitment: [4; 32],
            status: ClaimStatus::Unclaimed,
            bump: 0,
        };
        assert!(transition_claim_to_recovered(&mut recoverable).is_ok());
        assert_eq!(recoverable.status, ClaimStatus::Recovered);
        assert!(transition_claim_to_claimed(&mut recoverable).is_err());
        assert!(transition_claim_to_recovered(&mut recoverable).is_err());
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
