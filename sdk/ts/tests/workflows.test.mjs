import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentOTCWorkflows } from '../dist/index.js';

function createPerDealStub() {
  return {
    async waitForRollupSessionReady() {},
    async completePrivateAgreement() {},
    async autoFundPrivateDeal() {},
    async waitForEncryptedDelivery() {
      return { id: 'dm_123', content: 'encrypted' };
    },
    async confirmPrivateDelivery() {},
    async waitForPhase() {},
    async sendEncryptedDelivery() {
      return { id: 'dm_456', content: 'encrypted' };
    },
    on() {},
  };
}

test('quickBuyPer installs a safe default settlement auto-approval policy', async () => {
  const policies = [];
  const deal = createPerDealStub();
  const client = {
    async register() {},
    async connect() {},
    async publishEncryptionKey() {},
    setAutoApprovalPolicy(policy) {
      policies.push(policy);
    },
    offers: {
      async get() {
        return {
          id: 'offer_1',
          asset: 'SOL',
          price: 0.1,
          collateral: 0.02,
        };
      },
      async accept() {
        return deal;
      },
    },
  };

  const workflows = new AgentOTCWorkflows(client);
  const result = await workflows.quickBuyPer({
    offerId: 'offer_1',
    terms: {
      assetMint: 'So11111111111111111111111111111111111111112',
      assetSymbol: 'SOL',
      priceSol: 0.1,
      buyerCollateralSol: 0.02,
      sellerCollateralSol: 0.02,
      quantity: 1,
    },
  });

  assert.equal(result.success, true);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0], {
    allowedAssets: ['SOL'],
    maxPrice: 0.1,
    maxCollateral: 0.02,
    requireStealthSettlement: true,
  });
});

test('quickSellPer installs a safe default settlement auto-approval policy', async () => {
  const policies = [];
  const deal = createPerDealStub();
  const client = {
    async register() {},
    async connect() {},
    async publishEncryptionKey() {},
    setAutoApprovalPolicy(policy) {
      policies.push(policy);
    },
    offers: {
      async create() {
        return { id: 'offer_2' };
      },
    },
    async waitForMatchedDeal() {
      return deal;
    },
  };

  const workflows = new AgentOTCWorkflows(client);
  const result = await workflows.quickSellPer({
    offer: {
      asset: 'SOL',
      mode: 'sell',
      amount: 1,
      price: 0.1,
      collateral: 0.02,
      rollupMode: 'PER',
    },
    terms: {
      assetMint: 'So11111111111111111111111111111111111111112',
      assetSymbol: 'SOL',
      priceSol: 0.1,
      buyerCollateralSol: 0.02,
      sellerCollateralSol: 0.02,
      quantity: 1,
    },
    deliveryContent: 'ACCESS_TOKEN=123',
  });

  assert.equal(result.success, true);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0], {
    allowedAssets: ['SOL'],
    maxPrice: 0.1,
    maxCollateral: 0.02,
    requireStealthSettlement: true,
  });
});

test('quickBuyPer respects autoApprovalPolicy=false', async () => {
  const policies = [];
  const deal = createPerDealStub();
  const client = {
    async register() {},
    async connect() {},
    setAutoApprovalPolicy(policy) {
      policies.push(policy);
    },
    offers: {
      async get() {
        return {
          id: 'offer_3',
          asset: 'SOL',
          price: 0.1,
          collateral: 0.02,
        };
      },
      async accept() {
        return deal;
      },
    },
  };

  const workflows = new AgentOTCWorkflows(client);
  const result = await workflows.quickBuyPer({
    offerId: 'offer_3',
    autoPublishEncryptionKey: false,
    autoApprovalPolicy: false,
    terms: {
      assetMint: 'So11111111111111111111111111111111111111112',
      assetSymbol: 'SOL',
      priceSol: 0.1,
      buyerCollateralSol: 0.02,
      sellerCollateralSol: 0.02,
      quantity: 1,
    },
  });

  assert.equal(result.success, true);
  assert.equal(policies.length, 0);
});
