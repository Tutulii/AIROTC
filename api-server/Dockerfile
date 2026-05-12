FROM node:20-alpine

WORKDIR /app

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Install dependencies
COPY package*.json ./
RUN npm ci --production=false

# Copy source
COPY . .

# Generate Prisma client (needs a dummy DATABASE_URL at build time)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Hide Prisma Update Warnings in Railway Logs
ENV PRISMA_HIDE_UPDATE_MESSAGE="true"

EXPOSE 3000

# Start with prisma db push to ensure schema is synced, then start app
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npx ts-node src/server.ts"]
