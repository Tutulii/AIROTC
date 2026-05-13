/**
 * ACTION: BROWSE_OFFERS
 *
 * Buyer scans available offers and finds one that matches criteria.
 * Validates: role === 'buyer' AND dealTracker.isIdle()
 */

import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { meridianSDK } from '../services/meridianSDK';
import { dealTracker } from '../services/dealTracker';

export const browseOffers: Action = {
    name: 'BROWSE_OFFERS',
    similes: ['SCAN_OFFERS', 'SEARCH_DEALS', 'FIND_OFFER', 'LIST_OFFERS'],
    description: 'Scan available sell offers and find one matching price/collateral constraints',

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const role = meridianSDK.getRole();
        const isIdle = dealTracker.isIdle();
        return role === 'buyer' && isIdle;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> => {
        try {
            const client = meridianSDK.getClient();

            const maxPrice = parseFloat(process.env.MAX_PRICE || '0.5');
            const maxCollateral = parseFloat(process.env.MAX_COLLATERAL || '0.1');

            console.log(
                `[ACTION:BROWSE_OFFERS] Scanning offers. Max price: ${maxPrice}, max collateral: ${maxCollateral}`
            );

            const offers = (await client.getOffers()) as any[];

            if (!offers || offers.length === 0) {
                return 'No offers available. Waiting.';
            }

            // Filter offers: SOL only, price within budget, collateral acceptable
            const matchingOffers = offers.filter((offer: any) => {
                const isSOL = offer.asset === 'SOL' || offer.assetType === 'SOL';
                const priceOk = (offer.price || 0) <= maxPrice;
                const collateralOk = (offer.collateral || 0) <= maxCollateral;
                return isSOL && priceOk && collateralOk;
            });

            if (matchingOffers.length === 0) {
                console.log('[ACTION:BROWSE_OFFERS] No matching offers found');
                return `No offers match constraints. (Offers: ${offers.length}, Max price: ${maxPrice}, Max collateral: ${maxCollateral})`;
            }

            // Pick first matching offer
            const selectedOffer = matchingOffers[0];
            const offerId = selectedOffer.id || selectedOffer.offerId;
            const amount = selectedOffer.amount || 1;
            const price = selectedOffer.price || 0;
            const collateral = selectedOffer.collateral || 0;

            dealTracker.update({
                offerId,
                price,
                collateral,
                phase: 'matched',
            });

            console.log(`[ACTION:BROWSE_OFFERS] Selected offer: ${offerId}`);

            return `Found offer ${offerId}: ${amount} SOL @ ${price} SOL/unit (collateral: ${collateral}). Evaluating...`;
        } catch (error: any) {
            console.error('[ACTION:BROWSE_OFFERS] Error:', error.message);
            return `Error browsing offers: ${error.message}`;
        }
    },

    examples: [
        [
            {
                user: 'system',
                content: { text: 'Start as buyer. Scan for available offers.' },
            },
            {
                user: 'MERIDIAN_TRADER',
                content: { text: 'Scanning for SOL offers within budget...' },
            },
        ],
    ],
};
