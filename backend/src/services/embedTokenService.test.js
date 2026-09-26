'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('embedTokenService creates, lists, revokes, and validates tokens', async () => {
  let insertedRow = null;
  let updatedRow = null;
  let queryCalled = false;

  const dbMock = {
    query: async (sql, params) => {
      queryCalled = true;
      if (sql.includes('INSERT INTO embed_tokens')) {
        insertedRow = {
          id: 'token-id-1',
          user_id: params[0],
          label: params[1],
          token_hash: params[2],
          token_prefix: params[3],
          default_topic: params[4],
          default_asset: params[5],
          last_used_at: null,
          created_at: new Date(),
          revoked_at: null,
        };
        return { rows: [insertedRow] };
      }
      if (sql.includes('SELECT * FROM embed_tokens WHERE user_id')) {
        return { rows: [insertedRow] };
      }
      if (sql.includes('UPDATE embed_tokens SET revoked_at')) {
        insertedRow.revoked_at = new Date();
        return { rows: [{ id: insertedRow.id }] };
      }
      if (sql.includes('SELECT * FROM embed_tokens WHERE token_prefix')) {
        if (insertedRow.revoked_at) {
          return { rows: [] };
        }
        return { rows: [insertedRow] };
      }
      if (sql.includes('UPDATE embed_tokens SET last_used_at')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const embedTokenService = proxyquire('./embedTokenService', {
    '../config/database': dbMock,
  });

  const created = await embedTokenService.createEmbedToken('user-1', { label: 'Test Widget' });
  assert.equal(created.id, 'token-id-1');
  assert.ok(created.token.startsWith('cped_'));

  const tokens = await embedTokenService.listEmbedTokensForUser('user-1');
  assert.equal(tokens.length, 1);

  const validated = await embedTokenService.validateEmbedToken(created.token);
  assert.equal(validated.id, 'token-id-1');

  const revoked = await embedTokenService.revokeEmbedToken('user-1', 'token-id-1');
  assert.equal(revoked, true);

  const validatedRevoked = await embedTokenService.validateEmbedToken(created.token);
  assert.equal(validatedRevoked, null);
});
