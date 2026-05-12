#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  AIR OTC — External Agent Test Launcher
#
#  Starts two fully independent agents (AlphaBot + BetaBot)
#  that register, post offers, and trade on your platform.
#
#  Prerequisites:
#    • Middleman Agent running on port 8080
#    • PostgreSQL running
#    • Node.js + npm installed
#
#  Usage:  chmod +x launch.sh && ./launch.sh
# ══════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")"

# ── Colors ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   ${BOLD}AIR OTC — External Agent Test Harness${NC}${CYAN}             ║${NC}"
echo -e "${CYAN}║   Two real agents. Real wallets. Real trades.       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 0: Pre-flight checks ──
echo -e "${YELLOW}[0/5] Pre-flight checks...${NC}"

# Check if middleman is running
if ! curl -s http://localhost:8080/health > /dev/null 2>&1; then
    echo -e "${RED}  ✗ Middleman Agent not running on port 8080${NC}"
    echo -e "${YELLOW}  Start it first: cd middleman-agent && npx ts-node src/index.ts${NC}"
    echo ""
    echo -e "${YELLOW}  Or if it's on a different port, set MIDDLEMAN_URL:${NC}"
    echo -e "${CYAN}    MIDDLEMAN_URL=http://localhost:8080 MIDDLEMAN_WS=ws://localhost:8080 ./launch.sh${NC}"
    echo ""
    
    read -p "  Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}  ✓ Middleman Agent detected on port 8080${NC}"
fi

# ── Step 1: Install dependencies ──
echo -e "\n${YELLOW}[1/5] Installing dependencies...${NC}"
if [ ! -d "node_modules" ]; then
    npm install --silent 2>&1 | tail -1
    echo -e "${GREEN}  ✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}  ✓ Dependencies already installed${NC}"
fi

# ── Step 2: Clean previous run ──
echo -e "\n${YELLOW}[2/5] Cleaning previous run artifacts...${NC}"
rm -f latest_ticket.txt alpha.log beta.log
echo -e "${GREEN}  ✓ Clean${NC}"

# ── Step 3: Start AlphaBot (Seller) ──
echo -e "\n${MAGENTA}[3/5] 🟠 Starting AlphaBot (SELLER)...${NC}"
npx ts-node alphaBot.ts > alpha.log 2>&1 &
ALPHA_PID=$!
echo -e "  PID: ${ALPHA_PID} (logs → ${CYAN}alpha.log${NC})"

# Wait for AlphaBot to post its offer and write the ticket file
echo -n "  Waiting for offer"
for i in $(seq 1 30); do
    if [ -f "latest_ticket.txt" ]; then
        TICKET=$(cat latest_ticket.txt)
        echo -e " ${GREEN}✓ Offer posted: ${TICKET}${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if [ ! -f "latest_ticket.txt" ]; then
    echo -e " ${RED}✗ AlphaBot failed to post offer. Check alpha.log${NC}"
    kill $ALPHA_PID 2>/dev/null || true
    echo ""
    echo -e "${RED}Last 20 lines of alpha.log:${NC}"
    tail -20 alpha.log 2>/dev/null || echo "(empty)"
    exit 1
fi

# ── Step 4: Start BetaBot (Buyer) ──
echo -e "\n${CYAN}[4/5] 🔵 Starting BetaBot (BUYER)...${NC}"
npx ts-node betaBot.ts > beta.log 2>&1 &
BETA_PID=$!
echo -e "  PID: ${BETA_PID} (logs → ${CYAN}beta.log${NC})"

# ── Step 5: Monitor ──
echo -e "\n${GREEN}[5/5] 🚀 Both agents running! Monitoring trade...${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "  ${MAGENTA}AlphaBot (Seller):${NC}  tail -f alpha.log"
echo -e "  ${CYAN}BetaBot  (Buyer):${NC}   tail -f beta.log"
echo -e "  ${YELLOW}Combined:${NC}          tail -f alpha.log beta.log"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "  Press ${RED}Ctrl+C${NC} to stop both agents"
echo ""

# ── Cleanup handler ──
cleanup() {
    echo -e "\n${YELLOW}Shutting down agents...${NC}"
    kill $ALPHA_PID $BETA_PID 2>/dev/null || true
    wait $ALPHA_PID 2>/dev/null || true
    wait $BETA_PID 2>/dev/null || true
    echo -e "${GREEN}Done. Logs saved to alpha.log and beta.log${NC}"
}
trap cleanup EXIT INT TERM

# ── Tail both logs with labels ──
tail -f alpha.log beta.log 2>/dev/null
