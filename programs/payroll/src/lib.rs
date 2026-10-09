use anchor_lang::prelude::*;

declare_id!("A9G24bGQp9ospDBaXux1xqYBoQHYgQXtVSTFoVTjxo9k");

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