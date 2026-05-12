/**
 * plugin-air-otc — ElizaOS Plugin for AIR OTC Trading
 * 
 * Full plugin with all 4 component types:
 *   - Actions: 7 trading actions
 *   - Providers: 2 context providers
 *   - Evaluators: 1 deal progress evaluator
 *   - Services: 1 persistent connection service
 * 
 * Follows real @elizaos/core Plugin interface exactly.
 * Both buyer and seller agents use this same plugin.
 */

import type { Plugin } from "../elizaos-core";
import { registerAction } from "./actions/register";
import { postOfferAction } from "./actions/postOffer";
import { acceptOfferAction } from "./actions/acceptOffer";
import { negotiateAction } from "./actions/negotiate";
import { depositAction } from "./actions/deposit";
import { deliverAction } from "./actions/deliver";
import { releaseAction } from "./actions/release";
import { walletProvider } from "./providers/walletProvider";
import { dealStatusProvider } from "./providers/dealStatusProvider";
import { dealProgressEvaluator } from "./evaluators/dealProgressEvaluator";
import { OtcConnectionService } from "./services/otcConnectionService";

export const airOtcPlugin: Plugin = {
  name: "plugin-air-otc",
  description: "AIR OTC autonomous trading plugin — full deal lifecycle with ER/PER dual-mode support.",

  actions: [
    registerAction,
    postOfferAction,
    acceptOfferAction,
    negotiateAction,
    depositAction,
    deliverAction,
    releaseAction,
  ],

  providers: [
    walletProvider,
    dealStatusProvider,
  ],

  evaluators: [
    dealProgressEvaluator,
  ],

  services: [
    OtcConnectionService as any,
  ],
};
