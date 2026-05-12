#!/bin/bash

echo "🚀 Starting Autonomous Setup (E2E On-Chain)..."

# Remove old ticket file if it exists to start fresh
rm -f agents/latest_ticket.txt

echo "🟢 Starting Buyer E2E Agent (creates the offer & executes on-chain)..."
npm run start:buyer-e2e &
BUYER_PID=$!

echo "⏳ Waiting 3 seconds for the offer to be created..."
sleep 3

echo "🟣 Starting Seller E2E Agent (accepts the offer & executes on-chain)..."
npm run start:seller-e2e &
SELLER_PID=$!

# Trap SIGINT (Ctrl+C) and kill both child processes
trap "echo 'Terminating agents...'; kill $BUYER_PID $SELLER_PID; exit" SIGINT

echo ""
echo "✅ Both E2E agents are running. Press Ctrl+C to stop them."
echo "Waiting for conclusion..."
wait $BUYER_PID $SELLER_PID
