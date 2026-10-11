use anchor_lang::prelude::*;

declare_id!("A9G24bGQp9ospDBaXux1xqYBoQHYgQXtVSTFoVTjxo9k");

pub const MAX_ID_LENGTH: usize = 64;

#[program]
pub mod paylore_payroll {
    use super::*;

    pub fn initialize_workspace(
        ctx: Context<InitializeWorkspace>,
        workspace_id: String,
    ) -> Result<()> {
        validate_identifier(&workspace_id)?;
        let workspace = &mut ctx.accounts.workspace;
        workspace.authority = ctx.accounts.authority.key();
        workspace.workspace_id = workspace_id;
        workspace.bump = ctx.bumps.workspace;
        Ok(())
    }

    pub fn create_claim(
        ctx: Context<CreateClaim>,
        claim_id: String,
    ) -> Result<()> {
        validate_identifier(&claim_id)?;
        let claim = &mut ctx.accounts.claim;
        claim.workspace = ctx.accounts.workspace.key();
        claim.contributor = ctx.accounts.contributor.key();
        claim.claim_id = claim_id;
        claim.claimed = false;
        claim.bump = ctx.bumps.claim;
        Ok(())
    }

    pub fn mark_claimed(ctx: Context<MarkClaimed>) -> Result<()> {
        require!(!ctx.accounts.claim.claimed, PayrollError::AlreadyClaimed);
        ctx.accounts.claim.claimed = true;
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
#[instruction(workspace_id: String)]
pub struct InitializeWorkspace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = WorkspaceState::SPACE,
        seeds = [b"workspace", authority.key().as_ref(), workspace_id.as_bytes()],
        bump
    )]
    pub workspace: Account<'info, WorkspaceState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claim_id: String)]
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
            workspace.workspace_id.as_bytes()
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
            claim_id.as_bytes()
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
            claim.claim_id.as_bytes()
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
    pub bump: u8,
}

impl WorkspaceState {
    pub const SPACE: usize = 8 + 32 + 4 + MAX_ID_LENGTH + 1;
}

#[account]
pub struct ClaimState {
    pub workspace: Pubkey,
    pub contributor: Pubkey,
    pub claim_id: String,
    pub claimed: bool,
    pub bump: u8,
}

impl ClaimState {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + MAX_ID_LENGTH + 1 + 1;
}

#[error_code]
pub enum PayrollError {
    #[msg("The identifier must contain 1 to 64 bytes.")]
    InvalidIdentifier,
    #[msg("This contributor claim has already been completed.")]
    AlreadyClaimed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_pda_is_scoped_to_authority_and_workspace_id() {
        let authority = Pubkey::new_unique();
        let other_authority = Pubkey::new_unique();
        let (first, _) = Pubkey::find_program_address(
            &[b"workspace", authority.as_ref(), b"organization-a"],
            &crate::ID,
        );
        let (same, _) = Pubkey::find_program_address(
            &[b"workspace", authority.as_ref(), b"organization-a"],
            &crate::ID,
        );
        let (other, _) = Pubkey::find_program_address(
            &[b"workspace", other_authority.as_ref(), b"organization-a"],
            &crate::ID,
        );

        assert_eq!(first, same);
        assert_ne!(first, other);
    }

    #[test]
    fn claim_pda_is_scoped_to_workspace_contributor_and_claim_id() {
        let workspace = Pubkey::new_unique();
        let contributor = Pubkey::new_unique();
        let (first, _) = Pubkey::find_program_address(
            &[b"claim", workspace.as_ref(), contributor.as_ref(), b"claim-1"],
            &crate::ID,
        );
        let (other_claim, _) = Pubkey::find_program_address(
            &[b"claim", workspace.as_ref(), contributor.as_ref(), b"claim-2"],
            &crate::ID,
        );

        assert_ne!(first, other_claim);
    }
}
