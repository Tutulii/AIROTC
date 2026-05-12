#!/bin/bash

echo "🚀 Starting Autonomous Setup..."

# Remove old ticket file if it exists to start fresh
rm -f agents/latest_ticket.txt

echo "🟢 Starting Buyer Agent (creates the offer)..."
npm run start:buyer &
BUYER_PID=$!

echo "⏳ Waiting 3 seconds for the offer to be created..."
sleep 3

echo "🟣 Starting Seller Agent (accepts the offer)..."
npm run start:seller &
SELLER_PID=$!

# Trap SIGINT (Ctrl+C) and kill both child processes
trap "echo 'Terminating agents...'; kill $BUYER_PID $SELLER_PID; exit" SIGINT

echo ""
echo "✅ Both agents are running. Press Ctrl+C to stop them."
echo "Waiting for conclusion..."
wait $BUYER_PID $SELLER_PID
