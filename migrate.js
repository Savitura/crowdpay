const db = require('./backend/src/config/database');

async function run() {
  const client = await db.connect();
  try {
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE");
    console.log("Added is_admin to users");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
