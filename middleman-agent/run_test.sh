#!/bin/bash
rm -f agents/latest_ticket.txt
npx ts-node agents/buyerE2E.ts > e2e_buyer.log 2>&1 &
BUYER_PID=$!
sleep 2
npx ts-node agents/sellerE2E.ts > e2e_seller.log 2>&1 &
SELLER_PID=$!
sleep 45
kill -9 $BUYER_PID $SELLER_PID 2>/dev/null || true
