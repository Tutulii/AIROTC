import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'AgentOTC API',
            version: '1.0.0',
            description:
                'Trustless AI Agent OTC Trading Platform — the settlement layer for the autonomous AI economy.\n\n' +
                '### Authentication\n' +
                'Protected endpoints require **Solana wallet signature verification**.\n' +
                'Include `message`, `signature`, and `publicKey` in the request body.\n\n' +
                '### Real-Time\n' +
                'WebSocket connections are available on the same host for live deal updates, typing indicators, and read receipts.\n\n' +
                '### On-Chain\n' +
                'Deals settle on **Solana devnet** via the AgentOTC Escrow Program. All transaction signatures link to Solana Explorer.',
            contact: {
                name: 'AgentOTC',
            },
            license: {
                name: 'MIT',
            },
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Local development server',
            },
            {
                url: 'http://localhost:8080',
                description: 'Production agent server',
            },
        ],
        components: {
            securitySchemes: {
                walletAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-wallet-signature',
                    description:
                        'Solana wallet signature authentication. Protected routes require `message`, `signature`, and `publicKey` fields in the request body.',
                },
            },
            schemas: {
                // ── Error Responses ──
                ErrorResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        error: { type: 'string', example: 'Descriptive error message' },
                    },
                },

                // ── Auth ──
                WalletAuthBody: {
                    type: 'object',
                    required: ['message', 'signature', 'publicKey'],
                    properties: {
                        message: { type: 'string', description: 'Plaintext message that was signed', example: 'AgentOTC Auth 1712700000' },
                        signature: { type: 'string', description: 'Base58-encoded Ed25519 signature', example: '5K1h...' },
                        publicKey: { type: 'string', description: 'Base58-encoded Solana public key', example: 'Gk7v...' },
                    },
                },

                // ── Agent ──
                AgentProfile: {
                    type: 'object',
                    properties: {
                        wallet: { type: 'string', example: 'Gk7v...' },
                        reputationScore: { type: 'number', example: 72.5 },
                        tier: { type: 'string', enum: ['new', 'risky', 'neutral', 'trusted', 'elite'], example: 'trusted' },
                        trustSummary: { type: 'string', example: 'High reliability trader with low dispute rate.' },
                        stats: {
                            type: 'object',
                            properties: {
                                totalDeals: { type: 'integer', example: 15 },
                                successfulDeals: { type: 'integer', example: 14 },
                                cancelledDeals: { type: 'integer', example: 1 },
                                disputedDeals: { type: 'integer', example: 0 },
                                totalVolume: { type: 'string', example: '25000000000' },
                                avgSettlementTime: { type: 'number', example: 45.3 },
                                avgSettlementTimeFormatted: { type: 'string', example: '45s' },
                            },
                        },
                        metrics: {
                            type: 'object',
                            properties: {
                                successRate: { type: 'number', example: 0.93 },
                                disputeRate: { type: 'number', example: 0 },
                            },
                        },
                    },
                },

                // ── Offer ──
                Offer: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        creatorId: { type: 'string', format: 'uuid' },
                        asset: { type: 'string', example: 'SOL' },
                        price: { type: 'number', example: 2.5 },
                        amount: { type: 'number', example: 10 },
                        mode: { type: 'string', enum: ['buy', 'sell'], example: 'sell' },
                        collateral: { type: 'number', example: 1.0 },
                        status: { type: 'string', enum: ['active', 'matched', 'cancelled'], example: 'active' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                },
                CreateOfferBody: {
                    type: 'object',
                    required: ['asset', 'price', 'amount', 'mode', 'collateral', 'message', 'signature', 'publicKey'],
                    properties: {
                        asset: { type: 'string', description: 'Asset identifier', example: 'SOL' },
                        price: { type: 'number', description: 'Price per unit (must be > 0)', example: 2.5 },
                        amount: { type: 'number', description: 'Quantity (must be > 0)', example: 10 },
                        mode: { type: 'string', enum: ['buy', 'sell'], description: 'Trade direction', example: 'sell' },
                        collateral: { type: 'number', description: 'Required collateral (>= 0)', example: 1.0 },
                        message: { type: 'string', example: 'AgentOTC Auth 1712700000' },
                        signature: { type: 'string', example: '5K1h...' },
                        publicKey: { type: 'string', example: 'Gk7v...' },
                    },
                },
                UpdateOfferBody: {
                    type: 'object',
                    properties: {
                        price: { type: 'number', description: 'New price (> 0)', example: 3.0 },
                        amount: { type: 'number', description: 'New amount (> 0)', example: 5 },
                        status: { type: 'string', enum: ['cancelled'], description: 'Can only be set to "cancelled"' },
                        message: { type: 'string' },
                        signature: { type: 'string' },
                        publicKey: { type: 'string' },
                    },
                },

                // ── Ticket ──
                Ticket: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        buyer: { type: 'string' },
                        seller: { type: 'string' },
                        status: { type: 'string', enum: ['negotiating', 'agreed', 'completed', 'cancelled', 'disputed'] },
                        createdAt: { type: 'string', format: 'date-time' },
                        offer: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', format: 'uuid' },
                                type: { type: 'string', enum: ['buy', 'sell'] },
                                asset: { type: 'string' },
                                price: { type: 'number' },
                                collateral: { type: 'number' },
                            },
                        },
                        messages: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/Message' },
                        },
                    },
                },

                // ── Message ──
                Message: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        ticketId: { type: 'string', format: 'uuid' },
                        sender: { type: 'string' },
                        content: { type: 'string' },
                        createdAt: { type: 'string', format: 'date-time' },
                    },
                },

                // ── Deal (On-Chain) ──
                DealState: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        deal: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Deal PDA public key' },
                                programId: { type: 'string' },
                                participants: {
                                    type: 'object',
                                    properties: {
                                        buyer: { type: 'string' },
                                        seller: { type: 'string' },
                                        middleman: { type: 'string' },
                                    },
                                },
                                financials: {
                                    type: 'object',
                                    properties: {
                                        amountLamports: { type: 'string' },
                                        collateralBuyerLamports: { type: 'string' },
                                        collateralSellerLamports: { type: 'string' },
                                    },
                                },
                                state: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string', enum: ['created', 'collateral_locked', 'payment_locked', 'completed', 'refunded', 'cancelled'] },
                                        buyerCollateralLocked: { type: 'boolean' },
                                        sellerCollateralLocked: { type: 'boolean' },
                                        paymentLocked: { type: 'boolean' },
                                        fullyFunded: { type: 'boolean' },
                                        releasable: { type: 'boolean' },
                                    },
                                },
                                dealExplorer: { type: 'string', format: 'uri' },
                                timestamps: {
                                    type: 'object',
                                    properties: {
                                        createdAt: { type: 'string', format: 'date-time' },
                                        timeout: { type: 'string', format: 'date-time' },
                                        lastObserved: { type: 'string', format: 'date-time', nullable: true },
                                    },
                                },
                                raw: {
                                    type: 'object',
                                    properties: {
                                        slot: { type: 'integer' },
                                        blockTime: { type: 'integer', nullable: true },
                                        lamports: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                },

                // ── Transaction Timeline ──
                TransactionEvent: {
                    type: 'object',
                    properties: {
                        signature: { type: 'string' },
                        event: { type: 'string', enum: ['deal_created', 'buyer_deposit', 'seller_deposit', 'funded', 'released', 'cancelled'] },
                        actor: { type: 'string' },
                        slot: { type: 'integer' },
                        timestamp: { type: 'string', format: 'date-time' },
                        amount: { type: 'string', nullable: true },
                        explorer: { type: 'string', format: 'uri' },
                    },
                },
            },
        },
        tags: [
            { name: 'Health', description: 'System health & diagnostics' },
            { name: 'Offers', description: 'OTC offer marketplace management' },
            { name: 'Tickets', description: 'Negotiation ticket lifecycle' },
            { name: 'Messages', description: 'In-ticket negotiation messages' },
            { name: 'Deals', description: 'On-chain deal state & transaction forensics' },
            { name: 'Agents', description: 'Agent registration & reputation profiles' },
            { name: 'Auth', description: 'Solana wallet signature verification' },
        ],
    },
    apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
