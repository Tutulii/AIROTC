use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::{
    instruction::Instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use encrypt_dsl::prelude::encrypt_fn;
use encrypt_solana_types::{accounts as encrypt_accounts, cpi::EncryptCpi};
use encrypt_types::encrypted::Uint64;
use sha2::{Digest, Sha256};
use std::str::FromStr;

// ============================================================================
// PROGRAM ID — Generate fresh via `anchor keys list` after first build
// ============================================================================
declare_id!("BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj");

// ============================================================================
// EXTERNAL PROGRAM IDS
// ============================================================================
pub const ENCRYPT_PROGRAM_ID: &str = "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8";
pub const DWALLET_PROGRAM_ID: &str = "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY";

// ============================================================================
// CPI AUTHORITY SEEDS
// ============================================================================
pub const ENCRYPT_CPI_SEED: &[u8] = b"__encrypt_cpi_authority";
pub const DWALLET_CPI_SEED: &[u8] = b"__ika_cpi_authority";
pub const CREDIT_VAULT_SEED: &[u8] = b"credit_vault";
pub const CREDIT_BALANCE_SEED: &[u8] = b"credit_balance";
pub const CREDIT_LOCK_SEED: &[u8] = b"credit_lock";
pub const WITHDRAWAL_SEED: &[u8] = b"withdrawal";

// ============================================================================
// INSTRUCTION DISCRIMINATORS (from dWallet docs)
// ============================================================================
/// dWallet: approve_message
const IX_APPROVE_MESSAGE: u8 = 8;
/// dWallet MessageApproval account discriminator
const MESSAGE_APPROVAL_DISC: u8 = 14;
/// dWallet MessageApproval.status byte offset
const MESSAGE_APPROVAL_STATUS_OFFSET: usize = 172;
/// dWallet MessageApproval.dwallet byte range start
const MESSAGE_APPROVAL_DWALLET_OFFSET: usize = 2;
/// dWallet MessageApproval.status == Signed
const MESSAGE_APPROVAL_STATUS_SIGNED: u8 = 1;
const ED25519_HEADER_LEN: usize = 16;
const ED25519_PROGRAM_ID_STR: &str = "Ed25519SigVerify111111111111111111111111111";

// ============================================================================
// ENCRYPT GRAPH
// ============================================================================

#[encrypt_fn]
fn settlement_validation_graph(
    buyer_collateral: EUint64,
    seller_collateral: EUint64,
    payment_amount: EUint64,
) -> EUint64 {
    let total_collateral = buyer_collateral + seller_collateral;
    let payable = total_collateral >= payment_amount;
    let zero = EUint64::from(0u64);
    let one = EUint64::from(1u64);
    if payable { one } else { zero }
}

// ============================================================================
// ENCRYPT CPI CONTEXT (compat layer for Anchor 0.32)
// ============================================================================

struct EncryptContext<'info> {
    encrypt_program: AccountInfo<'info>,
    config: AccountInfo<'info>,
    deposit: AccountInfo<'info>,
    cpi_authority: AccountInfo<'info>,
    caller_program: AccountInfo<'info>,
    network_encryption_key: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    event_authority: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    cpi_authority_bump: u8,
}

impl<'info> EncryptCpi for EncryptContext<'info> {
    type Error = anchor_lang::error::Error;
    type Account<'a> = AccountInfo<'info> where Self: 'a;

    fn read_fhe_type<'a>(&'a self, account: AccountInfo<'info>) -> Option<u8> {
        let data = account.try_borrow_data().ok()?;
        if data.len() < encrypt_solana_types::accounts::CT_LEN {
            return None;
        }
        Some(data[encrypt_solana_types::accounts::CT_FHE_TYPE])
    }

    fn type_mismatch_error(&self) -> anchor_lang::error::Error {
        anchor_lang::error::Error::from(anchor_lang::error::ErrorCode::ConstraintRaw)
    }

    fn invoke_execute_graph<'a>(
        &'a self,
        ix_data: &[u8],
        encrypt_execute_accounts: &[AccountInfo<'info>],
    ) -> Result<()> {
        let mut accounts = vec![
            AccountMeta::new(self.config.key(), false),
            AccountMeta::new(self.deposit.key(), false),
            AccountMeta::new_readonly(self.caller_program.key(), false),
            AccountMeta::new_readonly(self.cpi_authority.key(), true),
            AccountMeta::new_readonly(self.network_encryption_key.key(), false),
            AccountMeta::new(self.payer.key(), true),
            AccountMeta::new_readonly(self.event_authority.key(), false),
            AccountMeta::new_readonly(self.encrypt_program.key(), false),
        ];
        for account in encrypt_execute_accounts {
            accounts.push(AccountMeta::new(account.key(), false));
        }

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.encrypt_program.key(),
            accounts,
            data: ix_data.to_vec(),
        };

        let mut account_infos = vec![
            self.config.clone(),
            self.deposit.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            self.network_encryption_key.clone(),
            self.payer.clone(),
            self.event_authority.clone(),
            self.encrypt_program.clone(),
        ];
        account_infos.extend_from_slice(encrypt_execute_accounts);

        let seeds = &[ENCRYPT_CPI_SEED, &[self.cpi_authority_bump]];
        let signer_seeds = &[&seeds[..]];
        anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds)?;
        Ok(())
    }
}

impl<'info> EncryptContext<'info> {
    fn request_decryption(
        &self,
        request_acct: &AccountInfo<'info>,
        ciphertext: &AccountInfo<'info>,
    ) -> Result<[u8; 32]> {
        let ct_data = ciphertext.try_borrow_data()?;
        let digest = *encrypt_accounts::parse_ciphertext_digest(&ct_data)
            .ok_or_else(|| error!(ConfidentialEscrowError::InvalidCiphertextAccount))?;
        drop(ct_data);

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.encrypt_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(self.config.key(), false),
                AccountMeta::new(self.deposit.key(), false),
                AccountMeta::new(request_acct.key(), true),
                AccountMeta::new_readonly(self.caller_program.key(), false),
                AccountMeta::new_readonly(self.cpi_authority.key(), true),
                AccountMeta::new_readonly(ciphertext.key(), false),
                AccountMeta::new(self.payer.key(), true),
                AccountMeta::new_readonly(self.system_program.key(), false),
                AccountMeta::new_readonly(self.event_authority.key(), false),
                AccountMeta::new_readonly(self.encrypt_program.key(), false),
            ],
            data: vec![11u8],
        };

        let account_infos = vec![
            self.config.clone(),
            self.deposit.clone(),
            request_acct.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            ciphertext.clone(),
            self.payer.clone(),
            self.system_program.clone(),
            self.event_authority.clone(),
            self.encrypt_program.clone(),
        ];

        let seeds = &[ENCRYPT_CPI_SEED, &[self.cpi_authority_bump]];
        let signer_seeds = &[&seeds[..]];
        anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds)?;

        Ok(digest)
    }
}

// ============================================================================
// PROGRAM
// ============================================================================
#[program]
pub mod escrow_confidential {
    use super::*;

    /// Initialize the vault-backed internal PER credit ledger.
    pub fn initialize_credit_vault(ctx: Context<InitializeCreditVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.total_deposited_lamports = 0;
        vault.total_issued_credit = 0;
        vault.total_locked_credit = 0;
        vault.pending_withdrawal_lamports = 0;
        vault.executed_withdrawal_lamports = 0;
        vault.paused = false;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Deposit native SOL into the program-controlled vault and mint internal
    /// 1:1 credit in the caller's CreditBalance account.
    pub fn deposit_sol_for_credit(
        ctx: Context<DepositSolForCredit>,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, ConfidentialEscrowError::InvalidCreditAmount);
        require!(!ctx.accounts.vault.paused, ConfidentialEscrowError::CreditVaultPaused);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        let vault_key = ctx.accounts.vault.key();
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let vault = &mut ctx.accounts.vault;
        vault.total_deposited_lamports = vault
            .total_deposited_lamports
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        vault.total_issued_credit = vault
            .total_issued_credit
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        let balance = &mut ctx.accounts.credit_balance;
        if balance.owner == Pubkey::default() {
            balance.owner = ctx.accounts.owner.key();
            balance.vault = vault_key;
            balance.bump = ctx.bumps.credit_balance;
        }
        require_keys_eq!(balance.owner, ctx.accounts.owner.key(), ConfidentialEscrowError::Unauthorized);
        require_keys_eq!(balance.vault, vault_key, ConfidentialEscrowError::InvalidCreditVault);
        balance.available_lamports = balance
            .available_lamports
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        validate_vault_reserve(vault, vault_lamports)?;
        emit!(CreditDeposited {
            owner: ctx.accounts.owner.key(),
            vault: vault_key,
            amount_lamports,
        });
        Ok(())
    }

    /// Lock internal shielded credit against one funding leg of a PER deal.
    pub fn lock_credit_for_deal(
        ctx: Context<LockCreditForDeal>,
        deposit_type: DepositType,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, ConfidentialEscrowError::InvalidCreditAmount);
        require!(!ctx.accounts.vault.paused, ConfidentialEscrowError::CreditVaultPaused);
        let vault_key = ctx.accounts.vault.key();
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let deal_key = ctx.accounts.deal.key();
        let deal = &mut ctx.accounts.deal;
        require!(
            deal.status == DealStatus::Created || deal.status == DealStatus::PartiallyFunded,
            ConfidentialEscrowError::InvalidDealStatus
        );
        require!(deal.private_funding_registered, ConfidentialEscrowError::InvalidFundingCommitment);
        require!(
            deal.funding_privacy_tier == FundingPrivacyTier::Unset
                || deal.funding_privacy_tier == FundingPrivacyTier::ShieldedCredit,
            ConfidentialEscrowError::FundingRailMismatch
        );

        match deposit_type {
            DepositType::BuyerPayment | DepositType::BuyerCollateral => {
                require!(
                    participant_commitment(&ctx.accounts.owner.key())
                        == deal.buyer_identity_commitment,
                    ConfidentialEscrowError::Unauthorized
                );
            }
            DepositType::SellerCollateral => {
                require!(
                    participant_commitment(&ctx.accounts.owner.key())
                        == deal.seller_identity_commitment,
                    ConfidentialEscrowError::Unauthorized
                );
            }
        }

        let expected_hash = compute_private_funding_hash(deal, deposit_type, amount_lamports)?;
        match deposit_type {
            DepositType::BuyerPayment => {
                require!(!deal.buyer_payment_deposited, ConfidentialEscrowError::DuplicateDepositType);
                require!(expected_hash == deal.buyer_payment_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                deal.buyer_payment_deposited = true;
            }
            DepositType::BuyerCollateral => {
                require!(!deal.buyer_collateral_deposited, ConfidentialEscrowError::DuplicateDepositType);
                require!(expected_hash == deal.buyer_collateral_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                deal.buyer_collateral_deposited = true;
            }
            DepositType::SellerCollateral => {
                require!(!deal.seller_collateral_deposited, ConfidentialEscrowError::DuplicateDepositType);
                require!(expected_hash == deal.seller_collateral_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                deal.seller_collateral_deposited = true;
            }
        }

        let balance = &mut ctx.accounts.credit_balance;
        require_keys_eq!(balance.owner, ctx.accounts.owner.key(), ConfidentialEscrowError::Unauthorized);
        require_keys_eq!(balance.vault, vault_key, ConfidentialEscrowError::InvalidCreditVault);
        require!(balance.available_lamports >= amount_lamports, ConfidentialEscrowError::InsufficientCredit);
        balance.available_lamports = balance
            .available_lamports
            .checked_sub(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        balance.locked_lamports = balance
            .locked_lamports
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        let lock = &mut ctx.accounts.credit_lock;
        lock.vault = vault_key;
        lock.deal = deal_key;
        lock.owner = ctx.accounts.owner.key();
        lock.deposit_type = deposit_type;
        lock.amount_lamports = amount_lamports;
        lock.settled = false;
        lock.refunded = false;
        lock.bump = ctx.bumps.credit_lock;

        let vault = &mut ctx.accounts.vault;
        vault.total_locked_credit = vault
            .total_locked_credit
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        deal.funding_privacy_tier = FundingPrivacyTier::ShieldedCredit;
        if deal.buyer_payment_deposited
            && deal.buyer_collateral_deposited
            && deal.seller_collateral_deposited
        {
            deal.status = DealStatus::Funded;
        } else {
            deal.status = DealStatus::PartiallyFunded;
        }

        validate_vault_reserve(vault, vault_lamports)?;
        emit!(CreditLocked {
            deal_id: deal.deal_id,
            owner: ctx.accounts.owner.key(),
            deposit_type,
            amount_lamports,
        });
        Ok(())
    }

    /// Release locked internal credit after the FHE/IKA approval path has
    /// decided whether the seller or buyer receives the payment leg.
    pub fn settle_locked_credit(
        ctx: Context<SettleLockedCredit>,
        settlement_valid: bool,
    ) -> Result<()> {
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let deal = &mut ctx.accounts.deal;
        require!(deal.status == DealStatus::Settling, ConfidentialEscrowError::InvalidDealStatus);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        require!(deal.release_authorized, ConfidentialEscrowError::ReleaseNotAuthorized);
        require!(deal.buyer_release_confirmed, ConfidentialEscrowError::BuyerReleaseConfirmationMissing);
        require!(deal.funding_privacy_tier == FundingPrivacyTier::ShieldedCredit, ConfidentialEscrowError::FundingRailMismatch);
        require!(ctx.accounts.authority.key() == deal.middleman, ConfidentialEscrowError::Unauthorized);

        validate_lock_for_deal(&ctx.accounts.buyer_payment_lock, deal, DepositType::BuyerPayment)?;
        validate_lock_for_deal(&ctx.accounts.buyer_collateral_lock, deal, DepositType::BuyerCollateral)?;
        validate_lock_for_deal(&ctx.accounts.seller_collateral_lock, deal, DepositType::SellerCollateral)?;

        require_keys_eq!(
            ctx.accounts.buyer_credit_balance.owner,
            ctx.accounts.buyer_payment_lock.owner,
            ConfidentialEscrowError::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.seller_credit_balance.owner,
            ctx.accounts.seller_collateral_lock.owner,
            ConfidentialEscrowError::Unauthorized
        );

        let buyer_payment = ctx.accounts.buyer_payment_lock.amount_lamports;
        let buyer_collateral = ctx.accounts.buyer_collateral_lock.amount_lamports;
        let seller_collateral = ctx.accounts.seller_collateral_lock.amount_lamports;
        let total_locked = buyer_payment
            .checked_add(buyer_collateral)
            .and_then(|value| value.checked_add(seller_collateral))
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        if settlement_valid {
            release_locked_credit_to_balance(
                &mut ctx.accounts.buyer_credit_balance,
                buyer_collateral,
            )?;
            transfer_locked_credit_between_balances(
                &mut ctx.accounts.buyer_credit_balance,
                &mut ctx.accounts.seller_credit_balance,
                buyer_payment,
            )?;
            release_locked_credit_to_balance(
                &mut ctx.accounts.seller_credit_balance,
                seller_collateral,
            )?;
        } else {
            release_locked_credit_to_balance(
                &mut ctx.accounts.buyer_credit_balance,
                buyer_payment
                    .checked_add(buyer_collateral)
                    .ok_or(ConfidentialEscrowError::AmountOverflow)?,
            )?;
            release_locked_credit_to_balance(
                &mut ctx.accounts.seller_credit_balance,
                seller_collateral,
            )?;
        }

        mark_credit_lock_settled(&mut ctx.accounts.buyer_payment_lock)?;
        mark_credit_lock_settled(&mut ctx.accounts.buyer_collateral_lock)?;
        mark_credit_lock_settled(&mut ctx.accounts.seller_collateral_lock)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_locked_credit = vault
            .total_locked_credit
            .checked_sub(total_locked)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        deal.status = DealStatus::Completed;
        deal.release_executed = true;

        validate_vault_reserve(vault, vault_lamports)?;
        emit!(CreditSettled {
            deal_id: deal.deal_id,
            settlement_valid,
            total_lamports: total_locked,
        });
        Ok(())
    }

    /// Queue a delayed withdrawal from internal credit to a fresh public wallet.
    pub fn queue_withdrawal(
        ctx: Context<QueueWithdrawal>,
        withdrawal_id: [u8; 32],
        amount_lamports: u64,
        not_before_ts: i64,
    ) -> Result<()> {
        require!(amount_lamports > 0, ConfidentialEscrowError::InvalidCreditAmount);
        require!(ctx.accounts.credit_balance.available_lamports >= amount_lamports, ConfidentialEscrowError::InsufficientCredit);
        require_keys_eq!(ctx.accounts.credit_balance.owner, ctx.accounts.owner.key(), ConfidentialEscrowError::Unauthorized);
        let vault_key = ctx.accounts.vault.key();
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();

        let balance = &mut ctx.accounts.credit_balance;
        balance.available_lamports = balance
            .available_lamports
            .checked_sub(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_issued_credit = vault
            .total_issued_credit
            .checked_sub(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        vault.pending_withdrawal_lamports = vault
            .pending_withdrawal_lamports
            .checked_add(amount_lamports)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        let withdrawal = &mut ctx.accounts.withdrawal;
        withdrawal.withdrawal_id = withdrawal_id;
        withdrawal.vault = vault_key;
        withdrawal.owner = ctx.accounts.owner.key();
        withdrawal.destination = ctx.accounts.destination.key();
        withdrawal.amount_lamports = amount_lamports;
        withdrawal.not_before_ts = not_before_ts;
        withdrawal.executed = false;
        withdrawal.bump = ctx.bumps.withdrawal;

        validate_vault_reserve(vault, vault_lamports)?;
        emit!(WithdrawalQueued {
            withdrawal_id,
            owner: ctx.accounts.owner.key(),
            destination: ctx.accounts.destination.key(),
            amount_lamports,
            not_before_ts,
        });
        Ok(())
    }

    /// Execute one queued withdrawal. Multiple calls with different withdrawal
    /// accounts form a batch while keeping each record replay-safe.
    pub fn execute_withdrawal_batch(ctx: Context<ExecuteWithdrawalBatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let withdrawal = &mut ctx.accounts.withdrawal;
        require!(!withdrawal.executed, ConfidentialEscrowError::WithdrawalAlreadyExecuted);
        require!(now >= withdrawal.not_before_ts, ConfidentialEscrowError::WithdrawalNotReady);
        require_keys_eq!(withdrawal.vault, ctx.accounts.vault.key(), ConfidentialEscrowError::InvalidCreditVault);
        require_keys_eq!(withdrawal.destination, ctx.accounts.destination.key(), ConfidentialEscrowError::InvalidSettlementTarget);

        let amount = withdrawal.amount_lamports;
        let vault_info = ctx.accounts.vault.to_account_info();
        let destination_info = ctx.accounts.destination.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **destination_info.try_borrow_mut_lamports()? += amount;
        let vault_lamports = vault_info.lamports();

        let vault = &mut ctx.accounts.vault;
        vault.pending_withdrawal_lamports = vault
            .pending_withdrawal_lamports
            .checked_sub(amount)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        vault.executed_withdrawal_lamports = vault
            .executed_withdrawal_lamports
            .checked_add(amount)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        withdrawal.executed = true;
        validate_vault_reserve(vault, vault_lamports)?;
        emit!(WithdrawalBatchExecuted {
            withdrawal_id: withdrawal.withdrawal_id,
            destination: ctx.accounts.destination.key(),
            amount_lamports: amount,
        });
        Ok(())
    }

    /// Recover a locked credit leg after a timeout without middleman cooperation.
    pub fn emergency_refund_after_timeout(
        ctx: Context<EmergencyRefundAfterTimeout>,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(timeout_seconds > 0, ConfidentialEscrowError::InvalidCreditAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > ctx.accounts.deal.created_at.checked_add(timeout_seconds).ok_or(ConfidentialEscrowError::AmountOverflow)?,
            ConfidentialEscrowError::TimeoutNotReached
        );
        require!(!ctx.accounts.credit_lock.settled, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        require!(!ctx.accounts.credit_lock.refunded, ConfidentialEscrowError::WithdrawalAlreadyExecuted);
        require_keys_eq!(ctx.accounts.credit_lock.owner, ctx.accounts.owner.key(), ConfidentialEscrowError::Unauthorized);
        require_keys_eq!(ctx.accounts.credit_balance.owner, ctx.accounts.owner.key(), ConfidentialEscrowError::Unauthorized);

        let amount = ctx.accounts.credit_lock.amount_lamports;
        ctx.accounts.credit_balance.locked_lamports = ctx.accounts.credit_balance
            .locked_lamports
            .checked_sub(amount)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        ctx.accounts.credit_balance.available_lamports = ctx.accounts.credit_balance
            .available_lamports
            .checked_add(amount)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        ctx.accounts.credit_lock.refunded = true;
        ctx.accounts.vault.total_locked_credit = ctx.accounts.vault
            .total_locked_credit
            .checked_sub(amount)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        validate_vault_reserve(
            &ctx.accounts.vault,
            ctx.accounts.vault.to_account_info().lamports(),
        )?;
        Ok(())
    }

    /// Instruction 0: Create a confidential deal with encrypted collateral references.
    ///
    /// The caller provides ciphertext account pubkeys (created off-chain via gRPC
    /// createInput) and a pre-created result ciphertext account. The instruction
    /// stores references and CPIs into Encrypt to execute the settlement validation
    /// graph under FHE.
    pub fn create_confidential_deal(
        ctx: Context<CreateConfidentialDeal>,
        deal_id: [u8; 32],
        bet_lamports: u64,
        terms_hash: [u8; 32],
        plan_hash: [u8; 32],
        settlement_policy: ReleaseSettlementPolicy,
        buyer_identity_commitment: [u8; 32],
        seller_identity_commitment: [u8; 32],
        seller_dispute_window_seconds: u32,
        encrypt_cpi_authority_bump: u8,
    ) -> Result<()> {
        let encrypt_program_id = ENCRYPT_PROGRAM_ID
            .parse::<Pubkey>()
            .map_err(|_| ConfidentialEscrowError::InvalidProgramId)?;
        require_keys_eq!(
            ctx.accounts.encrypt_program.key(),
            encrypt_program_id,
            ConfidentialEscrowError::InvalidProgramId
        );
        require!(
            ctx.accounts.caller_program.key() == crate::ID
                && ctx.accounts.caller_program.to_account_info().executable,
            ConfidentialEscrowError::InvalidCallerProgram
        );

        let (expected_cpi_authority, _) = derive_encrypt_cpi_authority(ctx.program_id);
        require_keys_eq!(
            ctx.accounts.cpi_authority.key(),
            expected_cpi_authority,
            ConfidentialEscrowError::InvalidEncryptAccount
        );
        // ── Deposit bet into deal PDA ──
        let escrow_lamports = bet_lamports
            .checked_mul(2)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;

        if escrow_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.deal.to_account_info(),
                    },
                ),
                escrow_lamports,
            )?;
        }

        // ── Initialize deal state ──
        let deal = &mut ctx.accounts.deal;
        deal.deal_id = deal_id;
        deal.buyer_identity_commitment = buyer_identity_commitment;
        deal.seller_identity_commitment = seller_identity_commitment;
        deal.middleman = ctx.accounts.middleman.key();
        deal.session_pda = Pubkey::default();
        deal.buyer_collateral_ct = ctx.accounts.buyer_collateral_ciphertext.key().to_bytes();
        deal.seller_collateral_ct = ctx.accounts.seller_collateral_ciphertext.key().to_bytes();
        deal.payment_amount_ct = ctx.accounts.payment_amount_ciphertext.key().to_bytes();
        deal.settlement_result_ct = ctx.accounts.settlement_result_ciphertext.key().to_bytes();
        deal.dwallet = ctx.accounts.dwallet.key();
        deal.buyer_payment_funding_hash = [0u8; 32];
        deal.buyer_collateral_funding_hash = [0u8; 32];
        deal.seller_collateral_funding_hash = [0u8; 32];
        deal.private_funding_registered = false;
        deal.buyer_payment_deposited = false;
        deal.buyer_collateral_deposited = false;
        deal.seller_collateral_deposited = false;
        deal.terms_hash = terms_hash;
        deal.plan_hash = plan_hash;
        deal.settlement_policy = settlement_policy;
        deal.funding_privacy_tier = FundingPrivacyTier::Unset;
        deal.buyer_release_nonce = 0;
        deal.seller_release_nonce = 0;
        deal.buyer_plan_approved = false;
        deal.seller_plan_approved = false;
        deal.buyer_release_confirmed = false;
        deal.release_requested_at = 0;
        deal.seller_dispute_deadline_at = 0;
        deal.seller_dispute_window_seconds = seller_dispute_window_seconds;
        deal.dispute_open = false;
        deal.release_authorized = false;
        deal.release_executed = false;
        deal.pending_digest = [0u8; 32];
        deal.status = if escrow_lamports > 0 {
            DealStatus::Funded
        } else {
            DealStatus::Created
        };
        deal.bet_lamports = bet_lamports;
        deal.created_at = Clock::get()?.unix_timestamp;
        deal.bump = ctx.bumps.deal;

        // Execute the settlement graph inside Encrypt with program-authorized ciphertexts.
        let encrypt_ctx = EncryptContext {
            encrypt_program: ctx.accounts.encrypt_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            deposit: ctx.accounts.deposit.to_account_info(),
            cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
            caller_program: ctx.accounts.caller_program.to_account_info(),
            network_encryption_key: ctx.accounts.network_encryption_key.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            cpi_authority_bump: encrypt_cpi_authority_bump,
        };
        encrypt_ctx.settlement_validation_graph(
            ctx.accounts.buyer_collateral_ciphertext.to_account_info(),
            ctx.accounts.seller_collateral_ciphertext.to_account_info(),
            ctx.accounts.payment_amount_ciphertext.to_account_info(),
            ctx.accounts.settlement_result_ciphertext.to_account_info(),
        )?;

        emit!(ConfidentialDealCreated {
            deal_id,
            buyer_collateral_ct: deal.buyer_collateral_ct,
            seller_collateral_ct: deal.seller_collateral_ct,
            settlement_result_ct: deal.settlement_result_ct,
            dwallet: deal.dwallet,
        });

        msg!(
            "Confidential deal created, settlement graph CPI dispatched, escrow funded with {} lamports",
            escrow_lamports
        );
        Ok(())
    }

    pub fn register_private_funding_commitments(
        ctx: Context<RegisterPrivateFundingCommitments>,
        session_pda: Pubkey,
        buyer_payment_funding_hash: [u8; 32],
        buyer_collateral_funding_hash: [u8; 32],
        seller_collateral_funding_hash: [u8; 32],
    ) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        require!(ctx.accounts.authority.key() == deal.middleman, ConfidentialEscrowError::Unauthorized);
        require!(
            deal.status == DealStatus::Created || deal.status == DealStatus::PartiallyFunded,
            ConfidentialEscrowError::InvalidDealStatus
        );

        deal.session_pda = session_pda;
        deal.buyer_payment_funding_hash = buyer_payment_funding_hash;
        deal.buyer_collateral_funding_hash = buyer_collateral_funding_hash;
        deal.seller_collateral_funding_hash = seller_collateral_funding_hash;
        deal.private_funding_registered = true;

        Ok(())
    }

    /// Instruction 1: Record a deposit against a confidential deal.
    ///
    /// Buyer or seller deposits SOL into the deal PDA. The deposit amount is
    /// validated against the on-chain deal state (not the encrypted amount — that
    /// is verified during settlement via FHE).
    pub fn deposit_encrypted(
        ctx: Context<DepositEncrypted>,
        deposit_type: DepositType,
        amount_lamports: u64,
    ) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Created || deal.status == DealStatus::PartiallyFunded,
                 ConfidentialEscrowError::InvalidDealStatus);
        require!(
            deal.funding_privacy_tier == FundingPrivacyTier::Unset
                || deal.funding_privacy_tier == FundingPrivacyTier::DirectSol,
            ConfidentialEscrowError::FundingRailMismatch
        );

        // Verify depositor is the correct party
        match deposit_type {
            DepositType::BuyerPayment | DepositType::BuyerCollateral => {
                require!(
                    participant_commitment(&ctx.accounts.depositor.key())
                        == deal.buyer_identity_commitment,
                    ConfidentialEscrowError::Unauthorized
                );
            }
            DepositType::SellerCollateral => {
                require!(
                    participant_commitment(&ctx.accounts.depositor.key())
                        == deal.seller_identity_commitment,
                    ConfidentialEscrowError::Unauthorized
                );
            }
        }

        let amount = if deal.private_funding_registered {
            let expected_hash = compute_private_funding_hash(
                deal,
                deposit_type,
                amount_lamports,
            )?;
            match deposit_type {
                DepositType::BuyerPayment => {
                    require!(!deal.buyer_payment_deposited, ConfidentialEscrowError::DuplicateDepositType);
                    require!(expected_hash == deal.buyer_payment_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                }
                DepositType::BuyerCollateral => {
                    require!(!deal.buyer_collateral_deposited, ConfidentialEscrowError::DuplicateDepositType);
                    require!(expected_hash == deal.buyer_collateral_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                }
                DepositType::SellerCollateral => {
                    require!(!deal.seller_collateral_deposited, ConfidentialEscrowError::DuplicateDepositType);
                    require!(expected_hash == deal.seller_collateral_funding_hash, ConfidentialEscrowError::InvalidFundingCommitment);
                }
            }
            amount_lamports
        } else {
            require!(deposit_type != DepositType::BuyerPayment, ConfidentialEscrowError::InvalidDepositType);
            deal.bet_lamports
        };

        // Transfer SOL to deal PDA
        if amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.depositor.to_account_info(),
                        to: ctx.accounts.deal.to_account_info(),
                    },
                ),
                amount,
            )?;
        }

        // Update status
        let deal = &mut ctx.accounts.deal;
        deal.funding_privacy_tier = FundingPrivacyTier::DirectSol;
        if deal.private_funding_registered {
            match deposit_type {
                DepositType::BuyerPayment => {
                    deal.buyer_payment_deposited = true;
                }
                DepositType::BuyerCollateral => {
                    deal.buyer_collateral_deposited = true;
                }
                DepositType::SellerCollateral => {
                    deal.seller_collateral_deposited = true;
                }
            }

            if deal.buyer_payment_deposited
                && deal.buyer_collateral_deposited
                && deal.seller_collateral_deposited
            {
                deal.status = DealStatus::Funded;
            } else {
                deal.status = DealStatus::PartiallyFunded;
            }
        } else {
            if deal.status == DealStatus::Created {
                deal.status = DealStatus::PartiallyFunded;
            } else {
                deal.status = DealStatus::Funded;
            }
        }

        emit!(DepositRecorded {
            deal_id: deal.deal_id,
            deposit_type,
        });

        Ok(())
    }

    /// Instruction 2: Request decryption of the settlement result.
    ///
    /// After the Encrypt executor has computed the FHE settlement graph and
    /// written the result to settlement_result_ct, anyone can request decryption.
    /// The digest is stored in the deal for later verification (store-and-verify).
    pub fn request_settlement_decryption(
        ctx: Context<RequestSettlementDecryption>,
        encrypt_cpi_authority_bump: u8,
    ) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(
            deal.status == DealStatus::Funded,
            ConfidentialEscrowError::InvalidDealStatus
        );
        require!(
            ctx.accounts.result_ciphertext.key().to_bytes() == deal.settlement_result_ct,
            ConfidentialEscrowError::CiphertextMismatch
        );

        let encrypt_program_id = ENCRYPT_PROGRAM_ID
            .parse::<Pubkey>()
            .map_err(|_| ConfidentialEscrowError::InvalidProgramId)?;
        require_keys_eq!(
            ctx.accounts.encrypt_program.key(),
            encrypt_program_id,
            ConfidentialEscrowError::InvalidProgramId
        );
        require!(
            ctx.accounts.caller_program.key() == crate::ID
                && ctx.accounts.caller_program.to_account_info().executable,
            ConfidentialEscrowError::InvalidCallerProgram
        );
        let (expected_cpi_authority, _) = derive_encrypt_cpi_authority(ctx.program_id);
        require_keys_eq!(
            ctx.accounts.cpi_authority.key(),
            expected_cpi_authority,
            ConfidentialEscrowError::InvalidEncryptAccount
        );

        let encrypt_ctx = EncryptContext {
            encrypt_program: ctx.accounts.encrypt_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            deposit: ctx.accounts.deposit.to_account_info(),
            cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
            caller_program: ctx.accounts.caller_program.to_account_info(),
            network_encryption_key: ctx.accounts.network_encryption_key.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            cpi_authority_bump: encrypt_cpi_authority_bump,
        };
        let digest = encrypt_ctx.request_decryption(
            &ctx.accounts.request_account.to_account_info(),
            &ctx.accounts.result_ciphertext.to_account_info(),
        )?;

        let result_ct_key = Pubkey::new_from_array(deal.settlement_result_ct);
        let deal = &mut ctx.accounts.deal;
        deal.pending_digest = digest;
        deal.status = DealStatus::Settling;

        emit!(DecryptionRequested {
            deal_id: deal.deal_id,
            digest,
            result_ct: result_ct_key,
        });

        msg!("Decryption requested via CPI, digest stored for verification");
        Ok(())
    }

    pub fn submit_release_approval(
        ctx: Context<SubmitReleaseApproval>,
        payload: ReleaseApprovalPayload,
        role_seed: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        verify_release_approval_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.approver.key(),
            &payload,
        )?;

        let deal = &mut ctx.accounts.deal;
        require!(deal.status == DealStatus::Settling, ConfidentialEscrowError::InvalidDealStatus);
        require!(!deal.dispute_open, ConfidentialEscrowError::DisputeOpen);
        require!(!deal.release_authorized, ConfidentialEscrowError::ReleaseAlreadyAuthorized);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        validate_release_payload(deal, &payload)?;
        require!(approval_role_from_seed(role_seed)? == payload.role, ConfidentialEscrowError::InvalidApprovalRole);
        require!(payload.action == ReleaseApprovalAction::ApproveSettlement, ConfidentialEscrowError::InvalidApprovalAction);
        require!(payload.expires_at > now, ConfidentialEscrowError::ApprovalExpired);

        let expected_role = role_for_approver(deal, ctx.accounts.approver.key())?;
        require!(payload.role == expected_role, ConfidentialEscrowError::InvalidApprovalRole);

        let approval = &mut ctx.accounts.release_approval;
        approval.deal = deal.key();
        approval.role = payload.role;
        approval.settlement_policy = payload.settlement_policy;
        approval.terms_hash = payload.terms_hash;
        approval.plan_hash = payload.plan_hash;
        approval.approval_kind = payload.action;
        approval.nonce = payload.nonce;
        approval.expires_at = payload.expires_at;
        approval.active = true;
        approval.created_at = if approval.created_at == 0 { now } else { approval.created_at };
        approval.updated_at = now;
        approval.bump = ctx.bumps.release_approval;

        match payload.role {
            ApprovalRole::Buyer => {
                require!(payload.nonce > deal.buyer_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.buyer_release_nonce = payload.nonce;
                deal.buyer_plan_approved = true;
                deal.buyer_release_confirmed = false;
            }
            ApprovalRole::Seller => {
                require!(payload.nonce > deal.seller_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.seller_release_nonce = payload.nonce;
                deal.seller_plan_approved = true;
            }
        }
        deal.release_requested_at = 0;
        deal.seller_dispute_deadline_at = 0;
        deal.release_authorized = false;

        emit!(ReleaseApprovalRecorded {
            deal_id: deal.deal_id,
            role: payload.role,
            nonce: payload.nonce,
        });

        Ok(())
    }

    pub fn revoke_release_approval(
        ctx: Context<SubmitReleaseApproval>,
        payload: ReleaseApprovalPayload,
        role_seed: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        verify_release_approval_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.approver.key(),
            &payload,
        )?;

        let deal = &mut ctx.accounts.deal;
        require!(!deal.release_authorized, ConfidentialEscrowError::ReleaseAlreadyAuthorized);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        validate_release_payload(deal, &payload)?;
        require!(approval_role_from_seed(role_seed)? == payload.role, ConfidentialEscrowError::InvalidApprovalRole);
        require!(payload.action == ReleaseApprovalAction::RevokeSettlement, ConfidentialEscrowError::InvalidApprovalAction);

        let expected_role = role_for_approver(deal, ctx.accounts.approver.key())?;
        require!(payload.role == expected_role, ConfidentialEscrowError::InvalidApprovalRole);

        let approval = &mut ctx.accounts.release_approval;
        approval.deal = deal.key();
        approval.role = payload.role;
        approval.settlement_policy = payload.settlement_policy;
        approval.terms_hash = payload.terms_hash;
        approval.plan_hash = payload.plan_hash;
        approval.approval_kind = payload.action;
        approval.nonce = payload.nonce;
        approval.expires_at = payload.expires_at;
        approval.active = false;
        approval.created_at = if approval.created_at == 0 { now } else { approval.created_at };
        approval.updated_at = now;
        approval.bump = ctx.bumps.release_approval;

        match payload.role {
            ApprovalRole::Buyer => {
                require!(payload.nonce > deal.buyer_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.buyer_release_nonce = payload.nonce;
                deal.buyer_plan_approved = false;
            }
            ApprovalRole::Seller => {
                require!(payload.nonce > deal.seller_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.seller_release_nonce = payload.nonce;
                deal.seller_plan_approved = false;
            }
        }
        deal.buyer_release_confirmed = false;
        deal.release_requested_at = 0;
        deal.seller_dispute_deadline_at = 0;
        deal.release_authorized = false;

        emit!(ReleaseApprovalRevoked {
            deal_id: deal.deal_id,
            role: payload.role,
            nonce: payload.nonce,
        });

        Ok(())
    }

    pub fn confirm_release(
        ctx: Context<SubmitReleaseApproval>,
        payload: ReleaseApprovalPayload,
        role_seed: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        verify_release_approval_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.approver.key(),
            &payload,
        )?;

        let deal = &mut ctx.accounts.deal;
        require!(deal.status == DealStatus::Settling, ConfidentialEscrowError::InvalidDealStatus);
        require!(!deal.dispute_open, ConfidentialEscrowError::DisputeOpen);
        require!(!deal.release_authorized, ConfidentialEscrowError::ReleaseAlreadyAuthorized);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        validate_release_payload(deal, &payload)?;
        require!(approval_role_from_seed(role_seed)? == payload.role, ConfidentialEscrowError::InvalidApprovalRole);
        require!(payload.action == ReleaseApprovalAction::ConfirmRelease, ConfidentialEscrowError::InvalidApprovalAction);
        require!(payload.expires_at > now, ConfidentialEscrowError::ApprovalExpired);
        require!(deal.buyer_plan_approved && deal.seller_plan_approved, ConfidentialEscrowError::SettlementPlanNotApproved);

        let expected_role = role_for_approver(deal, ctx.accounts.approver.key())?;
        require!(expected_role == ApprovalRole::Buyer, ConfidentialEscrowError::InvalidApprovalRole);
        require!(payload.role == ApprovalRole::Buyer, ConfidentialEscrowError::InvalidApprovalRole);

        let approval = &mut ctx.accounts.release_approval;
        approval.deal = deal.key();
        approval.role = payload.role;
        approval.settlement_policy = payload.settlement_policy;
        approval.terms_hash = payload.terms_hash;
        approval.plan_hash = payload.plan_hash;
        approval.approval_kind = payload.action;
        approval.nonce = payload.nonce;
        approval.expires_at = payload.expires_at;
        approval.active = true;
        approval.created_at = if approval.created_at == 0 { now } else { approval.created_at };
        approval.updated_at = now;
        approval.bump = ctx.bumps.release_approval;

        require!(payload.nonce > deal.buyer_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
        deal.buyer_release_nonce = payload.nonce;
        deal.buyer_release_confirmed = true;
        deal.release_requested_at = now;
        deal.seller_dispute_deadline_at =
            now + i64::from(deal.seller_dispute_window_seconds);
        deal.release_authorized = false;

        emit!(ReleaseApprovalRecorded {
            deal_id: deal.deal_id,
            role: payload.role,
            nonce: payload.nonce,
        });

        Ok(())
    }

    pub fn open_release_dispute(
        ctx: Context<SubmitReleaseApproval>,
        payload: ReleaseApprovalPayload,
        role_seed: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        verify_release_approval_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.approver.key(),
            &payload,
        )?;

        let deal = &mut ctx.accounts.deal;
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        validate_release_payload(deal, &payload)?;
        require!(approval_role_from_seed(role_seed)? == payload.role, ConfidentialEscrowError::InvalidApprovalRole);
        require!(payload.action == ReleaseApprovalAction::OpenDispute, ConfidentialEscrowError::InvalidApprovalAction);

        let expected_role = role_for_approver(deal, ctx.accounts.approver.key())?;
        require!(payload.role == expected_role, ConfidentialEscrowError::InvalidApprovalRole);

        let approval = &mut ctx.accounts.release_approval;
        approval.deal = deal.key();
        approval.role = payload.role;
        approval.settlement_policy = payload.settlement_policy;
        approval.terms_hash = payload.terms_hash;
        approval.plan_hash = payload.plan_hash;
        approval.approval_kind = payload.action;
        approval.nonce = payload.nonce;
        approval.expires_at = payload.expires_at;
        approval.active = false;
        approval.created_at = if approval.created_at == 0 { now } else { approval.created_at };
        approval.updated_at = now;
        approval.bump = ctx.bumps.release_approval;

        match payload.role {
            ApprovalRole::Buyer => {
                require!(payload.nonce > deal.buyer_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.buyer_release_nonce = payload.nonce;
            }
            ApprovalRole::Seller => {
                require!(payload.nonce > deal.seller_release_nonce, ConfidentialEscrowError::InvalidApprovalNonce);
                deal.seller_release_nonce = payload.nonce;
            }
        }

        deal.dispute_open = true;
        deal.status = DealStatus::Disputed;
        deal.buyer_release_confirmed = false;
        deal.release_requested_at = 0;
        deal.seller_dispute_deadline_at = 0;
        deal.release_authorized = false;

        emit!(ReleaseDisputeOpened {
            deal_id: deal.deal_id,
            role: payload.role,
            nonce: payload.nonce,
        });

        Ok(())
    }

    pub fn resolve_release_dispute(ctx: Context<ResolveReleaseDispute>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        require!(ctx.accounts.authority.key() == deal.middleman, ConfidentialEscrowError::Unauthorized);
        require!(deal.dispute_open, ConfidentialEscrowError::DisputeNotOpen);

        deal.dispute_open = false;
        deal.buyer_plan_approved = false;
        deal.seller_plan_approved = false;
        deal.buyer_release_confirmed = false;
        deal.release_requested_at = 0;
        deal.seller_dispute_deadline_at = 0;
        deal.release_authorized = false;
        if deal.status == DealStatus::Disputed {
            deal.status = DealStatus::Settling;
        }
        ctx.accounts.buyer_approval.active = false;
        ctx.accounts.buyer_approval.updated_at = Clock::get()?.unix_timestamp;
        ctx.accounts.seller_approval.active = false;
        ctx.accounts.seller_approval.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReleaseDisputeResolved {
            deal_id: deal.deal_id,
            resolver: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Instruction 3: Reveal the decrypted settlement result and release funds.
    ///
    /// Implements the store-and-verify pattern:
    /// 1. Read the decrypted value from the decryption request account
    /// 2. Verify the digest matches what was stored during request_settlement_decryption
    /// 3. If valid, release funds to the appropriate party
    ///
    /// This prevents stale-value and race-condition attacks — if the ciphertext
    /// was modified between request and reveal, the digest won't match.
    pub fn reveal_and_release(
        ctx: Context<RevealAndRelease>,
        buyer_payment_lamports: u64,
        buyer_collateral_lamports: u64,
        seller_collateral_lamports: u64,
    ) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Settling,
                 ConfidentialEscrowError::InvalidDealStatus);
        require!(!deal.dispute_open, ConfidentialEscrowError::DisputeOpen);
        require!(deal.release_authorized, ConfidentialEscrowError::ReleaseNotAuthorized);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        require!(deal.buyer_release_confirmed, ConfidentialEscrowError::BuyerReleaseConfirmationMissing);
        require!(
            deal.funding_privacy_tier != FundingPrivacyTier::ShieldedCredit,
            ConfidentialEscrowError::FundingRailMismatch
        );

        // Only the middleman can trigger release
        require!(ctx.accounts.authority.key() == deal.middleman,
                 ConfidentialEscrowError::Unauthorized);

        let now = Clock::get()?.unix_timestamp;
        validate_settlement_plan_approval_account(
            deal,
            &ctx.accounts.buyer_approval,
            ApprovalRole::Buyer,
            now,
        )?;
        validate_settlement_plan_approval_account(
            deal,
            &ctx.accounts.seller_approval,
            ApprovalRole::Seller,
            now,
        )?;

        // ── Verify dWallet approval is signed before any payout can occur ──
        // This enforces the production settlement contract:
        // dWallet MPC signature must exist on-chain before release_funds executes.
        let approval_data = ctx.accounts.message_approval.try_borrow_data()?;
        require!(
            approval_data.len() > MESSAGE_APPROVAL_STATUS_OFFSET,
            ConfidentialEscrowError::ApprovalPending
        );
        require!(
            approval_data[0] == MESSAGE_APPROVAL_DISC,
            ConfidentialEscrowError::InvalidMessageApproval
        );

        let approval_dwallet = Pubkey::new_from_array(
            approval_data[MESSAGE_APPROVAL_DWALLET_OFFSET..MESSAGE_APPROVAL_DWALLET_OFFSET + 32]
                .try_into()
                .unwrap()
        );
        require!(
            approval_dwallet == deal.dwallet,
            ConfidentialEscrowError::InvalidMessageApproval
        );
        require!(
            approval_data[MESSAGE_APPROVAL_STATUS_OFFSET] == MESSAGE_APPROVAL_STATUS_SIGNED,
            ConfidentialEscrowError::ApprovalPending
        );
        drop(approval_data);

        let req_data = ctx.accounts.request_account.try_borrow_data()?;
        let decrypted_value = *encrypt_accounts::parse_decrypted_verified::<Uint64>(
            &req_data,
            &deal.pending_digest,
        )
        .ok_or_else(|| error!(ConfidentialEscrowError::DecryptionPending))?;
        drop(req_data);

        // The Encrypt graph now returns an explicit settlement-valid flag:
        //   1 => negotiated collateral covers the payment obligation
        //   0 => invalid / insufficient collateral
        let settlement_valid = decrypted_value > 0;

        // ── Verify just-in-time revealed settlement plan and funding amounts ──
        let revealed_plan_hash = compute_settlement_plan_hash(
            deal,
            ctx.accounts.buyer_target.key(),
            ctx.accounts.seller_target.key(),
        )?;
        require!(
            revealed_plan_hash == deal.plan_hash,
            ConfidentialEscrowError::InvalidSettlementTarget
        );

        let (buyer_payout, seller_payout, principal_target) = if deal.private_funding_registered {
            require!(
                compute_private_funding_hash(
                    deal,
                    DepositType::BuyerPayment,
                    buyer_payment_lamports,
                )? == deal.buyer_payment_funding_hash,
                ConfidentialEscrowError::InvalidFundingCommitment
            );
            require!(
                compute_private_funding_hash(
                    deal,
                    DepositType::BuyerCollateral,
                    buyer_collateral_lamports,
                )? == deal.buyer_collateral_funding_hash,
                ConfidentialEscrowError::InvalidFundingCommitment
            );
            require!(
                compute_private_funding_hash(
                    deal,
                    DepositType::SellerCollateral,
                    seller_collateral_lamports,
                )? == deal.seller_collateral_funding_hash,
                ConfidentialEscrowError::InvalidFundingCommitment
            );

            if settlement_valid {
                (
                    buyer_collateral_lamports,
                    buyer_payment_lamports
                        .checked_add(seller_collateral_lamports)
                        .ok_or(ConfidentialEscrowError::AmountOverflow)?,
                    ctx.accounts.seller_target.key(),
                )
            } else {
                (
                    buyer_payment_lamports
                        .checked_add(buyer_collateral_lamports)
                        .ok_or(ConfidentialEscrowError::AmountOverflow)?,
                    seller_collateral_lamports,
                    ctx.accounts.buyer_target.key(),
                )
            }
        } else if settlement_valid {
            (0, deal.bet_lamports * 2, ctx.accounts.seller_target.key())
        } else {
            (deal.bet_lamports * 2, 0, ctx.accounts.buyer_target.key())
        };

        let total_payout = buyer_payout
            .checked_add(seller_payout)
            .ok_or(ConfidentialEscrowError::AmountOverflow)?;
        if total_payout > 0 {
            let deal_info = ctx.accounts.deal.to_account_info();
            if buyer_payout > 0 {
                let buyer_info = ctx.accounts.buyer_target.to_account_info();
                **deal_info.try_borrow_mut_lamports()? -= buyer_payout;
                **buyer_info.try_borrow_mut_lamports()? += buyer_payout;
            }
            if seller_payout > 0 {
                let seller_info = ctx.accounts.seller_target.to_account_info();
                **deal_info.try_borrow_mut_lamports()? -= seller_payout;
                **seller_info.try_borrow_mut_lamports()? += seller_payout;
            }
        }

        let deal = &mut ctx.accounts.deal;
        deal.status = DealStatus::Completed;
        deal.release_executed = true;

        emit!(DealSettled {
            deal_id: deal.deal_id,
            winner: principal_target,
            payout: total_payout,
        });

        msg!(
            "Settlement verified (value={}), buyer payout: {}, seller payout: {}",
            decrypted_value,
            buyer_payout,
            seller_payout
        );
        Ok(())
    }

    /// Instruction 4: Approve a cross-chain message for signing via dWallet.
    ///
    /// When a deal completes, the middleman program can authorize the Ika network
    /// to sign a cross-chain settlement proof. This creates a MessageApproval PDA
    /// on the dWallet program, which the Ika validators detect and sign via 2PC-MPC.
    pub fn approve_cross_chain(
        ctx: Context<ApproveCrossChain>,
        message_hash: [u8; 32],
        message_metadata_hash: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        message_approval_bump: u8,
        dwallet_cpi_authority_bump: u8,
    ) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Settling,
                 ConfidentialEscrowError::InvalidDealStatus);
        require!(!deal.dispute_open, ConfidentialEscrowError::DisputeOpen);
        require!(!deal.release_executed, ConfidentialEscrowError::ReleaseAlreadyExecuted);
        require!(!deal.release_authorized, ConfidentialEscrowError::ReleaseAlreadyAuthorized);
        let now = Clock::get()?.unix_timestamp;
        require!(deal.buyer_release_confirmed, ConfidentialEscrowError::BuyerReleaseConfirmationMissing);
        require!(
            deal.seller_dispute_deadline_at > 0 && now >= deal.seller_dispute_deadline_at,
            ConfidentialEscrowError::SellerDisputeWindowActive
        );
        validate_settlement_plan_approval_account(
            deal,
            &ctx.accounts.buyer_approval,
            ApprovalRole::Buyer,
            now,
        )?;
        validate_settlement_plan_approval_account(
            deal,
            &ctx.accounts.seller_approval,
            ApprovalRole::Seller,
            now,
        )?;

        // SECURITY: Verify caller_program is executable (prevents CPI spoofing)
        require!(ctx.accounts.caller_program.to_account_info().executable,
                 ConfidentialEscrowError::Unauthorized);

        // ── CPI to dWallet: approve_message (disc 8) ──
        // Data: [8(1), bump(1), msg_digest(32), meta_digest(32), user_pk(32), scheme(2)] = 100 bytes
        let mut ix_data = Vec::with_capacity(100);
        ix_data.push(IX_APPROVE_MESSAGE);
        ix_data.push(message_approval_bump);
        ix_data.extend_from_slice(&message_hash);
        ix_data.extend_from_slice(&message_metadata_hash);
        ix_data.extend_from_slice(&user_pubkey);
        ix_data.extend_from_slice(&signature_scheme.to_le_bytes());

        let dwallet_program_id = DWALLET_PROGRAM_ID.parse::<Pubkey>()
            .map_err(|_| ConfidentialEscrowError::InvalidProgramId)?;

        // Accounts per docs: coordinator(ro), message_approval(wr), dwallet(ro),
        // caller_program(ro,exec), cpi_authority(ro), payer(wr,signer), system_program(ro)
        let cpi_accounts = vec![
            AccountMeta::new_readonly(ctx.accounts.coordinator.key(), false),
            AccountMeta::new(ctx.accounts.message_approval.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dwallet.key(), false),
            AccountMeta::new_readonly(ctx.accounts.caller_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dwallet_cpi_authority.key(), true),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ];

        let cpi_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: dwallet_program_id,
            accounts: cpi_accounts,
            data: ix_data,
        };

        // Sign with CPI authority PDA
        let bump_bytes = [dwallet_cpi_authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[DWALLET_CPI_SEED, &bump_bytes]];

        anchor_lang::solana_program::program::invoke_signed(
            &cpi_ix,
            &[
                ctx.accounts.dwallet_program.to_account_info(),
                ctx.accounts.coordinator.to_account_info(),
                ctx.accounts.message_approval.to_account_info(),
                ctx.accounts.dwallet.to_account_info(),
                ctx.accounts.caller_program.to_account_info(),
                ctx.accounts.dwallet_cpi_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        let deal = &mut ctx.accounts.deal;
        deal.release_authorized = true;

        emit!(CrossChainApproved {
            deal_id: deal.deal_id,
            message_hash,
            dwallet: deal.dwallet,
            signature_scheme,
        });

        msg!("Cross-chain message approved for signing");
        Ok(())
    }

    /// Instruction 5: Cancel a deal before both parties have deposited.
    ///
    /// Only the creator (middleman) can cancel. Refunds any existing deposit.
    pub fn cancel_deal(ctx: Context<CancelDeal>) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Created || deal.status == DealStatus::PartiallyFunded,
                 ConfidentialEscrowError::InvalidDealStatus);
        require!(ctx.accounts.authority.key() == deal.middleman,
                 ConfidentialEscrowError::Unauthorized);

        // Refund any deposited lamports
        let deal_info = ctx.accounts.deal.to_account_info();
        let refund = deal_info.lamports();
        let rent_exempt = Rent::get()?.minimum_balance(deal_info.data_len());
        let refundable = refund.saturating_sub(rent_exempt);

        if refundable > 0 {
            let authority_info = ctx.accounts.authority.to_account_info();
            **deal_info.try_borrow_mut_lamports()? -= refundable;
            **authority_info.try_borrow_mut_lamports()? += refundable;
        }

        let deal = &mut ctx.accounts.deal;
        deal.status = DealStatus::Cancelled;

        emit!(DealCancelled {
            deal_id: deal.deal_id,
            cancelled_by: ctx.accounts.authority.key(),
        });

        Ok(())
    }
}

// ============================================================================
// ACCOUNTS
// ============================================================================

#[derive(Accounts)]
#[instruction(deal_id: [u8; 32], bet_lamports: u64, terms_hash: [u8; 32], plan_hash: [u8; 32], settlement_policy: ReleaseSettlementPolicy, buyer_identity_commitment: [u8; 32], seller_identity_commitment: [u8; 32], encrypt_cpi_authority_bump: u8)]
pub struct CreateConfidentialDeal<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ConfidentialDeal::INIT_SPACE,
        seeds = [b"confidential_deal", deal_id.as_ref()],
        bump,
    )]
    pub deal: Account<'info, ConfidentialDeal>,
    /// Middleman agent (must sign)
    pub middleman: Signer<'info>,
    /// CHECK: dWallet account for cross-chain signing
    pub dwallet: UncheckedAccount<'info>,
    /// CHECK: Buyer collateral ciphertext account, must be program-authorized
    #[account(mut)]
    pub buyer_collateral_ciphertext: UncheckedAccount<'info>,
    /// CHECK: Seller collateral ciphertext account, must be program-authorized
    #[account(mut)]
    pub seller_collateral_ciphertext: UncheckedAccount<'info>,
    /// CHECK: Payment ciphertext account, must be program-authorized
    #[account(mut)]
    pub payment_amount_ciphertext: UncheckedAccount<'info>,
    /// CHECK: Result ciphertext account, must be program-authorized
    #[account(mut)]
    pub settlement_result_ciphertext: UncheckedAccount<'info>,
    /// CHECK: Encrypt program
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt config PDA
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit PDA for fee source
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: Program CPI authority PDA
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: This program executable account for Encrypt CPI authorization
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Active network encryption key PDA
    pub network_encryption_key: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Encrypt event authority PDA
    pub event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeCreditVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CreditVault::INIT_SPACE,
        seeds = [CREDIT_VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, CreditVault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSolForCredit<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + CreditBalance::INIT_SPACE,
        seeds = [CREDIT_BALANCE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub credit_balance: Account<'info, CreditBalance>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(deposit_type: DepositType)]
pub struct LockCreditForDeal<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(
        mut,
        seeds = [CREDIT_BALANCE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = credit_balance.bump,
    )]
    pub credit_balance: Account<'info, CreditBalance>,
    #[account(
        init,
        payer = owner,
        space = 8 + CreditLock::INIT_SPACE,
        seeds = [
            CREDIT_LOCK_SEED,
            deal.key().as_ref(),
            owner.key().as_ref(),
            &[deposit_type_seed(deposit_type)],
        ],
        bump,
    )]
    pub credit_lock: Account<'info, CreditLock>,
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositEncrypted<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleLockedCredit<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub buyer_payment_lock: Account<'info, CreditLock>,
    #[account(mut)]
    pub buyer_collateral_lock: Account<'info, CreditLock>,
    #[account(mut)]
    pub seller_collateral_lock: Account<'info, CreditLock>,
    #[account(mut)]
    pub buyer_credit_balance: Account<'info, CreditBalance>,
    #[account(mut)]
    pub seller_credit_balance: Account<'info, CreditBalance>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(withdrawal_id: [u8; 32])]
pub struct QueueWithdrawal<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(
        mut,
        seeds = [CREDIT_BALANCE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = credit_balance.bump,
    )]
    pub credit_balance: Account<'info, CreditBalance>,
    #[account(
        init,
        payer = owner,
        space = 8 + CreditWithdrawal::INIT_SPACE,
        seeds = [WITHDRAWAL_SEED, vault.key().as_ref(), withdrawal_id.as_ref()],
        bump,
    )]
    pub withdrawal: Account<'info, CreditWithdrawal>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: withdrawal destination is stored and paid later
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteWithdrawalBatch<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(mut)]
    pub withdrawal: Account<'info, CreditWithdrawal>,
    /// CHECK: destination checked against withdrawal record
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct EmergencyRefundAfterTimeout<'info> {
    #[account(mut, seeds = [CREDIT_VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, CreditVault>,
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub credit_lock: Account<'info, CreditLock>,
    #[account(
        mut,
        seeds = [CREDIT_BALANCE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = credit_balance.bump,
    )]
    pub credit_balance: Account<'info, CreditBalance>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RequestSettlementDecryption<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    /// Fresh decryption request account keypair. Must sign because Encrypt creates it.
    #[account(mut)]
    pub request_account: Signer<'info>,
    /// CHECK: Settlement result ciphertext account
    pub result_ciphertext: UncheckedAccount<'info>,
    /// CHECK: Encrypt program
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt config PDA
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit PDA for fee source
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: Program CPI authority PDA
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: This program executable account for Encrypt CPI authorization
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Active network encryption key PDA
    pub network_encryption_key: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
    /// CHECK: Encrypt event authority PDA
    pub event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterPrivateFundingCommitments<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevealAndRelease<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    /// CHECK: Decryption request account (contains decrypted value)
    pub request_account: UncheckedAccount<'info>,
    /// CHECK: MessageApproval PDA must exist and be signed before release
    pub message_approval: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer_approval: Account<'info, ReleaseApproval>,
    #[account(mut)]
    pub seller_approval: Account<'info, ReleaseApproval>,
    /// CHECK: Buyer payout target validated against deal state
    #[account(mut)]
    pub buyer_target: UncheckedAccount<'info>,
    /// CHECK: Seller payout target validated against deal state
    #[account(mut)]
    pub seller_target: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveCrossChain<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    pub buyer_approval: Account<'info, ReleaseApproval>,
    pub seller_approval: Account<'info, ReleaseApproval>,
    /// CHECK: dWallet program executable used as CPI target
    #[account(address = Pubkey::from_str(DWALLET_PROGRAM_ID).unwrap())]
    pub dwallet_program: UncheckedAccount<'info>,
    /// CHECK: DWalletCoordinator PDA (readonly, for epoch)
    pub coordinator: UncheckedAccount<'info>,
    /// CHECK: MessageApproval PDA on dWallet program (created via CPI)
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,
    /// CHECK: dWallet account
    pub dwallet: UncheckedAccount<'info>,
    /// CHECK: This program's account (executable, for CPI verification)
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: CPI authority PDA [__ika_cpi_authority]
    pub dwallet_cpi_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelDeal<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(payload: ReleaseApprovalPayload, role_seed: u8)]
pub struct SubmitReleaseApproval<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ReleaseApproval::INIT_SPACE,
        seeds = [b"release_approval", deal.key().as_ref(), &[role_seed]],
        bump,
    )]
    pub release_approval: Account<'info, ReleaseApproval>,
    /// CHECK: the agent wallet whose Ed25519 signature is verified via the instructions sysvar
    pub approver: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: instructions sysvar for verifying the preceding Ed25519 program instruction
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveReleaseDispute<'info> {
    #[account(mut)]
    pub deal: Account<'info, ConfidentialDeal>,
    #[account(mut)]
    pub buyer_approval: Account<'info, ReleaseApproval>,
    #[account(mut)]
    pub seller_approval: Account<'info, ReleaseApproval>,
    pub authority: Signer<'info>,
}

// ============================================================================
// STATE
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct ConfidentialDeal {
    /// Unique deal identifier (32 bytes)
    pub deal_id: [u8; 32],
    /// Buyer identity commitment (hash of the participant wallet)
    pub buyer_identity_commitment: [u8; 32],
    /// Seller identity commitment (hash of the participant wallet)
    pub seller_identity_commitment: [u8; 32],
    /// Middleman agent pubkey
    pub middleman: Pubkey,
    /// PER session PDA used to bind private funding commitments
    pub session_pda: Pubkey,
    /// Buyer collateral ciphertext account pubkey (Encrypt)
    pub buyer_collateral_ct: [u8; 32],
    /// Seller collateral ciphertext account pubkey (Encrypt)
    pub seller_collateral_ct: [u8; 32],
    /// Payment amount ciphertext account pubkey (Encrypt)
    pub payment_amount_ct: [u8; 32],
    /// Settlement result ciphertext account pubkey (Encrypt, written by executor)
    pub settlement_result_ct: [u8; 32],
    /// dWallet account for cross-chain signing (Ika)
    pub dwallet: Pubkey,
    /// Funding commitment hash for the buyer's payment leg
    pub buyer_payment_funding_hash: [u8; 32],
    /// Funding commitment hash for the buyer's collateral leg
    pub buyer_collateral_funding_hash: [u8; 32],
    /// Funding commitment hash for the seller's collateral leg
    pub seller_collateral_funding_hash: [u8; 32],
    /// True once the private funding commitments are registered
    pub private_funding_registered: bool,
    /// Buyer payment deposit status
    pub buyer_payment_deposited: bool,
    /// Buyer collateral deposit status
    pub buyer_collateral_deposited: bool,
    /// Seller collateral deposit status
    pub seller_collateral_deposited: bool,
    /// Terms hash bound to release approvals
    pub terms_hash: [u8; 32],
    /// Settlement plan hash bound to release approvals
    pub plan_hash: [u8; 32],
    /// Settlement policy bound to the committed release plan
    pub settlement_policy: ReleaseSettlementPolicy,
    /// PER funding rail used for this deal.
    pub funding_privacy_tier: FundingPrivacyTier,
    /// Latest buyer approval nonce
    pub buyer_release_nonce: u64,
    /// Latest seller approval nonce
    pub seller_release_nonce: u64,
    /// True once buyer approves the settlement plan
    pub buyer_plan_approved: bool,
    /// True once seller approves the settlement plan
    pub seller_plan_approved: bool,
    /// Buyer has explicitly requested final release after settlement verification
    pub buyer_release_confirmed: bool,
    /// Timestamp when buyer requested final release
    pub release_requested_at: i64,
    /// Seller can dispute until this unix timestamp
    pub seller_dispute_deadline_at: i64,
    /// Configured dispute window length in seconds
    pub seller_dispute_window_seconds: u32,
    /// Hard block while dispute is unresolved
    pub dispute_open: bool,
    /// True once both approvals are locked and IKA signing begins
    pub release_authorized: bool,
    /// True once payout has executed
    pub release_executed: bool,
    /// Decryption digest for store-and-verify pattern
    pub pending_digest: [u8; 32],
    /// Deal status enum
    pub status: DealStatus,
    /// Bet amount per side in lamports
    pub bet_lamports: u64,
    /// Unix timestamp of deal creation
    pub created_at: i64,
    /// PDA bump seed
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DealStatus {
    Created,
    PartiallyFunded,
    Funded,
    Settling,
    Completed,
    Disputed,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct CreditVault {
    pub authority: Pubkey,
    pub total_deposited_lamports: u64,
    pub total_issued_credit: u64,
    pub total_locked_credit: u64,
    pub pending_withdrawal_lamports: u64,
    pub executed_withdrawal_lamports: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreditBalance {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub available_lamports: u64,
    pub locked_lamports: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreditLock {
    pub vault: Pubkey,
    pub deal: Pubkey,
    pub owner: Pubkey,
    pub deposit_type: DepositType,
    pub amount_lamports: u64,
    pub settled: bool,
    pub refunded: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreditWithdrawal {
    pub withdrawal_id: [u8; 32],
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
    pub not_before_ts: i64,
    pub executed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum FundingPrivacyTier {
    Unset,
    DirectSol,
    StealthSol,
    ShieldedCredit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DepositType {
    BuyerPayment,
    BuyerCollateral,
    SellerCollateral,
}

#[account]
#[derive(InitSpace)]
pub struct ReleaseApproval {
    pub deal: Pubkey,
    pub role: ApprovalRole,
    pub settlement_policy: ReleaseSettlementPolicy,
    pub terms_hash: [u8; 32],
    pub plan_hash: [u8; 32],
    pub approval_kind: ReleaseApprovalAction,
    pub nonce: u64,
    pub expires_at: i64,
    pub active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ApprovalRole {
    Buyer,
    Seller,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ReleaseApprovalAction {
    ApproveSettlement,
    RevokeSettlement,
    ConfirmRelease,
    OpenDispute,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ReleaseRoute {
    ConfidentialEscrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ReleaseSettlementPolicy {
    Direct,
    Stealth,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct ReleaseApprovalPayload {
    pub version: u8,
    pub action: ReleaseApprovalAction,
    pub ticket_id_hash: [u8; 32],
    pub deal_pda: Pubkey,
    pub session_pda: Pubkey,
    pub intent_id_hash: [u8; 32],
    pub role: ApprovalRole,
    pub route: ReleaseRoute,
    pub settlement_policy: ReleaseSettlementPolicy,
    pub terms_hash: [u8; 32],
    pub plan_hash: [u8; 32],
    pub nonce: u64,
    pub expires_at: i64,
    pub timestamp: i64,
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct ConfidentialDealCreated {
    pub deal_id: [u8; 32],
    pub buyer_collateral_ct: [u8; 32],
    pub seller_collateral_ct: [u8; 32],
    pub settlement_result_ct: [u8; 32],
    pub dwallet: Pubkey,
}

#[event]
pub struct DepositRecorded {
    pub deal_id: [u8; 32],
    pub deposit_type: DepositType,
}

#[event]
pub struct CreditDeposited {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct CreditLocked {
    pub deal_id: [u8; 32],
    pub owner: Pubkey,
    pub deposit_type: DepositType,
    pub amount_lamports: u64,
}

#[event]
pub struct CreditSettled {
    pub deal_id: [u8; 32],
    pub settlement_valid: bool,
    pub total_lamports: u64,
}

#[event]
pub struct WithdrawalQueued {
    pub withdrawal_id: [u8; 32],
    pub owner: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
    pub not_before_ts: i64,
}

#[event]
pub struct WithdrawalBatchExecuted {
    pub withdrawal_id: [u8; 32],
    pub destination: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct DecryptionRequested {
    pub deal_id: [u8; 32],
    pub digest: [u8; 32],
    pub result_ct: Pubkey,
}

#[event]
pub struct DealSettled {
    pub deal_id: [u8; 32],
    pub winner: Pubkey,
    pub payout: u64,
}

#[event]
pub struct CrossChainApproved {
    pub deal_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub dwallet: Pubkey,
    pub signature_scheme: u16,
}

#[event]
pub struct DealCancelled {
    pub deal_id: [u8; 32],
    pub cancelled_by: Pubkey,
}

#[event]
pub struct ReleaseApprovalRecorded {
    pub deal_id: [u8; 32],
    pub role: ApprovalRole,
    pub nonce: u64,
}

#[event]
pub struct ReleaseApprovalRevoked {
    pub deal_id: [u8; 32],
    pub role: ApprovalRole,
    pub nonce: u64,
}

#[event]
pub struct ReleaseDisputeOpened {
    pub deal_id: [u8; 32],
    pub role: ApprovalRole,
    pub nonce: u64,
}

#[event]
pub struct ReleaseDisputeResolved {
    pub deal_id: [u8; 32],
    pub resolver: Pubkey,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum ConfidentialEscrowError {
    #[msg("Invalid deal status for this operation")]
    InvalidDealStatus,
    #[msg("Unauthorized: signer is not the expected party")]
    Unauthorized,
    #[msg("Decryption digest does not match stored value — possible stale-value attack")]
    DigestMismatch,
    #[msg("Deal has exceeded maximum lifetime")]
    DealExpired,
    #[msg("Invalid external program ID")]
    InvalidProgramId,
    #[msg("Ciphertext account mismatch")]
    CiphertextMismatch,
    #[msg("Decryption not yet complete")]
    DecryptionPending,
    #[msg("Lamport amount overflow")]
    AmountOverflow,
    #[msg("dWallet approval is not yet signed on-chain")]
    ApprovalPending,
    #[msg("Invalid MessageApproval account for this deal")]
    InvalidMessageApproval,
    #[msg("Invalid Encrypt account or PDA wiring")]
    InvalidEncryptAccount,
    #[msg("Caller program account is invalid or not executable")]
    InvalidCallerProgram,
    #[msg("Ciphertext account is invalid or missing digest data")]
    InvalidCiphertextAccount,
    #[msg("Settlement target is invalid for this deal")]
    InvalidSettlementTarget,
    #[msg("Approval nonce must strictly increase")]
    InvalidApprovalNonce,
    #[msg("Approval expired before it could be recorded")]
    ApprovalExpired,
    #[msg("Release payload action did not match the invoked instruction")]
    InvalidApprovalAction,
    #[msg("Release payload role does not match the approver wallet")]
    InvalidApprovalRole,
    #[msg("Release payload failed Ed25519 verification")]
    InvalidApprovalSignature,
    #[msg("Release approval PDA is not valid for this deal")]
    InvalidReleaseApprovalAccount,
    #[msg("A release dispute is already open")]
    DisputeOpen,
    #[msg("No dispute is open for this deal")]
    DisputeNotOpen,
    #[msg("Release already authorized for IKA signing")]
    ReleaseAlreadyAuthorized,
    #[msg("Release has already executed")]
    ReleaseAlreadyExecuted,
    #[msg("Release is not yet authorized")]
    ReleaseNotAuthorized,
    #[msg("Both buyer and seller must approve the settlement plan first")]
    SettlementPlanNotApproved,
    #[msg("Buyer has not yet confirmed the final release")]
    BuyerReleaseConfirmationMissing,
    #[msg("The seller dispute window is still active")]
    SellerDisputeWindowActive,
    #[msg("The deposit type is not valid for this funding model")]
    InvalidDepositType,
    #[msg("This deposit leg has already been recorded")]
    DuplicateDepositType,
    #[msg("The provided deposit amount does not match the committed funding hash")]
    InvalidFundingCommitment,
    #[msg("Funding rail does not match this deal")]
    FundingRailMismatch,
    #[msg("The credit vault is paused")]
    CreditVaultPaused,
    #[msg("Invalid credit vault account")]
    InvalidCreditVault,
    #[msg("Credit amount must be positive")]
    InvalidCreditAmount,
    #[msg("Insufficient internal credit")]
    InsufficientCredit,
    #[msg("Vault reserve invariant failed")]
    CreditReserveInvariantFailed,
    #[msg("Withdrawal has already been executed")]
    WithdrawalAlreadyExecuted,
    #[msg("Withdrawal delay has not elapsed")]
    WithdrawalNotReady,
    #[msg("Timeout has not been reached")]
    TimeoutNotReached,
}

// ============================================================================
// HELPERS
// ============================================================================

/// Derives the Encrypt CPI authority PDA for this program.
pub fn derive_encrypt_cpi_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ENCRYPT_CPI_SEED], program_id)
}

/// Derives the dWallet CPI authority PDA for this program.
pub fn derive_dwallet_cpi_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[DWALLET_CPI_SEED], program_id)
}

/// Derives the ConfidentialDeal PDA for a given deal_id.
pub fn derive_deal_pda(program_id: &Pubkey, deal_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"confidential_deal", deal_id.as_ref()],
        program_id,
    )
}

pub fn derive_release_approval_pda(
    program_id: &Pubkey,
    deal: &Pubkey,
    role_seed: u8,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"release_approval", deal.as_ref(), &[role_seed]],
        program_id,
    )
}

pub fn derive_credit_vault_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CREDIT_VAULT_SEED], program_id)
}

pub fn derive_credit_balance_pda(
    program_id: &Pubkey,
    vault: &Pubkey,
    owner: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[CREDIT_BALANCE_SEED, vault.as_ref(), owner.as_ref()],
        program_id,
    )
}

pub fn derive_credit_lock_pda(
    program_id: &Pubkey,
    deal: &Pubkey,
    owner: &Pubkey,
    deposit_type: DepositType,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            CREDIT_LOCK_SEED,
            deal.as_ref(),
            owner.as_ref(),
            &[deposit_type_seed(deposit_type)],
        ],
        program_id,
    )
}

fn deposit_type_seed(deposit_type: DepositType) -> u8 {
    match deposit_type {
        DepositType::BuyerPayment => 0,
        DepositType::BuyerCollateral => 1,
        DepositType::SellerCollateral => 2,
    }
}

fn approval_role_from_seed(role_seed: u8) -> Result<ApprovalRole> {
    match role_seed {
        0 => Ok(ApprovalRole::Buyer),
        1 => Ok(ApprovalRole::Seller),
        _ => err!(ConfidentialEscrowError::InvalidApprovalRole),
    }
}

fn role_for_approver(deal: &ConfidentialDeal, approver: Pubkey) -> Result<ApprovalRole> {
    let approver_commitment = participant_commitment(&approver);
    if approver_commitment == deal.buyer_identity_commitment {
        Ok(ApprovalRole::Buyer)
    } else if approver_commitment == deal.seller_identity_commitment {
        Ok(ApprovalRole::Seller)
    } else {
        err!(ConfidentialEscrowError::Unauthorized)
    }
}

fn participant_commitment(pubkey: &Pubkey) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"air_otc_participant_identity_v1:");
    hasher.update(pubkey.as_ref());
    hasher.finalize().into()
}

fn funding_role_label(deposit_type: DepositType) -> &'static str {
    match deposit_type {
        DepositType::BuyerPayment => "buyer_payment",
        DepositType::BuyerCollateral => "buyer_collateral",
        DepositType::SellerCollateral => "seller_collateral",
    }
}

fn validate_vault_reserve(vault: &CreditVault, vault_lamports: u64) -> Result<()> {
    let rent = Rent::get()?;
    let reserve_floor = rent.minimum_balance(8 + CreditVault::INIT_SPACE);
    let liabilities = vault
        .total_issued_credit
        .checked_add(vault.pending_withdrawal_lamports)
        .ok_or(ConfidentialEscrowError::AmountOverflow)?;
    require!(
        vault_lamports >= reserve_floor.saturating_add(liabilities),
        ConfidentialEscrowError::CreditReserveInvariantFailed
    );
    Ok(())
}

fn validate_lock_for_deal(
    lock: &Account<CreditLock>,
    deal: &Account<ConfidentialDeal>,
    deposit_type: DepositType,
) -> Result<()> {
    require_keys_eq!(lock.deal, deal.key(), ConfidentialEscrowError::InvalidFundingCommitment);
    require!(lock.deposit_type == deposit_type, ConfidentialEscrowError::InvalidDepositType);
    require!(!lock.settled, ConfidentialEscrowError::ReleaseAlreadyExecuted);
    require!(!lock.refunded, ConfidentialEscrowError::WithdrawalAlreadyExecuted);
    Ok(())
}

fn release_locked_credit_to_balance(
    balance: &mut Account<CreditBalance>,
    amount_lamports: u64,
) -> Result<()> {
    balance.locked_lamports = balance
        .locked_lamports
        .checked_sub(amount_lamports)
        .ok_or(ConfidentialEscrowError::AmountOverflow)?;
    balance.available_lamports = balance
        .available_lamports
        .checked_add(amount_lamports)
        .ok_or(ConfidentialEscrowError::AmountOverflow)?;
    Ok(())
}

fn transfer_locked_credit_between_balances(
    source: &mut Account<CreditBalance>,
    destination: &mut Account<CreditBalance>,
    amount_lamports: u64,
) -> Result<()> {
    source.locked_lamports = source
        .locked_lamports
        .checked_sub(amount_lamports)
        .ok_or(ConfidentialEscrowError::AmountOverflow)?;
    destination.available_lamports = destination
        .available_lamports
        .checked_add(amount_lamports)
        .ok_or(ConfidentialEscrowError::AmountOverflow)?;
    Ok(())
}

fn mark_credit_lock_settled(lock: &mut Account<CreditLock>) -> Result<()> {
    require!(!lock.settled, ConfidentialEscrowError::ReleaseAlreadyExecuted);
    lock.settled = true;
    Ok(())
}

fn compute_private_funding_hash(
    deal: &ConfidentialDeal,
    deposit_type: DepositType,
    amount_lamports: u64,
) -> Result<[u8; 32]> {
    require!(deal.private_funding_registered, ConfidentialEscrowError::InvalidFundingCommitment);
    require!(deal.session_pda != Pubkey::default(), ConfidentialEscrowError::InvalidFundingCommitment);

    let normalized = format!(
        "{{\"amountLamports\":\"{}\",\"role\":\"{}\",\"sessionPda\":\"{}\",\"termsHash\":\"{}\",\"version\":1}}",
        amount_lamports,
        funding_role_label(deposit_type),
        deal.session_pda,
        hex::encode(deal.terms_hash),
    );
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    Ok(hasher.finalize().into())
}

fn compute_settlement_plan_hash(
    deal: &ConfidentialDeal,
    buyer_settlement_target: Pubkey,
    seller_settlement_target: Pubkey,
) -> Result<[u8; 32]> {
    let normalized = format!(
        "{{\"buyerSettlementTarget\":\"{}\",\"policy\":\"{}\",\"sellerSettlementTarget\":\"{}\"}}",
        buyer_settlement_target,
        match deal.settlement_policy {
            ReleaseSettlementPolicy::Direct => "DIRECT",
            ReleaseSettlementPolicy::Stealth => "STEALTH",
        },
        seller_settlement_target,
    );
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    Ok(hasher.finalize().into())
}

fn validate_release_payload(deal: &ConfidentialDeal, payload: &ReleaseApprovalPayload) -> Result<()> {
    require!(payload.version == 1, ConfidentialEscrowError::InvalidApprovalSignature);
    require!(payload.route == ReleaseRoute::ConfidentialEscrow, ConfidentialEscrowError::InvalidApprovalSignature);
    require!(payload.deal_pda == Pubkey::find_program_address(&[b"confidential_deal", deal.deal_id.as_ref()], &crate::ID).0,
        ConfidentialEscrowError::InvalidApprovalSignature);
    require!(payload.session_pda == deal.session_pda, ConfidentialEscrowError::InvalidApprovalSignature);
    require!(payload.terms_hash == deal.terms_hash, ConfidentialEscrowError::InvalidApprovalSignature);
    require!(payload.plan_hash == deal.plan_hash, ConfidentialEscrowError::InvalidApprovalSignature);
    Ok(())
}

fn validate_settlement_plan_approval_account(
    deal: &ConfidentialDeal,
    approval: &Account<ReleaseApproval>,
    role: ApprovalRole,
    now: i64,
) -> Result<()> {
    require!(approval.deal == Pubkey::find_program_address(&[b"confidential_deal", deal.deal_id.as_ref()], &crate::ID).0,
        ConfidentialEscrowError::InvalidReleaseApprovalAccount);
    require!(approval.role == role, ConfidentialEscrowError::InvalidApprovalRole);
    require!(approval.active, ConfidentialEscrowError::InvalidReleaseApprovalAccount);
    require!(approval.terms_hash == deal.terms_hash, ConfidentialEscrowError::InvalidReleaseApprovalAccount);
    require!(approval.plan_hash == deal.plan_hash, ConfidentialEscrowError::InvalidReleaseApprovalAccount);
    require!(
        approval.approval_kind == ReleaseApprovalAction::ApproveSettlement
            || (role == ApprovalRole::Buyer
                && approval.approval_kind == ReleaseApprovalAction::ConfirmRelease),
        ConfidentialEscrowError::InvalidReleaseApprovalAccount
    );
    require!(approval.expires_at > now, ConfidentialEscrowError::ApprovalExpired);
    Ok(())
}

fn verify_release_approval_signature(
    instructions_sysvar: &AccountInfo,
    expected_approver: &Pubkey,
    payload: &ReleaseApprovalPayload,
) -> Result<()> {
    let current_ix_index = load_current_index_checked(instructions_sysvar)? as usize;
    require!(current_ix_index > 0, ConfidentialEscrowError::InvalidApprovalSignature);
    let verification_ix: Instruction =
        load_instruction_at_checked(current_ix_index - 1, instructions_sysvar)?;
    require!(
        verification_ix.program_id
            == Pubkey::from_str(ED25519_PROGRAM_ID_STR)
                .map_err(|_| error!(ConfidentialEscrowError::InvalidProgramId))?,
        ConfidentialEscrowError::InvalidApprovalSignature
    );
    require!(
        verification_ix.data.len() >= ED25519_HEADER_LEN,
        ConfidentialEscrowError::InvalidApprovalSignature
    );
    require!(
        verification_ix.data[0] == 1,
        ConfidentialEscrowError::InvalidApprovalSignature
    );

    let signature_offset =
        u16::from_le_bytes(verification_ix.data[2..4].try_into().unwrap()) as usize;
    let public_key_offset =
        u16::from_le_bytes(verification_ix.data[6..8].try_into().unwrap()) as usize;
    let message_offset =
        u16::from_le_bytes(verification_ix.data[10..12].try_into().unwrap()) as usize;
    let message_size =
        u16::from_le_bytes(verification_ix.data[12..14].try_into().unwrap()) as usize;

    require!(
        verification_ix.data.len() >= signature_offset + 64
            && verification_ix.data.len() >= public_key_offset + 32
            && verification_ix.data.len() >= message_offset + message_size,
        ConfidentialEscrowError::InvalidApprovalSignature
    );

    let expected_message = payload
        .try_to_vec()
        .map_err(|_| error!(ConfidentialEscrowError::InvalidApprovalSignature))?;
    let message = &verification_ix.data[message_offset..message_offset + message_size];
    let public_key = &verification_ix.data[public_key_offset..public_key_offset + 32];

    require!(
        public_key == expected_approver.as_ref(),
        ConfidentialEscrowError::InvalidApprovalSignature
    );
    require!(
        message == expected_message.as_slice(),
        ConfidentialEscrowError::InvalidApprovalSignature
    );

    let mut hasher = Sha256::new();
    hasher.update(message);
    let _message_digest = hasher.finalize();

    Ok(())
}
