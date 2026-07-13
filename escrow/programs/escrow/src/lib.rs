use anchor_lang::prelude::*;
use anchor_lang::system_program;
use sha2::{Sha256, Digest};
use anchor_spl::token::spl_token::native_mint;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx");

// ── Error Codes ──────────────────────────────────────────────────────

#[error_code]
pub enum EscrowError {
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
    #[msg("Caller is not authorized for this operation")]
    Unauthorized,
    #[msg("Invalid deal status for this operation")]
    InvalidState,
    #[msg("Funds have already been deposited for this party")]
    AlreadyDeposited,
    #[msg("Collateral has not been fully locked by both parties")]
    CollateralNotLocked,
    #[msg("Payment has not been locked yet")]
    PaymentNotLocked,
    #[msg("Timeout has not been reached yet")]
    TimeoutNotReached,
    #[msg("Deal is already completed")]
    DealAlreadyCompleted,
    #[msg("Deal is already refunded")]
    DealAlreadyRefunded,
    #[msg("Arithmetic overflow or underflow")]
    ArithmeticOverflow,
    #[msg("Insufficient lamports in escrow for this disbursement")]
    InsufficientFunds,
    #[msg("String input exceeds maximum allowed length")]
    StringTooLong,
    #[msg("Timeout must be in the future")]
    InvalidTimeout,
    #[msg("Deal is not in a terminal state; cannot close")]
    DealNotTerminal,
    #[msg("Contract is paused by admin")]
    Paused,
    #[msg("Deal has already been cancelled")]
    DealAlreadyCancelled,
    #[msg("Mint mismatch between deal and provided account")]
    MintMismatch,
    #[msg("Terms hash is required for Privacy mode deals")]
    TermsHashRequired,
    #[msg("Terms hash mismatch during reveal")]
    TermsHashMismatch,
    #[msg("Terms already revealed — double reveal prevented")]
    TermsAlreadyRevealed,
    #[msg("Deal must be completed before revealing terms")]
    DealNotCompleted,
    #[msg("SPORT positions are native SOL only in v1")]
    SportNativeSolOnly,
    #[msg("SPORT position is not valid for this operation")]
    InvalidSportPosition,
    #[msg("SPORT position funding window has expired")]
    SportPositionExpired,
    #[msg("SPORT position is not funded")]
    SportPositionNotFunded,
    #[msg("SPORT position has already been funded")]
    SportPositionAlreadyFunded,
    #[msg("SPORT positions do not form a valid equal-stake opposite-side match")]
    SportPositionMismatch,
    #[msg("SPORT positions cannot self-match")]
    SportSelfMatch,
    #[msg("SPORT deals must be created by committing prefunded SPORT positions")]
    SportDealRequiresPrefundedPositions,
}

// ── Events ───────────────────────────────────────────────────────────

#[event]
pub struct DealCreated {
    pub deal_id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub middleman: Pubkey,
    pub trade_mode: TradeMode,
    pub mint: Pubkey,
    pub decimals: u8,
    pub price: u64,
    pub collateral_buyer: u64,
    pub collateral_seller: u64,
    pub timeout: i64,
}

#[event]
pub struct CollateralLockedEvent {
    pub deal_id: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub both_locked: bool,
}

#[event]
pub struct PaymentLockedEvent {
    pub deal_id: u64,
    pub buyer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FundsReleased {
    pub deal_id: u64,
    pub seller_received: u64,
    pub buyer_refunded: u64,
    pub middleman_fee: u64,
}

#[event]
pub struct BuyerSettlementReleased {
    pub deal_id: u64,
    pub buyer_received: u64,
    pub seller_forfeited: u64,
    pub middleman_fee: u64,
}

#[event]
pub struct Refunded {
    pub deal_id: u64,
    pub buyer_refunded: u64,
    pub seller_refunded: u64,
}

#[event]
pub struct DealCancelled {
    pub deal_id: u64,
    pub cancelled_by: Pubkey,
    pub buyer_refunded: u64,
    pub seller_refunded: u64,
}

#[event]
pub struct DealClosed {
    pub deal_id: u64,
    pub rent_reclaimed_by: Pubkey,
}

#[event]
pub struct TermsCommitted {
    pub deal_id: u64,
    pub terms_hash: [u8; 32],
}

#[event]
pub struct TermsRevealed {
    pub deal_id: u64,
    pub verified: bool,
}

#[event]
pub struct DepositConfirmed {
    pub deal_id: u64,
    pub confirmed_by: Pubkey,
    pub deposit_type: String,
    pub both_collaterals_locked: bool,
    pub payment_locked: bool,
}

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
}

#[event]
pub struct PauseToggled {
    pub paused: bool,
    pub authority: Pubkey,
}

#[event]
pub struct SportPositionCreated {
    pub position_id_hash: [u8; 32],
    pub fixture_hash: [u8; 32],
    pub market_hash: [u8; 32],
    pub selection_hash: [u8; 32],
    pub owner: Pubkey,
    pub side: SportPositionSide,
    pub stake: u64,
    pub expires_at: i64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionFunded {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub stake: u64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionCancelled {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub refunded: u64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionsCommitted {
    pub deal_id: u64,
    pub buyer_position_id_hash: [u8; 32],
    pub seller_position_id_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub stake: u64,
}

#[event]
pub struct SportPositionV2Created {
    pub position_id_hash: [u8; 32],
    pub fixture_hash: [u8; 32],
    pub market_hash: [u8; 32],
    pub selection_hash: [u8; 32],
    pub owner: Pubkey,
    pub side: SportPositionSide,
    pub total_stake: u64,
    pub expires_at: i64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionV2Funded {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub total_stake: u64,
    pub available_stake: u64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionV2RemainingCancelled {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub refunded: u64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionV2ExpiredRemainingRefunded {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub keeper: Pubkey,
    pub refunded: u64,
    pub vault: Pubkey,
}

#[event]
pub struct SportPositionFillCommitted {
    pub deal_id: u64,
    pub buyer_position_id_hash: [u8; 32],
    pub seller_position_id_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub fill_lamports: u64,
}

#[event]
pub struct SportPositionV2Closed {
    pub position_id_hash: [u8; 32],
    pub owner: Pubkey,
    pub vault: Pubkey,
}

// ── Enums ────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum TradeMode {
    Normal,  // 100 bps (1.0% fee)
    Privacy, // 110 bps (1.1% fee)
    Sport,   // 100 bps (1.0% fee), prefunded equal-stake positions
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum DealStatus {
    Created,
    CollateralLocked,
    PaymentLocked,
    Completed,
    Refunded,
    Cancelled,
}

/// Deposit type for the confirm_deposit instruction.
/// The middleman specifies which deposit is being confirmed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DepositType {
    BuyerCollateral,
    SellerCollateral,
    BuyerPayment,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum SportPositionSide {
    Back,
    Lay,
}

const SPORT_SELECTION_PART1_HASH: [u8; 32] = [
    89, 224, 163, 204, 122, 12, 69, 249, 103, 53, 191, 31, 6, 50, 93, 185,
    11, 75, 183, 66, 242, 87, 223, 18, 182, 177, 141, 243, 210, 18, 100, 153,
];
const SPORT_SELECTION_PART2_HASH: [u8; 32] = [
    71, 77, 60, 154, 11, 82, 183, 104, 183, 197, 74, 255, 178, 195, 134, 169,
    33, 166, 179, 48, 7, 16, 156, 112, 190, 123, 83, 110, 186, 23, 107, 180,
];

fn is_participant_complement_pair(left: [u8; 32], right: [u8; 32]) -> bool {
    (left == SPORT_SELECTION_PART1_HASH && right == SPORT_SELECTION_PART2_HASH)
        || (left == SPORT_SELECTION_PART2_HASH && right == SPORT_SELECTION_PART1_HASH)
}

// ── State ────────────────────────────────────────────────────────────

/// Global config PDA — stores admin authority and paused flag.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority who can pause/unpause + transfer authority
    pub authority: Pubkey,
    /// If true, all deal-mutating instructions are blocked
    pub paused: bool,
    /// PDA bump seed
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    /// Unique identifier for this deal
    pub deal_id: u64,
    /// Buyer's wallet pubkey
    pub buyer: Pubkey,
    /// Seller's wallet pubkey
    pub seller: Pubkey,
    /// AI middleman agent pubkey
    pub middleman: Pubkey,
    /// Trading mode (Normal or Privacy/ZK)
    pub trade_mode: TradeMode,
    /// Token mint this deal is denominated in
    pub mint: Pubkey,
    /// The decimals of the token mint (for off-chain calculation)
    pub decimals: u8,
    /// Short asset type label (e.g., "SOL", "USDC")
    #[max_len(32)]
    pub asset_type: String,
    /// Longer description of the asset or terms
    #[max_len(128)]
    pub asset_description: String,
    /// Agreed price in lamports/tokens
    pub price: u64,
    /// Buyer's required collateral
    pub collateral_buyer: u64,
    /// Seller's required collateral
    pub collateral_seller: u64,
    /// Whether the buyer has locked their collateral
    pub buyer_collateral_locked: bool,
    /// Whether the seller has locked their collateral
    pub seller_collateral_locked: bool,
    /// Whether the buyer has locked the payment
    pub payment_locked: bool,
    /// Current deal lifecycle status
    pub status: DealStatus,
    /// Unix timestamp when deal was created
    pub created_at: i64,
    /// Unix timestamp after which timeout refund is allowed
    pub timeout: i64,
    /// Fee in basis points (100 = 1%)
    pub middleman_fee_bps: u16,
    /// PDA bump seed
    pub bump: u8,
    /// SHA-256 hash of the agreed terms (price, collateral, asset, nonce).
    /// Only populated when trade_mode == Privacy. Zero-filled for Normal mode.
    pub terms_hash: [u8; 32],
    /// Whether the terms have been revealed and verified post-settlement.
    pub terms_revealed: bool,
}

#[account]
#[derive(InitSpace)]
pub struct SportPositionVault {
    /// SHA-256(positionId) generated off-chain and used in PDA seeds.
    pub position_id_hash: [u8; 32],
    /// SHA-256(fixtureId) from the TxLINE fixture.
    pub fixture_hash: [u8; 32],
    /// SHA-256(marketType), e.g. 1X2_PARTICIPANT_RESULT.
    pub market_hash: [u8; 32],
    /// SHA-256(selection), e.g. part1/draw/part2.
    pub selection_hash: [u8; 32],
    /// Position owner. Only this signer can fund or cancel before match.
    pub owner: Pubkey,
    /// V1 is native SOL only, but storing mint makes state self-describing.
    pub mint: Pubkey,
    /// Back = buyer side in the committed deal, Lay = seller side.
    pub side: SportPositionSide,
    /// Exact stake in lamports. V1 requires equal stake on both sides.
    pub stake: u64,
    /// True only after exact owner funding lands in this PDA.
    pub funded: bool,
    pub created_at: i64,
    pub funded_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SportPositionVaultV2 {
    /// SHA-256(positionId) generated off-chain and used in PDA seeds.
    pub position_id_hash: [u8; 32],
    /// SHA-256(fixtureId) from the TxLINE fixture.
    pub fixture_hash: [u8; 32],
    /// SHA-256(marketType), e.g. 1X2_PARTICIPANT_RESULT.
    pub market_hash: [u8; 32],
    /// SHA-256(selection), e.g. part1/draw/part2.
    pub selection_hash: [u8; 32],
    /// Position owner. Only this signer can fund or cancel before match.
    pub owner: Pubkey,
    /// V2 remains native SOL only, but stores mint for account validation.
    pub mint: Pubkey,
    /// Back = buyer side in committed fills, Lay = seller side.
    pub side: SportPositionSide,
    /// Original locked stake in lamports.
    pub total_stake: u64,
    /// Stake still available for new fills.
    pub available_stake: u64,
    /// Stake already committed into fill deals.
    pub committed_stake: u64,
    /// Stake refunded from unmatched remaining liquidity.
    pub refunded_stake: u64,
    /// True only after owner funding lands in this PDA.
    pub funded: bool,
    pub created_at: i64,
    pub funded_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

impl Deal {
    pub const MAX_ASSET_TYPE_LEN: usize = 32;
    pub const MAX_ASSET_DESC_LEN: usize = 128;

    /// Returns true if the deal is in a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            DealStatus::Completed | DealStatus::Refunded | DealStatus::Cancelled
        )
    }
}

// ── Helper: rent-safe lamport transfer from PDA ──────────────────────

/// Transfers lamports from a program-owned PDA to a target account.
/// Verifies rent-exemption is maintained on the source PDA.
fn transfer_lamports_from_pda<'info>(
    pda: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **pda.try_borrow_mut_lamports()? -= amount;
    **target.try_borrow_mut_lamports()? += amount;
    Ok(())
}

/// Verifies the PDA will remain rent-exempt after a total outflow.
fn assert_rent_safe(pda: &AccountInfo, total_out: u64) -> Result<()> {
    let rent = Rent::get()?;
    let min_rent = rent.minimum_balance(pda.data_len());
    let remaining = pda
        .lamports()
        .checked_sub(total_out)
        .ok_or(EscrowError::InsufficientFunds)?;
    require!(remaining >= min_rent, EscrowError::InsufficientFunds);
    Ok(())
}

fn is_native_sol_mint(mint: &Pubkey) -> bool {
    *mint == native_mint::id()
}

fn escrowed_native_lamports(pda: &AccountInfo) -> Result<u64> {
    let rent = Rent::get()?;
    let min_rent = rent.minimum_balance(pda.data_len());
    Ok(pda.lamports().saturating_sub(min_rent))
}

fn checked_token_account(
    account: &AccountInfo,
    expected_mint: Pubkey,
    expected_owner: Pubkey,
) -> Result<TokenAccount> {
    let mut data: &[u8] = &account.try_borrow_data()?;
    let token_account = TokenAccount::try_deserialize(&mut data)?;
    require!(token_account.mint == expected_mint, EscrowError::MintMismatch);
    require!(token_account.owner == expected_owner, EscrowError::Unauthorized);
    Ok(token_account)
}

/// Helper method to transfer SPL tokens from user to PDA (or vice versa).
impl<'info> Deal {
    pub fn transfer_tokens_to_pda(
        &self,
        from: AccountInfo<'info>,
        to: AccountInfo<'info>,
        authority: AccountInfo<'info>,
        token_program: AccountInfo<'info>,
        amount: u64,
    ) -> Result<()> {
        let cpi_accounts = Transfer {
            from,
            to,
            authority,
        };
        let cpi_ctx = CpiContext::new(token_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)
    }

    pub fn transfer_tokens_from_pda(
        &self,
        from: AccountInfo<'info>,
        to: AccountInfo<'info>,
        authority: AccountInfo<'info>,
        token_program: AccountInfo<'info>,
        amount: u64,
        bump: u8,
    ) -> Result<()> {
        let deal_id_bytes = self.deal_id.to_le_bytes();
        let seeds = &[
            b"deal",
            self.buyer.as_ref(),
            deal_id_bytes.as_ref(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from,
            to,
            authority,
        };
        let cpi_ctx = CpiContext::new_with_signer(token_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)
    }
}

// ── Account Contexts ─────────────────────────────────────────────────

// ─── Admin Contexts ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = authority.key() == config.authority @ EscrowError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,
}

// ─── Deal Contexts ───────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    /// The deal PDA — unique per (buyer, deal_id)
    #[account(
        init,
        payer = initializer,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", buyer.key().as_ref(), deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,

    /// Must be the buyer or the middleman agent
    #[account(
        mut,
        constraint = initializer.key() == buyer.key()
            || initializer.key() == middleman.key() @ EscrowError::Unauthorized
    )]
    pub initializer: Signer<'info>,

    /// CHECK: Buyer pubkey — validated by the initializer constraint above
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: Seller pubkey — validated off-chain by the middleman agent
    pub seller: UncheckedAccount<'info>,

    /// CHECK: Middleman agent pubkey — stored for future authorization checks
    pub middleman: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    /// Global config — checked for pause status
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LockCollateral<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        mut,
        constraint = user.key() == deal.buyer || user.key() == deal.seller @ EscrowError::Unauthorized
    )]
    pub user: Signer<'info>,
    #[account(
        mut,
        associated_token::mint = deal.mint,
        associated_token::authority = deal
    )]
    pub deal_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = deal.mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LockPayment<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
        constraint = buyer.key() == deal.buyer @ EscrowError::Unauthorized
    )]
    pub deal: Account<'info, Deal>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        associated_token::mint = deal.mint,
        associated_token::authority = deal
    )]
    pub deal_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = deal.mint,
        associated_token::authority = buyer
    )]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseFunds<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = middleman.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub middleman: Signer<'info>,
    /// CHECK: Validated against deal.buyer
    #[account(
        mut,
        constraint = buyer.key() == deal.buyer @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.seller
    #[account(
        mut,
        constraint = seller.key() == deal.seller @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.middleman
    #[account(
        mut,
        constraint = fee_receiver.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub fee_receiver: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub deal_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub buyer_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub seller_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub fee_ata: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleToBuyer<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = middleman.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub middleman: Signer<'info>,
    /// CHECK: Validated against deal.buyer
    #[account(
        mut,
        constraint = buyer.key() == deal.buyer @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.seller
    #[account(
        mut,
        constraint = seller.key() == deal.seller @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.middleman
    #[account(
        mut,
        constraint = fee_receiver.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub fee_receiver: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub deal_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub buyer_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub seller_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub fee_ata: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelDeal<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = caller.key() == deal.buyer
            || caller.key() == deal.seller
            || caller.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub caller: Signer<'info>,
    /// CHECK: Validated against deal.buyer
    #[account(
        mut,
        constraint = buyer.key() == deal.buyer @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.seller
    #[account(
        mut,
        constraint = seller.key() == deal.seller @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub deal_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub buyer_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub seller_ata: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundOnTimeout<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = caller.key() == deal.buyer
            || caller.key() == deal.seller
            || caller.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub caller: Signer<'info>,
    /// CHECK: Validated against deal.buyer
    #[account(
        mut,
        constraint = buyer.key() == deal.buyer @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Validated against deal.seller
    #[account(
        mut,
        constraint = seller.key() == deal.seller @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub deal_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub buyer_ata: UncheckedAccount<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub seller_ata: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseDeal<'info> {
    /// The deal PDA — closed and rent reclaimed
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
        close = rent_receiver,
    )]
    pub deal: Account<'info, Deal>,

    /// Only the buyer, seller, or middleman can close a finished deal
    #[account(
        constraint = authority.key() == deal.buyer
            || authority.key() == deal.seller
            || authority.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// CHECK: Receives the reclaimed rent — must be one of the deal participants
    #[account(
        mut,
        constraint = rent_receiver.key() == deal.buyer
            || rent_receiver.key() == deal.seller
            || rent_receiver.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub rent_receiver: UncheckedAccount<'info>,
}

/// Confirm Deposit — only the middleman can call this.
/// Used when buyer/seller send plain SOL transfers to the deal PDA.
/// The middleman watches the PDA balance and confirms deposits arrived.
#[derive(Accounts)]
pub struct ConfirmDeposit<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = middleman.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub middleman: Signer<'info>,
    /// CHECK: Only required and manually validated for SPL-token deals.
    #[account(mut)]
    pub deal_ata: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(position_id_hash: [u8; 32])]
pub struct InitializeSportPosition<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + SportPositionVault::INIT_SPACE,
        seeds = [b"sport_position", position_id_hash.as_ref()],
        bump
    )]
    pub sport_position: Account<'info, SportPositionVault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSportPosition<'info> {
    #[account(
        mut,
        seeds = [b"sport_position", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized
    )]
    pub sport_position: Account<'info, SportPositionVault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSportPosition<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [b"sport_position", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized
    )]
    pub sport_position: Account<'info, SportPositionVault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CommitSportPositionsToDeal<'info> {
    #[account(
        mut,
        close = buyer,
        seeds = [b"sport_position", buyer_position.position_id_hash.as_ref()],
        bump = buyer_position.bump,
    )]
    pub buyer_position: Account<'info, SportPositionVault>,

    #[account(
        mut,
        close = seller,
        seeds = [b"sport_position", seller_position.position_id_hash.as_ref()],
        bump = seller_position.bump,
    )]
    pub seller_position: Account<'info, SportPositionVault>,

    #[account(
        init,
        payer = middleman,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", buyer.key().as_ref(), deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,

    #[account(mut)]
    pub middleman: Signer<'info>,

    /// CHECK: Must match the funded back-side SPORT position owner.
    #[account(
        mut,
        constraint = buyer.key() == buyer_position.owner @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: Must match the funded lay-side SPORT position owner.
    #[account(
        mut,
        constraint = seller.key() == seller_position.owner @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(position_id_hash: [u8; 32])]
pub struct InitializeSportPositionV2<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + SportPositionVaultV2::INIT_SPACE,
        seeds = [b"sport_position_v2", position_id_hash.as_ref()],
        bump
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSportPositionV2<'info> {
    #[account(
        mut,
        seeds = [b"sport_position_v2", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSportPositionRemaining<'info> {
    #[account(
        mut,
        seeds = [b"sport_position_v2", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct RefundExpiredSportPositionRemaining<'info> {
    #[account(
        mut,
        seeds = [b"sport_position_v2", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    /// CHECK: Receives the expired unmatched stake. Must equal the stored owner.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CloseExpiredSportPositionV2IfEmpty<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [b"sport_position_v2", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized,
        constraint = sport_position.available_stake == 0 @ EscrowError::InvalidSportPosition
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    /// CHECK: Receives reclaimed rent. Must equal the stored owner.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CloseSportPositionV2IfEmpty<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [b"sport_position_v2", sport_position.position_id_hash.as_ref()],
        bump = sport_position.bump,
        constraint = owner.key() == sport_position.owner @ EscrowError::Unauthorized,
        constraint = sport_position.available_stake == 0 @ EscrowError::InvalidSportPosition
    )]
    pub sport_position: Account<'info, SportPositionVaultV2>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CommitSportPositionFillToDeal<'info> {
    #[account(
        mut,
        seeds = [b"sport_position_v2", buyer_position.position_id_hash.as_ref()],
        bump = buyer_position.bump,
    )]
    pub buyer_position: Account<'info, SportPositionVaultV2>,

    #[account(
        mut,
        seeds = [b"sport_position_v2", seller_position.position_id_hash.as_ref()],
        bump = seller_position.bump,
    )]
    pub seller_position: Account<'info, SportPositionVaultV2>,

    #[account(
        init,
        payer = middleman,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", buyer.key().as_ref(), deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,

    #[account(mut)]
    pub middleman: Signer<'info>,

    /// CHECK: Must match the funded back-side SPORT position owner.
    #[account(
        mut,
        constraint = buyer.key() == buyer_position.owner @ EscrowError::Unauthorized
    )]
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: Must match the funded lay-side SPORT position owner.
    #[account(
        mut,
        constraint = seller.key() == seller_position.owner @ EscrowError::Unauthorized
    )]
    pub seller: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

/// Reveal and verify terms for a privacy-mode deal.
/// Only the middleman or either party can reveal terms post-completion.
#[derive(Accounts)]
pub struct RevealTerms<'info> {
    #[account(
        mut,
        seeds = [b"deal", deal.buyer.as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        constraint = caller.key() == deal.buyer
            || caller.key() == deal.seller
            || caller.key() == deal.middleman @ EscrowError::Unauthorized
    )]
    pub caller: Signer<'info>,
}

// ── Program ──────────────────────────────────────────────────────────

#[program]
pub mod escrow {
    use super::*;

    // ─── Admin Instructions ──────────────────────────────────────────

    /// Initializes the global config. Can only be called once.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.paused = false;
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            authority: config.authority,
        });

        Ok(())
    }

    /// Toggles the paused state. Only the config authority can call this.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;

        emit!(PauseToggled {
            paused,
            authority: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    // ─── SPORT Position Instructions ────────────────────────────────

    /// Creates a native-SOL SPORT position vault PDA. The position is not public
    /// or matchable until `fund_sport_position` transfers the exact stake.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_sport_position(
        ctx: Context<InitializeSportPosition>,
        position_id_hash: [u8; 32],
        fixture_hash: [u8; 32],
        market_hash: [u8; 32],
        selection_hash: [u8; 32],
        side: SportPositionSide,
        stake: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(is_native_sol_mint(&ctx.accounts.mint.key()), EscrowError::SportNativeSolOnly);
        require!(stake > 0, EscrowError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, EscrowError::InvalidTimeout);

        let vault = ctx.accounts.sport_position.key();
        let position = &mut ctx.accounts.sport_position;
        position.position_id_hash = position_id_hash;
        position.fixture_hash = fixture_hash;
        position.market_hash = market_hash;
        position.selection_hash = selection_hash;
        position.owner = ctx.accounts.owner.key();
        position.mint = ctx.accounts.mint.key();
        position.side = side.clone();
        position.stake = stake;
        position.funded = false;
        position.created_at = now;
        position.funded_at = 0;
        position.expires_at = expires_at;
        position.bump = ctx.bumps.sport_position;

        emit!(SportPositionCreated {
            position_id_hash,
            fixture_hash,
            market_hash,
            selection_hash,
            owner: position.owner,
            side,
            stake,
            expires_at,
            vault,
        });

        Ok(())
    }

    /// Funds a SPORT position by transferring exactly the configured stake from
    /// the owner into the position vault PDA.
    pub fn fund_sport_position(ctx: Context<FundSportPosition>) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let position_info = ctx.accounts.sport_position.to_account_info();
        let position = &mut ctx.accounts.sport_position;

        require!(!position.funded, EscrowError::SportPositionAlreadyFunded);
        require!(position.stake > 0, EscrowError::InvalidAmount);
        require!(now <= position.expires_at, EscrowError::SportPositionExpired);
        require!(is_native_sol_mint(&position.mint), EscrowError::SportNativeSolOnly);

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: position_info.clone(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
        );
        system_program::transfer(cpi_ctx, position.stake)?;

        position.funded = true;
        position.funded_at = now;

        emit!(SportPositionFunded {
            position_id_hash: position.position_id_hash,
            owner: position.owner,
            stake: position.stake,
            vault: position_info.key(),
        });

        Ok(())
    }

    /// Cancels an unmatched SPORT position. If funded, Anchor's close handler
    /// returns rent plus the locked stake to the owner.
    pub fn cancel_sport_position(ctx: Context<CancelSportPosition>) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let position = &ctx.accounts.sport_position;
        let refunded = if position.funded { position.stake } else { 0 };

        emit!(SportPositionCancelled {
            position_id_hash: position.position_id_hash,
            owner: position.owner,
            refunded,
            vault: ctx.accounts.sport_position.key(),
        });

        Ok(())
    }

    /// Atomically commits one funded back position and one funded lay position
    /// into a SPORT deal. The resulting deal starts at `PaymentLocked`, so the
    /// TxLINE settlement engine can call the existing buyer/seller payout
    /// instructions without any negotiation or manual deposit phase.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_sport_positions_to_deal(
        ctx: Context<CommitSportPositionsToDeal>,
        deal_id: u64,
        timeout: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(is_native_sol_mint(&ctx.accounts.mint.key()), EscrowError::SportNativeSolOnly);

        let now = Clock::get()?.unix_timestamp;
        require!(timeout > now, EscrowError::InvalidTimeout);

        let buyer_position = &ctx.accounts.buyer_position;
        let seller_position = &ctx.accounts.seller_position;

        require!(buyer_position.funded, EscrowError::SportPositionNotFunded);
        require!(seller_position.funded, EscrowError::SportPositionNotFunded);
        require!(now <= buyer_position.expires_at, EscrowError::SportPositionExpired);
        require!(now <= seller_position.expires_at, EscrowError::SportPositionExpired);
        require!(buyer_position.owner != seller_position.owner, EscrowError::SportSelfMatch);
        require!(buyer_position.side == SportPositionSide::Back, EscrowError::SportPositionMismatch);
        require!(seller_position.side == SportPositionSide::Lay, EscrowError::SportPositionMismatch);
        require!(buyer_position.mint == ctx.accounts.mint.key(), EscrowError::MintMismatch);
        require!(seller_position.mint == ctx.accounts.mint.key(), EscrowError::MintMismatch);
        require!(buyer_position.fixture_hash == seller_position.fixture_hash, EscrowError::SportPositionMismatch);
        require!(buyer_position.market_hash == seller_position.market_hash, EscrowError::SportPositionMismatch);
        require!(buyer_position.selection_hash == seller_position.selection_hash, EscrowError::SportPositionMismatch);
        require!(buyer_position.stake == seller_position.stake, EscrowError::SportPositionMismatch);
        require!(buyer_position.stake > 0, EscrowError::InvalidAmount);

        let stake = buyer_position.stake;
        let buyer_position_id_hash = buyer_position.position_id_hash;
        let seller_position_id_hash = seller_position.position_id_hash;
        let buyer_key = ctx.accounts.buyer.key();
        let seller_key = ctx.accounts.seller.key();
        let middleman_key = ctx.accounts.middleman.key();
        let mint_key = ctx.accounts.mint.key();
        let buyer_position_info = ctx.accounts.buyer_position.to_account_info();
        let seller_position_info = ctx.accounts.seller_position.to_account_info();
        let deal_info = ctx.accounts.deal.to_account_info();

        assert_rent_safe(&buyer_position_info, stake)?;
        assert_rent_safe(&seller_position_info, stake)?;
        transfer_lamports_from_pda(&buyer_position_info, &deal_info, stake)?;
        transfer_lamports_from_pda(&seller_position_info, &deal_info, stake)?;

        let deal = &mut ctx.accounts.deal;
        deal.deal_id = deal_id;
        deal.buyer = buyer_key;
        deal.seller = seller_key;
        deal.middleman = middleman_key;
        deal.trade_mode = TradeMode::Sport;
        deal.mint = mint_key;
        deal.decimals = ctx.accounts.mint.decimals;
        deal.asset_type = "SPORT".to_string();
        deal.asset_description = "Prefunded SPORT prediction".to_string();
        deal.price = stake;
        deal.collateral_buyer = 0;
        deal.collateral_seller = stake;
        deal.buyer_collateral_locked = true;
        deal.seller_collateral_locked = true;
        deal.payment_locked = true;
        deal.status = DealStatus::PaymentLocked;
        deal.created_at = now;
        deal.timeout = timeout;
        deal.middleman_fee_bps = 100;
        deal.bump = ctx.bumps.deal;
        deal.terms_hash = [0u8; 32];
        deal.terms_revealed = false;

        emit!(DealCreated {
            deal_id,
            buyer: deal.buyer,
            seller: deal.seller,
            middleman: deal.middleman,
            trade_mode: TradeMode::Sport,
            mint: deal.mint,
            decimals: deal.decimals,
            price: deal.price,
            collateral_buyer: deal.collateral_buyer,
            collateral_seller: deal.collateral_seller,
            timeout,
        });

        emit!(SportPositionsCommitted {
            deal_id,
            buyer_position_id_hash,
            seller_position_id_hash,
            buyer: buyer_key,
            seller: seller_key,
            stake,
        });

        Ok(())
    }

    /// Creates a v2 native-SOL SPORT position vault PDA. V2 supports partial
    /// fills by tracking available, committed, and refunded stake separately.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_sport_position_v2(
        ctx: Context<InitializeSportPositionV2>,
        position_id_hash: [u8; 32],
        fixture_hash: [u8; 32],
        market_hash: [u8; 32],
        selection_hash: [u8; 32],
        side: SportPositionSide,
        total_stake: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(is_native_sol_mint(&ctx.accounts.mint.key()), EscrowError::SportNativeSolOnly);
        require!(total_stake > 0, EscrowError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, EscrowError::InvalidTimeout);

        let vault = ctx.accounts.sport_position.key();
        let position = &mut ctx.accounts.sport_position;
        position.position_id_hash = position_id_hash;
        position.fixture_hash = fixture_hash;
        position.market_hash = market_hash;
        position.selection_hash = selection_hash;
        position.owner = ctx.accounts.owner.key();
        position.mint = ctx.accounts.mint.key();
        position.side = side.clone();
        position.total_stake = total_stake;
        position.available_stake = 0;
        position.committed_stake = 0;
        position.refunded_stake = 0;
        position.funded = false;
        position.created_at = now;
        position.funded_at = 0;
        position.expires_at = expires_at;
        position.bump = ctx.bumps.sport_position;

        emit!(SportPositionV2Created {
            position_id_hash,
            fixture_hash,
            market_hash,
            selection_hash,
            owner: position.owner,
            side,
            total_stake,
            expires_at,
            vault,
        });

        Ok(())
    }

    /// Funds a v2 SPORT position by transferring exactly total_stake from owner
    /// into the position vault PDA.
    pub fn fund_sport_position_v2(ctx: Context<FundSportPositionV2>) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let position_info = ctx.accounts.sport_position.to_account_info();
        let position = &mut ctx.accounts.sport_position;

        require!(!position.funded, EscrowError::SportPositionAlreadyFunded);
        require!(position.total_stake > 0, EscrowError::InvalidAmount);
        require!(position.available_stake == 0, EscrowError::InvalidSportPosition);
        require!(position.committed_stake == 0, EscrowError::InvalidSportPosition);
        require!(position.refunded_stake == 0, EscrowError::InvalidSportPosition);
        require!(now <= position.expires_at, EscrowError::SportPositionExpired);
        require!(is_native_sol_mint(&position.mint), EscrowError::SportNativeSolOnly);

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: position_info.clone(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
        );
        system_program::transfer(cpi_ctx, position.total_stake)?;

        position.funded = true;
        position.funded_at = now;
        position.available_stake = position.total_stake;

        emit!(SportPositionV2Funded {
            position_id_hash: position.position_id_hash,
            owner: position.owner,
            total_stake: position.total_stake,
            available_stake: position.available_stake,
            vault: position_info.key(),
        });

        Ok(())
    }

    /// Cancels and refunds only the unmatched remaining stake on a v2 position.
    /// Already committed fills remain locked in their individual deal PDAs.
    pub fn cancel_sport_position_remaining(ctx: Context<CancelSportPositionRemaining>) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let position_info = ctx.accounts.sport_position.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();
        let position = &mut ctx.accounts.sport_position;

        require!(position.funded, EscrowError::SportPositionNotFunded);
        let refund = position.available_stake;
        require!(refund > 0, EscrowError::InvalidAmount);

        let new_refunded = position
            .refunded_stake
            .checked_add(refund)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        assert_rent_safe(&position_info, refund)?;
        transfer_lamports_from_pda(&position_info, &owner_info, refund)?;

        position.available_stake = 0;
        position.refunded_stake = new_refunded;

        emit!(SportPositionV2RemainingCancelled {
            position_id_hash: position.position_id_hash,
            owner: position.owner,
            refunded: refund,
            vault: position_info.key(),
        });

        Ok(())
    }

    /// Permissionless keeper path for expired v2 SPORT positions. It refunds only
    /// unmatched available stake to the original owner after the position expiry.
    /// Already committed fills remain locked in their individual deal PDAs.
    pub fn refund_expired_sport_position_remaining(
        ctx: Context<RefundExpiredSportPositionRemaining>,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let position_info = ctx.accounts.sport_position.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();
        let keeper_key = ctx.accounts.keeper.key();
        let position = &mut ctx.accounts.sport_position;

        require!(position.funded, EscrowError::SportPositionNotFunded);
        require!(now > position.expires_at, EscrowError::TimeoutNotReached);
        let refund = position.available_stake;
        require!(refund > 0, EscrowError::InvalidAmount);

        let new_refunded = position
            .refunded_stake
            .checked_add(refund)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        assert_rent_safe(&position_info, refund)?;
        transfer_lamports_from_pda(&position_info, &owner_info, refund)?;

        position.available_stake = 0;
        position.refunded_stake = new_refunded;

        emit!(SportPositionV2ExpiredRemainingRefunded {
            position_id_hash: position.position_id_hash,
            owner: position.owner,
            keeper: keeper_key,
            refunded: refund,
            vault: position_info.key(),
        });

        Ok(())
    }

    /// Closes an empty v2 SPORT position vault and returns rent to owner. It can
    /// be called after all stake has been committed and/or remaining stake was
    /// cancelled.
    pub fn close_sport_position_v2_if_empty(ctx: Context<CloseSportPositionV2IfEmpty>) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(ctx.accounts.sport_position.available_stake == 0, EscrowError::InvalidSportPosition);

        emit!(SportPositionV2Closed {
            position_id_hash: ctx.accounts.sport_position.position_id_hash,
            owner: ctx.accounts.sport_position.owner,
            vault: ctx.accounts.sport_position.key(),
        });

        Ok(())
    }

    /// Permissionless keeper close for expired empty v2 SPORT position vaults.
    /// The rent always returns to the original owner.
    pub fn close_expired_sport_position_v2_if_empty(
        ctx: Context<CloseExpiredSportPositionV2IfEmpty>,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let now = Clock::get()?.unix_timestamp;
        require!(now > ctx.accounts.sport_position.expires_at, EscrowError::TimeoutNotReached);
        require!(ctx.accounts.sport_position.available_stake == 0, EscrowError::InvalidSportPosition);

        emit!(SportPositionV2Closed {
            position_id_hash: ctx.accounts.sport_position.position_id_hash,
            owner: ctx.accounts.sport_position.owner,
            vault: ctx.accounts.sport_position.key(),
        });

        Ok(())
    }

    /// Commits one partial fill from a funded back position and one funded lay
    /// position into a new SPORT deal. Only fill_lamports leaves each vault.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_sport_position_fill_to_deal(
        ctx: Context<CommitSportPositionFillToDeal>,
        deal_id: u64,
        fill_lamports: u64,
        timeout: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(is_native_sol_mint(&ctx.accounts.mint.key()), EscrowError::SportNativeSolOnly);
        require!(fill_lamports > 0, EscrowError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(timeout > now, EscrowError::InvalidTimeout);

        let buyer_position = &ctx.accounts.buyer_position;
        let seller_position = &ctx.accounts.seller_position;

        require!(buyer_position.funded, EscrowError::SportPositionNotFunded);
        require!(seller_position.funded, EscrowError::SportPositionNotFunded);
        require!(now <= buyer_position.expires_at, EscrowError::SportPositionExpired);
        require!(now <= seller_position.expires_at, EscrowError::SportPositionExpired);
        require!(buyer_position.owner != seller_position.owner, EscrowError::SportSelfMatch);
        require!(buyer_position.mint == ctx.accounts.mint.key(), EscrowError::MintMismatch);
        require!(seller_position.mint == ctx.accounts.mint.key(), EscrowError::MintMismatch);
        require!(buyer_position.fixture_hash == seller_position.fixture_hash, EscrowError::SportPositionMismatch);
        require!(buyer_position.market_hash == seller_position.market_hash, EscrowError::SportPositionMismatch);
        let same_selection_back_lay = buyer_position.side == SportPositionSide::Back
            && seller_position.side == SportPositionSide::Lay
            && buyer_position.selection_hash == seller_position.selection_hash;
        let complement_back_back = buyer_position.side == SportPositionSide::Back
            && seller_position.side == SportPositionSide::Back
            && is_participant_complement_pair(
                buyer_position.selection_hash,
                seller_position.selection_hash,
            );
        require!(
            same_selection_back_lay || complement_back_back,
            EscrowError::SportPositionMismatch
        );
        require!(fill_lamports <= buyer_position.available_stake, EscrowError::InsufficientFunds);
        require!(fill_lamports <= seller_position.available_stake, EscrowError::InsufficientFunds);

        let buyer_position_id_hash = buyer_position.position_id_hash;
        let seller_position_id_hash = seller_position.position_id_hash;
        let buyer_key = ctx.accounts.buyer.key();
        let seller_key = ctx.accounts.seller.key();
        let middleman_key = ctx.accounts.middleman.key();
        let mint_key = ctx.accounts.mint.key();
        let buyer_position_info = ctx.accounts.buyer_position.to_account_info();
        let seller_position_info = ctx.accounts.seller_position.to_account_info();
        let deal_info = ctx.accounts.deal.to_account_info();

        assert_rent_safe(&buyer_position_info, fill_lamports)?;
        assert_rent_safe(&seller_position_info, fill_lamports)?;
        transfer_lamports_from_pda(&buyer_position_info, &deal_info, fill_lamports)?;
        transfer_lamports_from_pda(&seller_position_info, &deal_info, fill_lamports)?;

        let buyer_position = &mut ctx.accounts.buyer_position;
        let seller_position = &mut ctx.accounts.seller_position;

        buyer_position.available_stake = buyer_position
            .available_stake
            .checked_sub(fill_lamports)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        buyer_position.committed_stake = buyer_position
            .committed_stake
            .checked_add(fill_lamports)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        seller_position.available_stake = seller_position
            .available_stake
            .checked_sub(fill_lamports)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        seller_position.committed_stake = seller_position
            .committed_stake
            .checked_add(fill_lamports)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let deal = &mut ctx.accounts.deal;
        deal.deal_id = deal_id;
        deal.buyer = buyer_key;
        deal.seller = seller_key;
        deal.middleman = middleman_key;
        deal.trade_mode = TradeMode::Sport;
        deal.mint = mint_key;
        deal.decimals = ctx.accounts.mint.decimals;
        deal.asset_type = "SPORT".to_string();
        deal.asset_description = "Partial-fill SPORT prediction".to_string();
        deal.price = fill_lamports;
        deal.collateral_buyer = 0;
        deal.collateral_seller = fill_lamports;
        deal.buyer_collateral_locked = true;
        deal.seller_collateral_locked = true;
        deal.payment_locked = true;
        deal.status = DealStatus::PaymentLocked;
        deal.created_at = now;
        deal.timeout = timeout;
        deal.middleman_fee_bps = 100;
        deal.bump = ctx.bumps.deal;
        deal.terms_hash = [0u8; 32];
        deal.terms_revealed = false;

        emit!(DealCreated {
            deal_id,
            buyer: deal.buyer,
            seller: deal.seller,
            middleman: deal.middleman,
            trade_mode: TradeMode::Sport,
            mint: deal.mint,
            decimals: deal.decimals,
            price: deal.price,
            collateral_buyer: deal.collateral_buyer,
            collateral_seller: deal.collateral_seller,
            timeout,
        });

        emit!(SportPositionFillCommitted {
            deal_id,
            buyer_position_id_hash,
            seller_position_id_hash,
            buyer: buyer_key,
            seller: seller_key,
            fill_lamports,
        });

        Ok(())
    }

    // ─── Deal Instructions ───────────────────────────────────────────

    /// Creates a new escrow deal. Only the buyer or the middleman agent may call this.
    #[allow(clippy::too_many_arguments)]
    pub fn create_deal(
        ctx: Context<CreateDeal>,
        deal_id: u64,
        asset_type: String,
        asset_description: String,
        price: u64,
        collateral_buyer: u64,
        collateral_seller: u64,
        timeout: i64,
        trade_mode: TradeMode,
        terms_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        require!(trade_mode != TradeMode::Sport, EscrowError::SportDealRequiresPrefundedPositions);

        // ── Input validation ──
        require!(price > 0, EscrowError::InvalidAmount);
        require!(collateral_buyer > 0, EscrowError::InvalidAmount);
        require!(collateral_seller > 0, EscrowError::InvalidAmount);
        require!(asset_type.len() <= Deal::MAX_ASSET_TYPE_LEN, EscrowError::StringTooLong);
        require!(asset_description.len() <= Deal::MAX_ASSET_DESC_LEN, EscrowError::StringTooLong);

        let now = Clock::get()?.unix_timestamp;
        require!(timeout > now, EscrowError::InvalidTimeout);

        // ── Compute fee basis points ──
        let fee_bps: u16 = match trade_mode {
            TradeMode::Normal  => 100, // 1.0%
            TradeMode::Privacy => 110, // 1.1%
            TradeMode::Sport => return Err(EscrowError::SportDealRequiresPrefundedPositions.into()),
        };

        // ── Populate deal state ──
        let deal = &mut ctx.accounts.deal;
        deal.deal_id = deal_id;
        deal.buyer = ctx.accounts.buyer.key();
        deal.seller = ctx.accounts.seller.key();
        deal.middleman = ctx.accounts.middleman.key();
        deal.trade_mode = trade_mode.clone();
        deal.mint = ctx.accounts.mint.key();
        deal.decimals = ctx.accounts.mint.decimals;
        deal.asset_type = asset_type;
        deal.asset_description = asset_description;
        deal.price = price;
        deal.collateral_buyer = collateral_buyer;
        deal.collateral_seller = collateral_seller;
        deal.buyer_collateral_locked = false;
        deal.seller_collateral_locked = false;
        deal.payment_locked = false;
        deal.status = DealStatus::Created;
        deal.created_at = now;
        deal.timeout = timeout;
        deal.middleman_fee_bps = fee_bps;
        deal.bump = ctx.bumps.deal;
        deal.terms_revealed = false;

        // ── Privacy mode: require and store terms hash ──
        match deal.trade_mode {
            TradeMode::Privacy => {
                let hash = terms_hash.ok_or(EscrowError::TermsHashRequired)?;
                // Ensure the hash is non-zero (prevent empty commitments)
                require!(hash != [0u8; 32], EscrowError::TermsHashRequired);
                deal.terms_hash = hash;

                emit!(TermsCommitted {
                    deal_id,
                    terms_hash: hash,
                });
            }
            TradeMode::Normal => {
                deal.terms_hash = [0u8; 32];
            }
            TradeMode::Sport => {
                return Err(EscrowError::SportDealRequiresPrefundedPositions.into());
            }
        }

        emit!(DealCreated {
            deal_id,
            buyer: deal.buyer,
            seller: deal.seller,
            middleman: deal.middleman,
            trade_mode,
            price,
            mint: deal.mint,
            decimals: deal.decimals,
            collateral_buyer,
            collateral_seller,
            timeout,
        });

        Ok(())
    }

    /// Locks collateral for the calling party (buyer or seller).
    /// Both parties must lock before the deal advances to `CollateralLocked`.
    pub fn lock_collateral(ctx: Context<LockCollateral>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal = &mut ctx.accounts.deal;
        let user = &ctx.accounts.user;

        // ── State guard: only allowed in Created status ──
        require!(deal.status == DealStatus::Created, EscrowError::InvalidState);

        // ── Determine caller and amount ──
        let is_buyer = user.key() == deal.buyer;
        let is_seller = user.key() == deal.seller;

        let amount: u64;
        if is_buyer {
            require!(!deal.buyer_collateral_locked, EscrowError::AlreadyDeposited);
            amount = deal.collateral_buyer;
            deal.buyer_collateral_locked = true;
        } else if is_seller {
            require!(!deal.seller_collateral_locked, EscrowError::AlreadyDeposited);
            amount = deal.collateral_seller;
            deal.seller_collateral_locked = true;
        } else {
            return Err(EscrowError::Unauthorized.into());
        }

        // ── Transfer Tokens into the deal PDA ──
        deal.transfer_tokens_to_pda(
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.deal_ata.to_account_info(),
            user.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
        )?;

        // ── Advance status if both sides have locked ──
        let both_locked = deal.buyer_collateral_locked && deal.seller_collateral_locked;
        if both_locked {
            deal.status = DealStatus::CollateralLocked;
        }

        emit!(CollateralLockedEvent {
            deal_id: deal.deal_id,
            user: user.key(),
            amount,
            both_locked,
        });

        Ok(())
    }

    /// Locks the agreed price as payment from the buyer.
    /// Requires both collaterals to already be locked.
    pub fn lock_payment(ctx: Context<LockPayment>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal = &mut ctx.accounts.deal;

        // ── State guard ──
        require!(deal.status == DealStatus::CollateralLocked, EscrowError::CollateralNotLocked);
        require!(!deal.payment_locked, EscrowError::AlreadyDeposited);

        // ── Transfer price Tokens into the deal PDA ──
        deal.transfer_tokens_to_pda(
            ctx.accounts.buyer_ata.to_account_info(),
            ctx.accounts.deal_ata.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            deal.price,
        )?;

        deal.payment_locked = true;
        deal.status = DealStatus::PaymentLocked;

        emit!(PaymentLockedEvent {
            deal_id: deal.deal_id,
            buyer: ctx.accounts.buyer.key(),
            amount: deal.price,
        });

        Ok(())
    }

    /// Releases escrowed funds to the seller and refunds collateral to the buyer.
    /// Only the middleman agent can authorize this. A fee is deducted.
    ///
    /// Funds are moved via direct lamport manipulation (not system_program CPI)
    /// because the PDA is not a signer for outbound transfers. The account is
    /// closed separately via `close_deal` to reclaim rent.
    pub fn release_funds(ctx: Context<ReleaseFunds>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal_info = ctx.accounts.deal.to_account_info();
        let deal = &mut ctx.accounts.deal;

        // ── State guards ──
        require!(deal.status == DealStatus::PaymentLocked, EscrowError::PaymentNotLocked);
        require!(
            deal.buyer_collateral_locked && deal.seller_collateral_locked,
            EscrowError::CollateralNotLocked
        );
        require!(deal.payment_locked, EscrowError::PaymentNotLocked);

        // ── Calculate fee with checked arithmetic ──
        let fee = (deal.price as u128)
            .checked_mul(deal.middleman_fee_bps as u128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::ArithmeticOverflow)? as u64;

        let seller_payment = deal.price
            .checked_sub(fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let seller_total = seller_payment
            .checked_add(deal.collateral_seller)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let buyer_total = deal.collateral_buyer;

        // ── Verify deal_ata has enough tokens ──
        let total_out = seller_total
            .checked_add(buyer_total)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_add(fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        if is_native_sol_mint(&deal.mint) {
            assert_rent_safe(&deal_info, total_out)?;
            transfer_lamports_from_pda(
                &deal_info,
                &ctx.accounts.seller.to_account_info(),
                seller_total,
            )?;
            transfer_lamports_from_pda(
                &deal_info,
                &ctx.accounts.buyer.to_account_info(),
                buyer_total,
            )?;
            transfer_lamports_from_pda(
                &deal_info,
                &ctx.accounts.fee_receiver.to_account_info(),
                fee,
            )?;
        } else {
            let deal_ata = checked_token_account(
                &ctx.accounts.deal_ata.to_account_info(),
                deal.mint,
                deal_info.key(),
            )?;
            checked_token_account(
                &ctx.accounts.seller_ata.to_account_info(),
                deal.mint,
                ctx.accounts.seller.key(),
            )?;
            checked_token_account(
                &ctx.accounts.buyer_ata.to_account_info(),
                deal.mint,
                ctx.accounts.buyer.key(),
            )?;
            checked_token_account(
                &ctx.accounts.fee_ata.to_account_info(),
                deal.mint,
                ctx.accounts.fee_receiver.key(),
            )?;
            require!(deal_ata.amount >= total_out, EscrowError::InsufficientFunds);

            // ── Disburse via token account CPIs ──
            deal.transfer_tokens_from_pda(
                ctx.accounts.deal_ata.to_account_info(),
                ctx.accounts.seller_ata.to_account_info(),
                deal.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                seller_total,
                deal.bump,
            )?;

            deal.transfer_tokens_from_pda(
                ctx.accounts.deal_ata.to_account_info(),
                ctx.accounts.buyer_ata.to_account_info(),
                deal.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                buyer_total,
                deal.bump,
            )?;

            deal.transfer_tokens_from_pda(
                ctx.accounts.deal_ata.to_account_info(),
                ctx.accounts.fee_ata.to_account_info(),
                deal.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee,
                deal.bump,
            )?;
        }

        deal.status = DealStatus::Completed;

        emit!(FundsReleased {
            deal_id: deal.deal_id,
            seller_received: seller_total,
            buyer_refunded: buyer_total,
            middleman_fee: fee,
        });

        Ok(())
    }

    /// Resolves a funded prediction-style deal in favor of the buyer.
    /// Buyer receives their price minus fee, their collateral, and seller collateral.
    pub fn settle_to_buyer(ctx: Context<SettleToBuyer>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal_info = ctx.accounts.deal.to_account_info();
        let deal = &mut ctx.accounts.deal;

        // ── State guards ──
        require!(deal.status == DealStatus::PaymentLocked, EscrowError::PaymentNotLocked);
        require!(
            deal.buyer_collateral_locked && deal.seller_collateral_locked,
            EscrowError::CollateralNotLocked
        );
        require!(deal.payment_locked, EscrowError::PaymentNotLocked);

        // ── Calculate fee with checked arithmetic ──
        let fee = (deal.price as u128)
            .checked_mul(deal.middleman_fee_bps as u128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::ArithmeticOverflow)? as u64;

        let buyer_payment = deal.price
            .checked_sub(fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let buyer_total = buyer_payment
            .checked_add(deal.collateral_buyer)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_add(deal.collateral_seller)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let total_out = buyer_total
            .checked_add(fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        if is_native_sol_mint(&deal.mint) {
            assert_rent_safe(&deal_info, total_out)?;
            transfer_lamports_from_pda(
                &deal_info,
                &ctx.accounts.buyer.to_account_info(),
                buyer_total,
            )?;
            transfer_lamports_from_pda(
                &deal_info,
                &ctx.accounts.fee_receiver.to_account_info(),
                fee,
            )?;
        } else {
            let deal_ata = checked_token_account(
                &ctx.accounts.deal_ata.to_account_info(),
                deal.mint,
                deal_info.key(),
            )?;
            checked_token_account(
                &ctx.accounts.buyer_ata.to_account_info(),
                deal.mint,
                ctx.accounts.buyer.key(),
            )?;
            checked_token_account(
                &ctx.accounts.fee_ata.to_account_info(),
                deal.mint,
                ctx.accounts.fee_receiver.key(),
            )?;
            require!(deal_ata.amount >= total_out, EscrowError::InsufficientFunds);

            deal.transfer_tokens_from_pda(
                ctx.accounts.deal_ata.to_account_info(),
                ctx.accounts.buyer_ata.to_account_info(),
                deal.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                buyer_total,
                deal.bump,
            )?;

            deal.transfer_tokens_from_pda(
                ctx.accounts.deal_ata.to_account_info(),
                ctx.accounts.fee_ata.to_account_info(),
                deal.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee,
                deal.bump,
            )?;
        }

        deal.status = DealStatus::Refunded;

        emit!(BuyerSettlementReleased {
            deal_id: deal.deal_id,
            buyer_received: buyer_total,
            seller_forfeited: deal.collateral_seller,
            middleman_fee: fee,
        });

        Ok(())
    }

    /// Cancels a deal and refunds any locked funds.
    ///
    /// Authorization rules:
    /// - `Created` status: any participant (buyer, seller, middleman) can cancel.
    /// - `CollateralLocked` status: only the middleman can cancel (arbiter role).
    /// - `PaymentLocked` / terminal states: cancellation is not allowed.
    pub fn cancel_deal(ctx: Context<CancelDeal>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal_info = ctx.accounts.deal.to_account_info();
        let deal = &mut ctx.accounts.deal;
        let caller = &ctx.accounts.caller;

        // ── State guard: only Created or CollateralLocked can be cancelled ──
        require!(
            deal.status == DealStatus::Created
                || deal.status == DealStatus::CollateralLocked,
            EscrowError::InvalidState
        );

        // ── Authorization: CollateralLocked requires middleman ──
        if deal.status == DealStatus::CollateralLocked {
            require!(
                caller.key() == deal.middleman,
                EscrowError::Unauthorized
            );
        }

        // ── Calculate refund amounts ──
        let mut buyer_refund = 0u64;
        let mut seller_refund = 0u64;

        if deal.buyer_collateral_locked {
            buyer_refund = deal.collateral_buyer;
        }
        if deal.seller_collateral_locked {
            seller_refund = deal.collateral_seller;
        }

        let total_refund = buyer_refund
            .checked_add(seller_refund)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        if is_native_sol_mint(&deal.mint) {
            assert_rent_safe(&deal_info, total_refund)?;
            if buyer_refund > 0 {
                transfer_lamports_from_pda(
                    &deal_info,
                    &ctx.accounts.buyer.to_account_info(),
                    buyer_refund,
                )?;
            }
            if seller_refund > 0 {
                transfer_lamports_from_pda(
                    &deal_info,
                    &ctx.accounts.seller.to_account_info(),
                    seller_refund,
                )?;
            }
        } else {
            // ── Verify deal_ata token balance ──
            let deal_ata = checked_token_account(
                &ctx.accounts.deal_ata.to_account_info(),
                deal.mint,
                deal_info.key(),
            )?;
            if total_refund > 0 {
                require!(deal_ata.amount >= total_refund, EscrowError::InsufficientFunds);
            }

            // ── Disburse refunds via token CPIs ──
            if buyer_refund > 0 {
                checked_token_account(
                    &ctx.accounts.buyer_ata.to_account_info(),
                    deal.mint,
                    ctx.accounts.buyer.key(),
                )?;
                deal.transfer_tokens_from_pda(
                    ctx.accounts.deal_ata.to_account_info(),
                    ctx.accounts.buyer_ata.to_account_info(),
                    deal.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    buyer_refund,
                    deal.bump,
                )?;
            }
            if seller_refund > 0 {
                checked_token_account(
                    &ctx.accounts.seller_ata.to_account_info(),
                    deal.mint,
                    ctx.accounts.seller.key(),
                )?;
                deal.transfer_tokens_from_pda(
                    ctx.accounts.deal_ata.to_account_info(),
                    ctx.accounts.seller_ata.to_account_info(),
                    deal.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    seller_refund,
                    deal.bump,
                )?;
            }
        }

        deal.status = DealStatus::Cancelled;

        emit!(DealCancelled {
            deal_id: deal.deal_id,
            cancelled_by: caller.key(),
            buyer_refunded: buyer_refund,
            seller_refunded: seller_refund,
        });

        Ok(())
    }

    /// Refunds all locked funds if the deal has timed out.
    /// Only a deal participant (buyer, seller, or middleman) can trigger this.
    /// The deal must NOT be in a terminal state.
    pub fn refund_on_timeout(ctx: Context<RefundOnTimeout>) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal_info = ctx.accounts.deal.to_account_info();
        let deal = &mut ctx.accounts.deal;

        // ── State guards ──
        require!(deal.status != DealStatus::Completed, EscrowError::DealAlreadyCompleted);
        require!(deal.status != DealStatus::Refunded, EscrowError::DealAlreadyRefunded);
        require!(deal.status != DealStatus::Cancelled, EscrowError::DealAlreadyCancelled);

        let now = Clock::get()?.unix_timestamp;
        require!(now > deal.timeout, EscrowError::TimeoutNotReached);

        // ── Calculate refund amounts based on what was actually locked ──
        let mut buyer_refund = 0u64;
        let mut seller_refund = 0u64;

        if deal.buyer_collateral_locked {
            buyer_refund = buyer_refund
                .checked_add(deal.collateral_buyer)
                .ok_or(EscrowError::ArithmeticOverflow)?;
        }
        if deal.seller_collateral_locked {
            seller_refund = seller_refund
                .checked_add(deal.collateral_seller)
                .ok_or(EscrowError::ArithmeticOverflow)?;
        }
        if deal.payment_locked {
            buyer_refund = buyer_refund
                .checked_add(deal.price)
                .ok_or(EscrowError::ArithmeticOverflow)?;
        }

        let total_refund = buyer_refund
            .checked_add(seller_refund)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        if is_native_sol_mint(&deal.mint) {
            assert_rent_safe(&deal_info, total_refund)?;
            if buyer_refund > 0 {
                transfer_lamports_from_pda(
                    &deal_info,
                    &ctx.accounts.buyer.to_account_info(),
                    buyer_refund,
                )?;
            }
            if seller_refund > 0 {
                transfer_lamports_from_pda(
                    &deal_info,
                    &ctx.accounts.seller.to_account_info(),
                    seller_refund,
                )?;
            }
        } else {
            // ── Verify deal_ata token balance ──
            let deal_ata = checked_token_account(
                &ctx.accounts.deal_ata.to_account_info(),
                deal.mint,
                deal_info.key(),
            )?;
            if total_refund > 0 {
                require!(deal_ata.amount >= total_refund, EscrowError::InsufficientFunds);
            }

            // ── Disburse refunds via token CPIs ──
            if buyer_refund > 0 {
                checked_token_account(
                    &ctx.accounts.buyer_ata.to_account_info(),
                    deal.mint,
                    ctx.accounts.buyer.key(),
                )?;
                deal.transfer_tokens_from_pda(
                    ctx.accounts.deal_ata.to_account_info(),
                    ctx.accounts.buyer_ata.to_account_info(),
                    deal.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    buyer_refund,
                    deal.bump,
                )?;
            }
            if seller_refund > 0 {
                checked_token_account(
                    &ctx.accounts.seller_ata.to_account_info(),
                    deal.mint,
                    ctx.accounts.seller.key(),
                )?;
                deal.transfer_tokens_from_pda(
                    ctx.accounts.deal_ata.to_account_info(),
                    ctx.accounts.seller_ata.to_account_info(),
                    deal.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    seller_refund,
                    deal.bump,
                )?;
            }
        }

        deal.status = DealStatus::Refunded;

        emit!(Refunded {
            deal_id: deal.deal_id,
            buyer_refunded: buyer_refund,
            seller_refunded: seller_refund,
        });

        Ok(())
    }

    /// Closes a terminal deal account and reclaims rent to the specified receiver.
    /// Only callable by buyer, seller, or middleman after deal is Completed, Refunded, or Cancelled.
    /// Note: This is NOT paused — participants must always be able to reclaim rent.
    pub fn close_deal(ctx: Context<CloseDeal>) -> Result<()> {
        let deal = &ctx.accounts.deal;

        // ── Only terminal deals can be closed ──
        require!(deal.is_terminal(), EscrowError::DealNotTerminal);

        emit!(DealClosed {
            deal_id: deal.deal_id,
            rent_reclaimed_by: ctx.accounts.rent_receiver.key(),
        });

        // Account closure is handled by Anchor's `close = rent_receiver` constraint
        Ok(())
    }

    /// Confirms that a plain SOL deposit has arrived at the deal PDA.
    ///
    /// ONLY the middleman can call this. The workflow is:
    ///   1. Middleman creates deal → gives PDA address to buyer/seller
    ///   2. Buyer/seller send plain SOL transfers to the PDA address
    ///   3. Middleman watches PDA balance on-chain
    ///   4. When deposit detected, middleman calls confirm_deposit
    ///   5. Contract verifies PDA balance covers the expected amount
    ///   6. Flags are updated and deal state advances
    ///
    /// This eliminates the need for buyer/seller to call Anchor instructions.
    pub fn confirm_deposit(ctx: Context<ConfirmDeposit>, deposit_type: DepositType) -> Result<()> {
        // ── Pause guard ──
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let deal_info = ctx.accounts.deal.to_account_info();
        let deal = &mut ctx.accounts.deal;
        let current_balance = if is_native_sol_mint(&deal.mint) {
            escrowed_native_lamports(&deal_info)?
        } else {
            checked_token_account(
                &ctx.accounts.deal_ata.to_account_info(),
                deal.mint,
                deal_info.key(),
            )?.amount
        };
        let deposit_label: String;

        match deposit_type {
            DepositType::BuyerCollateral => {
                require!(
                    deal.status == DealStatus::Created,
                    EscrowError::InvalidState
                );
                require!(!deal.buyer_collateral_locked, EscrowError::AlreadyDeposited);

                // Verify PDA has enough balance to cover buyer's collateral
                let mut expected = deal.collateral_buyer;
                if deal.seller_collateral_locked {
                    expected += deal.collateral_seller;
                }
                require!(current_balance >= expected, EscrowError::InsufficientFunds);

                deal.buyer_collateral_locked = true;
                deposit_label = "BuyerCollateral".to_string();
            }
            DepositType::SellerCollateral => {
                require!(
                    deal.status == DealStatus::Created,
                    EscrowError::InvalidState
                );
                require!(!deal.seller_collateral_locked, EscrowError::AlreadyDeposited);

                // Verify PDA has enough balance to cover seller's collateral
                let mut expected = deal.collateral_seller;
                if deal.buyer_collateral_locked {
                    expected += deal.collateral_buyer;
                }
                require!(current_balance >= expected, EscrowError::InsufficientFunds);

                deal.seller_collateral_locked = true;
                deposit_label = "SellerCollateral".to_string();
            }
            DepositType::BuyerPayment => {
                require!(
                    deal.status == DealStatus::CollateralLocked,
                    EscrowError::CollateralNotLocked
                );
                require!(!deal.payment_locked, EscrowError::AlreadyDeposited);

                // Verify PDA has enough for collaterals + payment
                let expected = deal.collateral_buyer
                    + deal.collateral_seller
                    + deal.price;
                require!(current_balance >= expected, EscrowError::InsufficientFunds);

                deal.payment_locked = true;
                deal.status = DealStatus::PaymentLocked;
                deposit_label = "BuyerPayment".to_string();
            }
        }

        // Advance to CollateralLocked if both collaterals confirmed
        if deal.buyer_collateral_locked
            && deal.seller_collateral_locked
            && deal.status == DealStatus::Created
        {
            deal.status = DealStatus::CollateralLocked;
        }

        emit!(DepositConfirmed {
            deal_id: deal.deal_id,
            confirmed_by: ctx.accounts.middleman.key(),
            deposit_type: deposit_label,
            both_collaterals_locked: deal.buyer_collateral_locked && deal.seller_collateral_locked,
            payment_locked: deal.payment_locked,
        });

        Ok(())
    }

    /// Reveals and verifies the terms of a privacy-mode deal.
    ///
    /// The caller provides the original plaintext terms (price, collateral amounts,
    /// asset type) plus the cryptographic nonce used during commitment. The contract
    /// recomputes SHA-256(canonical_payload) and compares it against the stored
    /// `terms_hash`. This proves the revealed terms match what was committed
    /// without ever having stored plaintext on-chain.
    ///
    /// Security:
    /// - Only callable after deal reaches `Completed` status (settlement done)
    /// - Prevents double-reveal via `terms_revealed` flag
    /// - Only deal participants (buyer, seller, middleman) can call
    pub fn reveal_and_verify_terms(
        ctx: Context<RevealTerms>,
        price: u64,
        collateral_buyer: u64,
        collateral_seller: u64,
        asset_type: String,
        nonce: [u8; 32],
    ) -> Result<()> {
        let deal = &mut ctx.accounts.deal;

        // ── Guard: only Privacy mode deals have terms to reveal ──
        require!(deal.trade_mode == TradeMode::Privacy, EscrowError::InvalidState);

        // ── Guard: deal must be in a terminal state ──
        require!(deal.is_terminal(), EscrowError::DealNotCompleted);

        // ── Guard: prevent double-reveal (anti-replay) ──
        require!(!deal.terms_revealed, EscrowError::TermsAlreadyRevealed);

        // ── Reconstruct the canonical hash payload ──
        // Format: "price:collateral_buyer:collateral_seller:asset_type:nonce_hex"
        let nonce_hex: String = nonce.iter().map(|b| format!("{:02x}", b)).collect();
        let payload = format!(
            "{}:{}:{}:{}:{}",
            price, collateral_buyer, collateral_seller, asset_type, nonce_hex
        );

        // ── Compute SHA-256 on-chain via sha2 crate ──
        let mut hasher = Sha256::new();
        hasher.update(payload.as_bytes());
        let computed: [u8; 32] = hasher.finalize().into();

        // ── Compare against stored commitment ──
        require!(
            computed == deal.terms_hash,
            EscrowError::TermsHashMismatch
        );

        // ── Mark as revealed (prevents replay) ──
        deal.terms_revealed = true;

        emit!(TermsRevealed {
            deal_id: deal.deal_id,
            verified: true,
        });

        Ok(())
    }
}
