const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function createService(dbMock = {}) {
  return proxyquire('./contributionPolicy', {
    '../config/database': dbMock,
  });
}

test('assertContributionPolicy - amount validation', async t => {
  const { assertContributionPolicy } = createService();
  const campaign = { id: 1 };

  await t.test('throws 422 if amount is zero', async () => {
    await assert.rejects(
      () => assertContributionPolicy(campaign, 0),
      err => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.message, 'Contribution amount must be greater than zero');
        return true;
      }
    );
  });

  await t.test('throws 422 if amount is negative', async () => {
    await assert.rejects(
      () => assertContributionPolicy(campaign, '-10.5'),
      err => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.message, 'Contribution amount must be greater than zero');
        return true;
      }
    );
  });

  await t.test('throws 422 if amount is NaN or missing', async () => {
    await assert.rejects(
      () => assertContributionPolicy(campaign, 'invalid'),
      err => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.message, 'Contribution amount must be greater than zero');
        return true;
      }
    );

    await assert.rejects(
      () => assertContributionPolicy(campaign, undefined),
      err => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.message, 'Contribution amount must be greater than zero');
        return true;
      }
    );
  });
});

test('assertContributionPolicy - deadline validation', async t => {
  const { assertContributionPolicy } = createService();

  await t.test('throws 400 if campaign deadline has passed', async () => {
    const campaign = {
      id: 1,
      deadline: new Date(Date.now() - 60000).toISOString(),
    };

    await assert.rejects(
      () => assertContributionPolicy(campaign, 100),
      err => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'Campaign deadline has passed');
        return true;
      }
    );
  });

  await t.test('passes if campaign deadline is in the future', async () => {
    const campaign = {
      id: 1,
      deadline: new Date(Date.now() + 86400000).toISOString(),
    };

    await assert.doesNotReject(() => assertContributionPolicy(campaign, 100));
  });

  await t.test('passes if campaign has no deadline', async () => {
    const campaign = { id: 1, deadline: null };
    await assert.doesNotReject(() => assertContributionPolicy(campaign, 100));
  });
});

test('assertContributionPolicy - min_contribution validation', async t => {
  const { assertContributionPolicy } = createService();

  await t.test('throws 400 if amount is below minimum contribution', async () => {
    const campaign = { id: 1, min_contribution: '50' };

    await assert.rejects(
      () => assertContributionPolicy(campaign, '49.99'),
      err => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'Contribution amount is below the minimum of 50');
        return true;
      }
    );
  });

  await t.test('passes if amount equals minimum contribution', async () => {
    const campaign = { id: 1, min_contribution: '50' };
    await assert.doesNotReject(() => assertContributionPolicy(campaign, '50'));
  });

  await t.test('passes if amount exceeds minimum contribution', async () => {
    const campaign = { id: 1, min_contribution: '50' };
    await assert.doesNotReject(() => assertContributionPolicy(campaign, 100));
  });
});

test('assertContributionPolicy - max_contribution validation', async t => {
  const { assertContributionPolicy } = createService();

  await t.test('throws 400 if amount exceeds maximum contribution', async () => {
    const campaign = { id: 1, max_contribution: '500' };

    await assert.rejects(
      () => assertContributionPolicy(campaign, '500.01'),
      err => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'Contribution amount exceeds the maximum of 500');
        return true;
      }
    );
  });

  await t.test('passes if amount equals maximum contribution', async () => {
    const campaign = { id: 1, max_contribution: '500' };
    await assert.doesNotReject(() => assertContributionPolicy(campaign, '500'));
  });

  await t.test('passes if amount is below maximum contribution', async () => {
    const campaign = { id: 1, max_contribution: '500' };
    await assert.doesNotReject(() => assertContributionPolicy(campaign, 250));
  });
});

test('assertContributionPolicy - max_per_user validation', async t => {
  await t.test('throws 400 if contribution exceeds per-contributor cap', async () => {
    let capturedQuery = null;
    let capturedParams = null;

    const dbMock = {
      query: async (sql, params) => {
        capturedQuery = sql;
        capturedParams = params;
        return { rows: [{ total: '80' }] };
      },
    };

    const { assertContributionPolicy } = createService(dbMock);
    const campaign = { id: 42, max_per_user: '100' };
    const sender = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    await assert.rejects(
      () => assertContributionPolicy(campaign, 25, sender),
      err => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'Contribution exceeds the per-contributor cap of 100');
        return true;
      }
    );

    assert.ok(capturedQuery.includes('SELECT COALESCE(SUM(amount)'));
    assert.deepEqual(capturedParams, [42, sender]);
  });

  await t.test('passes if total with new contribution equals cap', async () => {
    const dbMock = {
      query: async () => ({ rows: [{ total: '75' }] }),
    };

    const { assertContributionPolicy } = createService(dbMock);
    const campaign = { id: 42, max_per_user: '100' };
    const sender = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    await assert.doesNotReject(() => assertContributionPolicy(campaign, 25, sender));
  });

  await t.test('passes if sender has no previous contributions and within cap', async () => {
    const dbMock = {
      query: async () => ({ rows: [{ total: '0' }] }),
    };

    const { assertContributionPolicy } = createService(dbMock);
    const campaign = { id: 42, max_per_user: '100' };
    const sender = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    await assert.doesNotReject(() => assertContributionPolicy(campaign, 100, sender));
  });

  await t.test('skips query if senderPublicKey is not provided', async () => {
    let called = false;
    const dbMock = {
      query: async () => {
        called = true;
        return { rows: [{ total: '999' }] };
      },
    };

    const { assertContributionPolicy } = createService(dbMock);
    const campaign = { id: 42, max_per_user: '100' };

    await assert.doesNotReject(() => assertContributionPolicy(campaign, 50, null));
    assert.equal(called, false);
  });

  await t.test('skips query if max_per_user is not configured', async () => {
    let called = false;
    const dbMock = {
      query: async () => {
        called = true;
        return { rows: [{ total: '999' }] };
      },
    };

    const { assertContributionPolicy } = createService(dbMock);
    const campaign = { id: 42, max_per_user: null };
    const sender = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    await assert.doesNotReject(() => assertContributionPolicy(campaign, 50, sender));
    assert.equal(called, false);
  });
});
