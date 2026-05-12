#!/bin/bash
# ============================================================
#  AIR OTC — Full End-to-End Autonomous Trade Runner
#  Run from: middleman-agent/
#  Usage:    chmod +x run_e2e.sh && ./run_e2e.sh
# ============================================================

set -e
cd "$(dirname "$0")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   AIR OTC — Autonomous Trade Launcher     ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"

# Step 0: Kill any stale processes on our ports
echo -e "\n${YELLOW}[0/4] Cleaning stale processes...${NC}"
lsof -ti:3001,8080 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# Step 1: Start Middleman Server (background)
echo -e "${GREEN}[1/4] Starting Middleman Server...${NC}"
npx ts-node src/index.ts > server.log 2>&1 &
SERVER_PID=$!
echo "  PID: $SERVER_PID (logs → server.log)"

# Wait for server to be ready
echo -n "  Waiting for server"
for i in $(seq 1 30); do
    if lsof -ti:3001 >/dev/null 2>&1; then
        echo -e " ${GREEN}✓ Ready${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if ! lsof -ti:3001 >/dev/null 2>&1; then
    echo -e " ${RED}✗ Server failed to start. Check server.log${NC}"
    exit 1
fi

# Clean old ticket file
rm -f agents/latest_ticket.txt

# Step 2: Start Buyer Agent (background)
echo -e "${GREEN}[2/4] Starting Buyer Agent...${NC}"
npx ts-node agents/buyerAgent.ts > buyer.log 2>&1 &
BUYER_PID=$!
echo "  PID: $BUYER_PID (logs → buyer.log)"

# Give buyer time to connect + create offer + write ticket file
sleep 5

# Step 3: Start Seller Agent (background)
echo -e "${GREEN}[3/4] Starting Seller Agent...${NC}"
npx ts-node agents/sellerAgent.ts > seller.log 2>&1 &
SELLER_PID=$!
echo "  PID: $SELLER_PID (logs → seller.log)"

# Step 4: Monitor
echo -e "\n${CYAN}[4/4] Trade running! Monitoring logs...${NC}"
echo -e "${YELLOW}─────────────────────────────────────────${NC}"
echo -e "  Server log:  ${CYAN}tail -f server.log${NC}"
echo -e "  Buyer log:   ${CYAN}tail -f buyer.log${NC}"
echo -e "  Seller log:  ${CYAN}tail -f seller.log${NC}"
echo -e "${YELLOW}─────────────────────────────────────────${NC}"
echo -e "  Press ${RED}Ctrl+C${NC} to stop all agents"
echo ""

# Cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down agents...${NC}"
    kill $SERVER_PID $BUYER_PID $SELLER_PID 2>/dev/null || true
    echo -e "${GREEN}Done.${NC}"
}
trap cleanup EXIT INT TERM

# Tail all logs together
tail -f server.log buyer.log seller.log 2>/dev/null
