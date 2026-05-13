/**
 * ACTION: OPEN_DISPUTE
 *
 * Open a dispute if something went wrong in the deal.
 * Can be called at any point in the lifecycle.
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const openDispute: Action = {
    name: 'OPEN_DISPUTE',
    similes: ['DISPUTE', 'RAISE_ISSUE', 'ESCALATE', 'REPORT_PROBLEM'],
    description: 'Open a dispute if the counterparty fails to deliver',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const deal = dealTracker.get();
        // Only in delivery or collateral_sent phases, and not yet completed
        return (
            !dealTracker.isComplete() &&
            (deal.phase === 'delivery' ||
                deal.phase === 'collateral_sent' ||
                deal.phase === 'awaiting_deposits')
        );
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
                return 'Error: No ticket. Cannot open dispute.';
            }

            // Determine reason from context
            let reason = 'Counterparty failed to complete their obligations.';
            if (deal.phase === 'delivery') {
                reason = 'Seller did not deliver credentials within timeout.';
            }

            console.log(`[ACTION:OPEN_DISPUTE] Opening dispute: ${reason}`);

            await client.openDispute(deal.ticketId, reason);

            dealTracker.update({
                phase: 'disputed',
            });

            return `Dispute opened: "${reason}" Waiting for AI Judge resolution.`;
        } catch (error: any) {
            console.error('[ACTION:OPEN_DISPUTE] Error:', error.message);
            return `Error opening dispute: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Seller did not deliver. Open a dispute.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: {
                    text: 'Opening dispute: Seller failed to deliver within timeout.',
                },
            },
        ],
    ],
};
