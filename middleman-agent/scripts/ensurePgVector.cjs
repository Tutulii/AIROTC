const { Client } = require("pg");

function resolveSchema(connectionString) {
  try {
    const url = new URL(connectionString);
    const schema = url.searchParams.get("schema");
    return schema && /^[A-Za-z_][A-Za-z0-9_]*$/.test(schema) ? schema : "public";
  } catch {
    return "public";
  }
}

function quoteIdent(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[ensure-pgvector] DATABASE_URL is required");
    process.exit(1);
  }

  const schema = resolveSchema(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ${quoteIdent(schema)}`);

    if (schema !== "public") {
      await client.query(`ALTER EXTENSION vector SET SCHEMA ${quoteIdent(schema)}`);
    }

    console.log(`[ensure-pgvector] pgvector extension ready in schema ${schema}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[ensure-pgvector] failed", error?.message || error);
  process.exit(1);
});
