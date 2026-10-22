const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectDeadLetters, replayDeadLetter } = require('./deadLetterTools');
test('inspection is bounded and omits payloads and secrets', async () => {
  await assert.rejects(inspectDeadLetters({}, 201));
  const rows = await inspectDeadLetters({
    query: async (sql, values) => {
      assert.ok(!sql.includes('payload'));
      assert.deepEqual(values, [50]);
      return { rows: [{ id: 'dl' }] };
    },
  });
  assert.equal(rows[0].id, 'dl');
});
test('replay creates a fresh bounded delivery and commits its audit reference', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.startsWith('SELECT'))
        return { rows: [{ delivery_kind: 'user', delivery_id: 'old' }] };
      if (sql.startsWith('INSERT')) return { rows: [{ id: 'new' }] };
      return { rows: [] };
    },
  };
  assert.equal((await replayDeadLetter(client, 'dl')).id, 'new');
  assert.equal(calls.at(-1)[0], 'COMMIT');
  assert.ok(calls.some(([sql]) => sql.includes("d.status = 'failed'")));
});
test('already replayed dead letters roll back without enqueueing', async () => {
  const calls = [];
  const client = {
    query: async sql => {
      calls.push(sql);
      return { rows: [{ resolved_at: 'now' }] };
    },
  };
  await assert.rejects(replayDeadLetter(client, 'dl'), /already replayed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.some(sql => sql.startsWith('INSERT')));
});
