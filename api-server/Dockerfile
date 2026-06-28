FROM node:20-alpine

WORKDIR /app

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Install dependencies. Keep this locked for repeatable Railway builds.
COPY package*.json ./
RUN npm ci --include=dev

# Copy source
COPY . .

# Generate Prisma client (needs a dummy DATABASE_URL at build time)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Hide Prisma Update Warnings in Railway Logs
ENV PRISMA_HIDE_UPDATE_MESSAGE="true"

EXPOSE 3000

# Apply committed migrations first. Fall back to a non-destructive schema sync
# for legacy Railway databases that were originally bootstrapped with db push.
CMD ["sh", "-c", "(npx prisma migrate deploy || npx prisma db push) && npx ts-node src/server.ts"]
