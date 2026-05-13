const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[ensure-pgvector] DATABASE_URL is required");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log("[ensure-pgvector] pgvector extension ready");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[ensure-pgvector] failed", error?.message || error);
  process.exit(1);
});
