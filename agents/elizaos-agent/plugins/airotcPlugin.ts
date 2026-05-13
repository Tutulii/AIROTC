import type { Plugin } from "@elizaos/core";
import { airotcProvider } from "../providers/airotcProvider.js";

export const airotcPlugin: Plugin = {
    name: "air-otc",
    description: "AIR OTC external trading context plugin for ElizaOS buyer/seller agents.",
    providers: [airotcProvider],
};
