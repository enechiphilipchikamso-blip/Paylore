use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod paylore_payroll {
    use super::*;

    pub fn foundation_ping(_ctx: Context<FoundationPing>) -> Result<()> {
        msg!("Paylore Batch 01 foundation ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct FoundationPing {}