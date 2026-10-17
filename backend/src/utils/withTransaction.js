'use strict';

async function withTransaction(fn, pool) {
  const connectionPool = pool || require('../config/database');
  const client = await connectionPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = withTransaction;