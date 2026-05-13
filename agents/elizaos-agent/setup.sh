#!/bin/bash
# Quick setup script for testing the AIROTC ElizaOS agent

set -e

echo "🔧 AIROTC ElizaOS Agent Setup"
echo "=============================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Run this from agents/elizaos-agent/"
    exit 1
fi

# Step 1: Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Step 2: Create .env from template
if [ ! -f ".env.local" ]; then
    echo ""
    echo "📝 Creating .env.local..."
    cp .env .env.local
    echo "⚠️  Please edit .env.local with your configuration:"
    echo "   - AGENT_PRIVATE_KEY (base64-encoded)"
    echo "   - AGENT_WALLET_ADDRESS"
    echo "   - GROQ_API_KEY"
    echo "   - AIROTC_API_URL"
    echo "   - AIROTC_WS_URL"
fi

# Step 3: Check if we have required env vars (minimal)
if [ -z "$GROQ_API_KEY" ] && ! grep -q "^GROQ_API_KEY=" .env.local; then
    echo "⚠️  Set GROQ_API_KEY in .env.local before running"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env.local with your keys and API URLs"
echo "2. Fund agent wallets: solana airdrop 2 [address] --url devnet"
echo "3. Start AIROTC backend: cd middleman-agent && npx ts-node src/index.ts"
echo "4. Run agent: npm run buyer   (or 'npm run seller')"
echo ""
echo "Commands:"
echo "  npm run buyer              # Run as buyer (ER mode)"
echo "  npm run seller             # Run as seller (ER mode)"
echo "  npm run buyer-private      # Run as buyer (PER mode)"
echo "  npm run seller-private     # Run as seller (PER mode)"
