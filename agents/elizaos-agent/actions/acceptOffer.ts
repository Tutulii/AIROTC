/**
 * ACTION: ACCEPT_OFFER
 *
 * Buyer accepts a matched offer, sending acceptance to seller.
 * Validates: role === 'buyer' AND phase === 'matched'
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const acceptOffer: Action = {
    name: 'ACCEPT_OFFER',
    similes: ['CLICK_OFFER', 'BUY_NOW', 'ACCEPT', 'PROCEED'],
    description: 'Accept a matched offer and initiate the deal',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const role = meridianSDK.getRole();
        return role === 'buyer' && dealTracker.canAcceptOffer();
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> => {
        try {
            const client = meridianSDK.getClient();
            const deal = dealTracker.get();

            if (!deal.offerId) {
                return 'Error: No offer selected. Browse offers first.';
            }

            console.log(`[ACTION:ACCEPT_OFFER] Accepting offer: ${deal.offerId}`);

            const result = await client.acceptOffer(deal.offerId);
            const ticketId = result as string;

            dealTracker.update({
                ticketId,
                phase: 'negotiating',
            });

            // Subscribe to ticket events
            client.subscribeToTicket(ticketId);

            console.log(`[ACTION:ACCEPT_OFFER] Ticket created: ${ticketId}`);

            return `Accepted offer. Ticket: ${ticketId}. Entering negotiation.`;
        } catch (error: any) {
            console.error('[ACTION:ACCEPT_OFFER] Error:', error.message);
            return `Error accepting offer: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'You found a good offer. Accept it.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Accepting offer. Initiating deal.' },
            },
        ],
    ],
};
