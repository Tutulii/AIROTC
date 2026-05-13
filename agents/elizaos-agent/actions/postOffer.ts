/**
 * ACTION: POST_OFFER
 *
 * Seller posts a sell offer on AIROTC.
 * Validates: role === 'seller' AND dealTracker.isIdle()
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const postOffer: Action = {
    name: 'POST_OFFER',
    similes: ['SELL', 'CREATE_OFFER', 'LIST_FOR_SALE', 'POST_SELL'],
    description: 'Post a sell offer on AIROTC with specified price and collateral',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const role = meridianSDK.getRole();
        const isIdle = dealTracker.isIdle();
        return role === 'seller' && isIdle;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> => {
        try {
            const client = meridianSDK.getClient();

            const amount = parseFloat(process.env.OFFER_AMOUNT || '1');
            const price = parseFloat(process.env.OFFER_PRICE || '0.1');
            const collateral = parseFloat(process.env.OFFER_COLLATERAL || '0.02');

            console.log(
                `[ACTION:POST_OFFER] Creating sell offer: ${amount} SOL @ ${price} SOL/unit, collateral ${collateral}`
            );

            const result = await client.createOffer({
                asset: 'SOL',
                side: 'sell',
                amount,
                price,
                collateral,
            });

            dealTracker.update({
                offerId: result as string,
                phase: 'offer_posted',
                price,
                collateral,
            });

            return `Offer posted: ${result}. Waiting for buyer match.`;
        } catch (error: any) {
            console.error('[ACTION:POST_OFFER] Error:', error.message);
            return `Error posting offer: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Start as seller. Post your offer.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Posting sell offer: 1 SOL @ 0.1 SOL with 0.02 SOL collateral' },
            },
        ],
    ],
};
