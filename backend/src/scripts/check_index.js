require('dotenv').config();
const db = require('../config/database');

async function run() {
  const result = await db.query(`
    EXPLAIN ANALYZE 
    SELECT c.* 
    FROM campaigns c 
    WHERE c.search_vector @@ websearch_to_tsquery('english', 'stellar')
  `);
  
  console.log('--- EXPLAIN ANALYZE ---');
  result.rows.forEach(r => console.log(r['QUERY PLAN']));
  
  db.end();
}

run().catch(console.error);
