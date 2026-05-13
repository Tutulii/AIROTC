/**
 * ACTION: DEPOSIT_COLLATERAL
 *
 * Send collateral and (for buyer) payment to the escrow address.
 * Validates: phase === 'awaiting_deposits' AND escrowAddress is known
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const depositCollateral: Action = {
    name: 'DEPOSIT_COLLATERAL',
    similes: ['SEND_COLLATERAL', 'DEPOSIT', 'SEND_PAYMENT', 'FUND_ESCROW'],
    description: 'Send collateral (and payment for buyer) to escrow address',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return dealTracker.canDepositCollateral();
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> => {
        try {
            const client = meridianSDK.getClient();
            const deal = dealTracker.get();
            const role = meridianSDK.getRole();

            if (!deal.escrowAddress) {
                return 'Error: Escrow address not known. Wait for escrow creation.';
            }

            const collateral = deal.collateral || 0.02;

            console.log(
                `[ACTION:DEPOSIT_COLLATERAL] [${role}] Depositing ${collateral} SOL to escrow`
            );

            // Send collateral
            let results: string[] = [];

            const collateralTx = await client.sendDeposit(deal.escrowAddress, collateral);
            results.push(`Collateral: ${collateralTx}`);
            console.log(`[ACTION:DEPOSIT_COLLATERAL] Collateral tx: ${collateralTx}`);

            dealTracker.update({
                depositConfirmedSeller: role === 'seller',
                depositConfirmedBuyer: role !== 'seller',
            });

            // If buyer, also send payment
            if (role === 'buyer') {
                const price = deal.price || 0.1;
                const paymentTx = await client.sendDeposit(deal.escrowAddress, price);
                results.push(`Payment: ${paymentTx}`);
                console.log(`[ACTION:DEPOSIT_COLLATERAL] Payment tx: ${paymentTx}`);
            }

            // Confirm deposit
            if (deal.ticketId) {
                await client.confirmDeposit(deal.ticketId, role);
            }

            dealTracker.update({
                phase: 'collateral_sent',
            });

            return `${role === 'buyer' ? 'Collateral and payment' : 'Collateral'} deposited. ${results.join(' | ')}`;
        } catch (error: any) {
            console.error('[ACTION:DEPOSIT_COLLATERAL] Error:', error.message);
            return `Error depositing: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Escrow is ready. Send your collateral.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Sending collateral deposit to escrow address.' },
            },
        ],
    ],
};
