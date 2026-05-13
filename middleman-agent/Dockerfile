FROM node:20-slim

WORKDIR /app

# Install openssl for Prisma, and build tools for native node modules (usb/node-gyp/node-hid)
RUN apt-get update && apt-get install -y openssl python3 make g++ libusb-1.0-0-dev libudev-dev pkg-config && rm -rf /var/lib/apt/lists/*

# Hide Prisma Update Warnings in Railway Logs
ENV PRISMA_HIDE_UPDATE_MESSAGE="true"

# Install dependencies. Umbra's prover package has a peer range that lags
# the SDK version used by the demo, so Railway builds must preserve the
# working lockfile with legacy peer resolution.
COPY package*.json ./
RUN npm ci --include=dev --legacy-peer-deps

# Copy source
COPY . .

# Generate Prisma client (needs a dummy DATABASE_URL at build time)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

EXPOSE 8080 3001

# Start with required database extensions, then sync schema and start TS Node.
CMD ["sh", "-c", "node scripts/ensurePgVector.cjs && npx prisma db push --accept-data-loss && npx ts-node src/index.ts"]
