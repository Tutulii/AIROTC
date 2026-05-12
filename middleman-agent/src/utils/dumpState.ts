import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    while (true) {
        console.clear();
        console.log("==========================================");
        console.log("      🟢 LIVE OTC TICKET DASHBOARD        ");
        console.log("==========================================\n");

        const tickets = await prisma.ticket.findMany({
            orderBy: { createdAt: 'desc' },
            take: 3,
        });

        if (tickets.length === 0) {
            console.log("   (Waiting for new agents to connect...)");
        }

        for (const ticket of tickets) {
            console.log(`🎟️  Ticket ID: \x1b[36m${ticket.id}\x1b[0m`);

            // Format status dynamically
            let statusColor = '\x1b[33m'; // Yellow for active
            if (ticket.status === 'completed') statusColor = '\x1b[32m'; // Green
            if (ticket.status === 'disputed') statusColor = '\x1b[31m'; // Red
            console.log(`📡 Status:  ${statusColor}${ticket.status.toUpperCase()}\x1b[0m`);
            console.log(`⏱️  Created: ${ticket.createdAt.toLocaleString()}`);

            // Fetch Deal / PDA if created
            const deal = await prisma.deal.findFirst({
                where: { ticketId: ticket.id },
                orderBy: { createdAt: 'desc' }
            });

            if (deal && deal.dealIdOnChain) {
                console.log(`🔗 Escrow PDA: \x1b[34m${deal.dealIdOnChain}\x1b[0m`);
            }

            console.log(`------------------------------------------`);
            console.log(`💬 Negotiation Timeline:`);

            const messages = await prisma.negotiation.findMany({
                where: { ticketId: ticket.id },
                orderBy: { createdAt: 'asc' },
            });

            if (messages.length === 0) {
                console.log(`   (No messages yet)`);
            }

            for (const msg of messages) {
                const priceMatch = Number(msg.proposedPrice);
                const price = priceMatch ? `${priceMatch} SOL` : `none`;

                let speaker = msg.proposedBy;
                if (speaker === 'middleman') speaker = '\x1b[35m[MIDDLEMAN]\x1b[0m';
                else speaker = `\x1b[36m[${speaker.substring(0, 8)}...]\x1b[0m`;

                console.log(`   ${speaker} at ${msg.createdAt.toLocaleTimeString()}`);
                console.log(`       Price Proposed: ${price}`);
                console.log(`       Raw Text: "${msg.rawText}"`);
            }
            console.log(`\n`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
