require('dotenv').config();
const db = require('../src/config/database');
const { inspectDeadLetters, replayDeadLetter } = require('../src/services/deadLetterTools');
async function main() {
  const [command, value, confirmation] = process.argv.slice(2);
  if (command === 'list') return inspectDeadLetters(db, value ? Number(value) : 50);
  if (command !== 'replay' || !value || confirmation !== '--confirm') {
    throw new Error('Usage: node scripts/dead-letters.js list [limit] | replay <id> --confirm');
  }
  const client = await (db.pool || db).connect();
  try {
    return await replayDeadLetter(client, value);
  } finally {
    client.release();
  }
}
main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => (db.pool || db).end());
