/**
 * ACTION: NEGOTIATE_TERMS
 *
 * Both parties send a structured agreement message confirming price and collateral.
 * Validates: phase === 'negotiating'
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const negotiateTerms: Action = {
    name: 'NEGOTIATE_TERMS',
    similes: ['CONFIRM_TERMS', 'AGREE', 'SEND_AGREEMENT', 'CONFIRM_DEAL'],
    description: 'Send structured agreement confirming price and collateral',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const deal = dealTracker.get();
        return deal.phase === 'negotiating' && deal.ticketId !== null;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> => {
        try {
            const client = meridianSDK.getClient();
            const deal = dealTracker.get();

            if (!deal.ticketId) {
                return 'Error: No ticket. Accept offer first.';
            }

            const price = deal.price || 0.1;
            const collateral = deal.collateral || 0.02;
            const role = meridianSDK.getRole();

            console.log(
                `[ACTION:NEGOTIATE_TERMS] Sending agreement: price ${price}, collateral ${collateral}`
            );

            // Send agreement message to middleman
            const agreementMsg = `I confirm the deal. Price: ${price} SOL, collateral: ${collateral} SOL each.`;
            await client.sendMessage(deal.ticketId, agreementMsg);

            dealTracker.update({
                phase: 'confirmed',
            });

            // Wait for phase change event (up to 10 seconds)
            return await new Promise<string>((resolve) => {
                const timeout = setTimeout(() => {
                    resolve('Waiting for counterparty confirmation.');
                }, 10000);

                const onPhaseChanged = (update: any) => {
                    if (
                        update.ticketId === deal.ticketId &&
                        update.phase === 'escrow_created'
                    ) {
                        clearTimeout(timeout);
                        client.removeListener('phase_changed', onPhaseChanged);
                        dealTracker.update({ phase: 'escrow_created' });
                        resolve('Terms confirmed. Escrow created.');
                    }
                };

                client.on('phase_changed', onPhaseChanged);
            });
        } catch (error: any) {
            console.error('[ACTION:NEGOTIATE_TERMS] Error:', error.message);
            return `Error negotiating terms: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Both parties ready. Confirm the deal terms.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Sending agreement confirmation with price and collateral amounts.' },
            },
        ],
    ],
};
