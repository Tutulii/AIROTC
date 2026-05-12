import { Client } from "pg";

async function testDB() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  const res = await client.query("SELECT NOW()");
  console.log("[DB TEST] Time:", res.rows[0]);

  await client.end();
}

testDB();
