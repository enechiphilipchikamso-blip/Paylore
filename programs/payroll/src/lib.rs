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
        claim.workspace = ctx.accounts.workspace.key();
        claim.contributor = ctx.accounts.contributor.key();
        claim.claim_id = claim_id;
        claim.allocation_commitment = allocation_commitment;
        claim.status = ClaimStatus::Unclaimed;
        claim.bump = ctx.bumps.claim;
        Ok(())
    }

    pub fn mark_claimed(ctx: Context<MarkClaimed>) -> Result<()> {
        require!(
            ctx.accounts.claim.status == ClaimStatus::Unclaimed,
            PayrollError::InvalidClaimTransition
        );
        ctx.accounts.claim.status = ClaimStatus::Claimed;
        Ok(())
    }
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
        init,
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
        init,
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
    #[account(
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
}

#[error_code]
pub enum PayrollError {
    #[msg("The identifier must contain 1 to 64 bytes.")]
    InvalidIdentifier,
    #[msg("This contributor claim has already been completed.")]
    InvalidClaimTransition,
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
            &[
                b"workspace",
                authority.as_ref(),
                &workspace_seed,
            ],
            &crate::ID,
        );
        let (same, _) = Pubkey::find_program_address(
            &[
                b"workspace",
                authority.as_ref(),
                &workspace_seed,
            ],
            &crate::ID,
        );
        let (other, _) = Pubkey::find_program_address(
            &[
                b"workspace",
                other_authority.as_ref(),
                &workspace_seed,
            ],
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
            &[b"claim", workspace.as_ref(), contributor.as_ref(), &claim_id],
            &crate::ID,
        );
        let other_id = [8; 32];
        let (other_claim, _) = Pubkey::find_program_address(
            &[b"claim", workspace.as_ref(), contributor.as_ref(), &other_id],
            &crate::ID,
        );

        assert_ne!(first, other_claim);
    }
}
