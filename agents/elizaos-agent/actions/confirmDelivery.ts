/**
 * ACTION: CONFIRM_DELIVERY
 *
 * Seller delivers credentials via E2E encrypted message.
 * Validates: role === 'seller' AND phase === 'delivery'
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const confirmDelivery: Action = {
    name: 'CONFIRM_DELIVERY',
    similes: ['DELIVER', 'SEND_CREDENTIAL', 'DELIVER_ACCESS', 'SHIP_GOODS'],
    description: 'Deliver credentials or access token to buyer via secure message',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const role = meridianSDK.getRole();
        return role === 'seller' && dealTracker.canDeliver();
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
                return 'Error: No ticket. Complete negotiation first.';
            }

            // Get credential from environment or use default
            const credential =
                process.env.DELIVERY_CONTENT || 'ACCESS_TOKEN_DELIVERED_BY_ELIZAOS_AGENT';

            console.log(
                `[ACTION:CONFIRM_DELIVERY] Delivering credential via secure message: ${credential}`
            );

            const deliveryMessage = `Delivery: ${credential}`;
            await client.sendMessage(deal.ticketId, deliveryMessage);

            console.log('[ACTION:CONFIRM_DELIVERY] Credential sent');

            return `Credentials delivered securely to buyer: ${credential}`;
        } catch (error: any) {
            console.error('[ACTION:CONFIRM_DELIVERY] Error:', error.message);
            return `Error delivering credentials: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Collateral is confirmed. Deliver the goods.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: {
                    text: 'Sending delivery: ACCESS_TOKEN_DELIVERED_SECURELY',
                },
            },
        ],
    ],
};
