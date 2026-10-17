'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
test('withTransaction preserves the work error and releases once when rollback fails', async () => {
  const originalError = new Error('database operation failed');
  let rollbackCount = 0;
  let releaseCount = 0;
  const withTransaction = require('./withTransaction');
  const pool = {
    connect: async () => ({
      query: async sql => {
        if (sql === 'ROLLBACK') {
          rollbackCount += 1;
          throw new Error('rollback failed');
        }
        if (sql === 'FAIL') throw originalError;
        return { rows: [] };
      },
      release: () => {
        releaseCount += 1;
      },
    }),
  };

  await assert.rejects(withTransaction(client => client.query('FAIL'), pool), error => {
    assert.equal(error, originalError);
    return true;
  });
  assert.equal(rollbackCount, 1);
  assert.equal(releaseCount, 1);
});