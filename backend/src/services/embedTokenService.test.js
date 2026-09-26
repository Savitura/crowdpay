'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('embedTokenService generateRawEmbedToken & prefix', async () => {
  const dbMock = { query: async () => ({ rows: [] }) };
  const embedTokenService = proxyquire('./embedTokenService', {
    '../config/database': dbMock,
  });

  const tokens = await embedTokenService.listEmbedTokensForUser('u-1');
  assert.deepEqual(tokens, []);
});

test('embedTokenService validation flows for valid, expired, and revoked tokens', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('cped_testrawtoken123456789', 10);

  const dbMock = {
    query: async (sql, params) => {
      if (sql.includes('SELECT * FROM embed_tokens WHERE token_prefix')) {
        if (params[0] === 'cped_testraw') {
          return {
            rows: [{
              id: 't-1',
              user_id: 'u-1',
              label: 'Widget',
              token_hash: hash,
              token_prefix: 'cped_testraw',
              default_topic: null,
              default_asset: null,
              last_used_at: null,
              created_at: new Date(),
              revoked_at: params[2] === 'revoked' ? new Date() : null,
            }],
          };
        }
      }
      return { rows: [] };
    },
  };

  const embedTokenService = proxyquire('./embedTokenService', {
    '../config/database': dbMock,
  });

  const validRes = await embedTokenService.validateEmbedToken('cped_testrawtoken123456789');
  assert.ok(validRes);
  assert.equal(validRes.id, 't-1');

  const invalidRes = await embedTokenService.validateEmbedToken('cped_testrawwrongtoken');
  assert.equal(invalidRes, null);
});
