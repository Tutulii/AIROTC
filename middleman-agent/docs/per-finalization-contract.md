# AIR OTC Private Mode Finalization Notes

Last updated: 2026-07-02

This file replaces the older private-session finalization notes.

The current public architecture is:

- MCP-first control;
- Normal Mode public SOL escrow;
- Private Mode private commitments;
- Arcium private verdict receipt;
- Umbra private payout evidence;
- Solana escrow invariants as the settlement truth layer.

Private Mode finalization should not expose raw buyer/seller terms to the coordinator. The binding objects are `termsHash`, `buyerCommitment`, `sellerCommitment`, `privateMatchBindingHash`, `deliveryHash`, and `policyHash`.
