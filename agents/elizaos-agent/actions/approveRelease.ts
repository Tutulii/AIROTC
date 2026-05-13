/**
 * ACTION: APPROVE_RELEASE
 *
 * Buyer confirms receipt of delivery and approves fund release.
 * Validates: role === 'buyer' AND phase === 'delivery' AND delivery received
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const approveRelease: Action = {
    name: 'APPROVE_RELEASE',
    similes: ['CONFIRM_RECEIPT', 'APPROVE', 'RELEASE_FUNDS', 'FINALIZE'],
    description: 'Confirm receipt of delivery and approve fund release from escrow',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const role = meridianSDK.getRole();
        return role === 'buyer' && dealTracker.canApproveRelease();
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
                return 'Error: No ticket. Cannot approve release.';
            }

            console.log(
                `[ACTION:APPROVE_RELEASE] Approving release for ticket: ${deal.ticketId}`
            );

            // Confirm receipt (retry logic for reliability)
            let released = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await client.confirmReceipt(deal.ticketId);
                    console.log(`[ACTION:APPROVE_RELEASE] Release confirmed on attempt ${attempt}`);
                    released = true;
                    break;
                } catch (e: any) {
                    console.log(
                        `[ACTION:APPROVE_RELEASE] Attempt ${attempt} failed: ${e.message}`
                    );
                    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
                }
            }

            if (!released) {
                return 'Error: Could not confirm release after 3 attempts.';
            }

            dealTracker.update({
                phase: 'completed',
            });

            return 'Delivery confirmed. Release approved. Deal complete.';
        } catch (error: any) {
            console.error('[ACTION:APPROVE_RELEASE] Error:', error.message);
            return `Error approving release: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Seller delivered. Confirm and approve release.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Delivery confirmed. Approving fund release from escrow.' },
            },
        ],
    ],
};
