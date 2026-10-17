const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildReferral(queryImpl) {
  return proxyquire('./referral', {
    '../config/database': { query: queryImpl },
  });
}

test('buildReferralMemo produces a ref:<code> memo that fits Stellar memo text', () => {
  const { buildReferralMemo } = buildReferral(async () => ({ rows: [] }));
  const memo = buildReferralMemo('a1b2c3d4');
  assert.equal(memo, 'ref:a1b2c3d4');
  assert.ok(Buffer.byteLength(memo, 'utf8') <= 28);
});

test('generateUniqueLinkCode returns an 8-character alphanumeric code and retries on collision', async () => {
  let selectCount = 0;
  const { generateUniqueLinkCode } = buildReferral(async text => {
    if (text.includes('FROM referral_links WHERE code')) {
      selectCount++;
      return selectCount === 1 ? { rows: [{ 1: 1 }] } : { rows: [] };
    }
    return { rows: [] };
  });

  const code = await generateUniqueLinkCode();
  assert.equal(selectCount, 2);
  assert.match(code, /^[A-Za-z0-9]{8}$/);
});

test('createReferralProgram rejects a commission percentage outside 1-20', async () => {
  const { createReferralProgram } = buildReferral(async () => ({ rows: [] }));
  await assert.rejects(
    () => createReferralProgram('camp-1', { commissionPercentage: 25, maxReferrers: 10 }),
    err => err.statusCode === 400 && err.code === 'INVALID_COMMISSION_PERCENTAGE'
  );
  await assert.rejects(
    () => createReferralProgram('camp-1', { commissionPercentage: 0, maxReferrers: 10 }),
    err => err.code === 'INVALID_COMMISSION_PERCENTAGE'
  );
});

test('createReferralProgram rejects maxReferrers outside 1-100', async () => {
  const { createReferralProgram } = buildReferral(async () => ({ rows: [] }));
  await assert.rejects(
    () => createReferralProgram('camp-1', { commissionPercentage: 10, maxReferrers: 101 }),
    err => err.statusCode === 400 && err.code === 'INVALID_MAX_REFERRERS'
  );
});

test('createReferralProgram persists a valid program', async () => {
  const calls = [];
  const { createReferralProgram } = buildReferral(async (text, params) => {
    calls.push({ text, params });
    return {
      rows: [
        { id: 'prog-1', campaign_id: 'camp-1', commission_percentage: '5.00', max_referrers: 10 },
      ],
    };
  });

  const program = await createReferralProgram('camp-1', {
    commissionPercentage: 5,
    maxReferrers: 10,
  });
  assert.equal(program.id, 'prog-1');
  assert.match(calls[0].text, /INSERT INTO referral_programs/);
  assert.deepEqual(calls[0].params, ['camp-1', 5, 10]);
});

test('createReferralLink issues a code and share url', async () => {
  const { createReferralLink } = buildReferral(async text => {
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '5.00', max_referrers: 3 }] };
    }
    if (text.includes('FROM referral_links WHERE campaign_id = $1 AND user_id'))
      return { rows: [] };
    if (text.includes('COUNT(*)::int AS total FROM referral_links'))
      return { rows: [{ total: 1 }] };
    if (text.includes('FROM referral_links WHERE code')) return { rows: [] };
    if (text.includes('INSERT INTO referral_links')) {
      return { rows: [{ id: 'link-1', code: 'abcd1234', created_at: 'now' }] };
    }
    return { rows: [] };
  });

  const result = await createReferralLink({ campaignId: 'camp-1', userId: 'user-2' });
  assert.equal(result.created, true);
  assert.equal(result.code, 'abcd1234');
  assert.match(result.shareUrl, /\/c\/camp-1\?ref=abcd1234$/);
});

test('createReferralLink returns the existing link instead of issuing a second one', async () => {
  const calls = [];
  const { createReferralLink } = buildReferral(async text => {
    calls.push(text);
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '5.00', max_referrers: 3 }] };
    }
    if (text.includes('FROM referral_links WHERE campaign_id = $1 AND user_id')) {
      return { rows: [{ id: 'link-1', code: 'existing1', created_at: 'now' }] };
    }
    return { rows: [] };
  });

  const result = await createReferralLink({ campaignId: 'camp-1', userId: 'user-2' });
  assert.equal(result.created, false);
  assert.equal(result.code, 'existing1');
  assert.ok(!calls.some(text => text.includes('INSERT INTO referral_links')));
});

test('createReferralLink rejects the (n+1)th referrer with REFERRER_LIMIT_REACHED', async () => {
  const { createReferralLink } = buildReferral(async text => {
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '5.00', max_referrers: 3 }] };
    }
    if (text.includes('FROM referral_links WHERE campaign_id = $1 AND user_id'))
      return { rows: [] };
    if (text.includes('COUNT(*)::int AS total FROM referral_links'))
      return { rows: [{ total: 3 }] };
    return { rows: [] };
  });

  await assert.rejects(
    () => createReferralLink({ campaignId: 'camp-1', userId: 'user-4' }),
    err => err.statusCode === 409 && err.code === 'REFERRER_LIMIT_REACHED'
  );
});

test('createReferralLink 404s when the campaign has no referral program', async () => {
  const { createReferralLink } = buildReferral(async () => ({ rows: [] }));
  await assert.rejects(
    () => createReferralLink({ campaignId: 'camp-1', userId: 'user-2' }),
    err => err.statusCode === 404 && err.code === 'REFERRAL_PROGRAM_NOT_FOUND'
  );
});

test('resolveReferralLink rejects a code that belongs to another campaign', async () => {
  const { resolveReferralLink } = buildReferral(async () => ({ rows: [] }));
  await assert.rejects(
    () => resolveReferralLink({ campaignId: 'camp-1', code: 'other123' }),
    err => err.statusCode === 404 && err.code === 'INVALID_REFERRAL_CODE'
  );
});

test('resolveReferralLink returns the link when the code belongs to the campaign', async () => {
  const { resolveReferralLink } = buildReferral(async (text, params) => {
    assert.deepEqual(params, ['abcd1234', 'camp-1']);
    assert.match(text, /FROM referral_links WHERE code = \$1 AND campaign_id = \$2/);
    return { rows: [{ id: 'link-1', campaign_id: 'camp-1', user_id: 'user-2', code: 'abcd1234' }] };
  });

  const link = await resolveReferralLink({ campaignId: 'camp-1', code: 'abcd1234' });
  assert.equal(link.id, 'link-1');
});

test('resolveReferralLink is a no-op when no code is supplied', async () => {
  let called = false;
  const { resolveReferralLink } = buildReferral(async () => {
    called = true;
    return { rows: [] };
  });
  assert.equal(await resolveReferralLink({ campaignId: 'camp-1', code: null }), null);
  assert.equal(called, false);
});

test('calculateCommissions distributes commission proportional to attributed contributions', async () => {
  const { calculateCommissions } = buildReferral(async text => {
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '10.00', max_referrers: 10 }] };
    }
    return {
      rows: [
        {
          referral_link_id: 'link-1',
          code: 'aaaa1111',
          user_id: 'u1',
          commission_paid: '0',
          referrer_name: 'Alice',
          wallet_public_key: 'GALICE',
          contribution_count: 2,
          referred_amount: '600',
        },
        {
          referral_link_id: 'link-2',
          code: 'bbbb2222',
          user_id: 'u2',
          commission_paid: '0',
          referrer_name: 'Bob',
          wallet_public_key: 'GBOB',
          contribution_count: 1,
          referred_amount: '300',
        },
        {
          referral_link_id: 'link-3',
          code: 'cccc3333',
          user_id: 'u3',
          commission_paid: '0',
          referrer_name: 'Cara',
          wallet_public_key: 'GCARA',
          contribution_count: 1,
          referred_amount: '100',
        },
      ],
    };
  });

  const { commissions, totalCommission } = await calculateCommissions('camp-1');

  assert.equal(commissions.length, 3);
  // 10% of 600 / 300 / 100 — checked against manual arithmetic
  assert.equal(commissions[0].commission_owed, '60.0000000');
  assert.equal(commissions[1].commission_owed, '30.0000000');
  assert.equal(commissions[2].commission_owed, '10.0000000');
  assert.equal(totalCommission, '100.0000000');
});

test('calculateCommissions excludes a referrer whose referred contributions total zero', async () => {
  const { calculateCommissions } = buildReferral(async text => {
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '5.00', max_referrers: 10 }] };
    }
    return {
      rows: [
        {
          referral_link_id: 'link-1',
          code: 'aaaa1111',
          user_id: 'u1',
          commission_paid: '0',
          referrer_name: 'Alice',
          wallet_public_key: 'GALICE',
          contribution_count: 1,
          referred_amount: '200',
        },
        {
          referral_link_id: 'link-2',
          code: 'bbbb2222',
          user_id: 'u2',
          commission_paid: '0',
          referrer_name: 'Bob',
          wallet_public_key: 'GBOB',
          contribution_count: 0,
          referred_amount: '0',
        },
      ],
    };
  });

  const { commissions, totalCommission } = await calculateCommissions('camp-1');
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].code, 'aaaa1111');
  assert.equal(totalCommission, '10.0000000');
});

test('calculateCommissions nets off commission already paid by an earlier withdrawal', async () => {
  const { calculateCommissions } = buildReferral(async text => {
    if (text.includes('FROM referral_programs')) {
      return { rows: [{ id: 'prog-1', commission_percentage: '10.00', max_referrers: 10 }] };
    }
    return {
      rows: [
        {
          referral_link_id: 'link-1',
          code: 'aaaa1111',
          user_id: 'u1',
          commission_paid: '40',
          referrer_name: 'Alice',
          wallet_public_key: 'GALICE',
          contribution_count: 2,
          referred_amount: '600',
        },
        {
          referral_link_id: 'link-2',
          code: 'bbbb2222',
          user_id: 'u2',
          commission_paid: '30',
          referrer_name: 'Bob',
          wallet_public_key: 'GBOB',
          contribution_count: 1,
          referred_amount: '300',
        },
      ],
    };
  });

  const { commissions, totalCommission } = await calculateCommissions('camp-1');
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].commission_owed, '20.0000000');
  assert.equal(totalCommission, '20.0000000');
});

test('calculateCommissions returns nothing when the campaign has no referral program', async () => {
  const { calculateCommissions } = buildReferral(async () => ({ rows: [] }));
  const result = await calculateCommissions('camp-1');
  assert.equal(result.program, null);
  assert.deepEqual(result.commissions, []);
  assert.equal(result.totalCommission, '0.0000000');
});

test('settleCommissions credits each referral link with the amount just paid', async () => {
  const calls = [];
  const { settleCommissions } = buildReferral(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  });

  await settleCommissions(null, [
    { referral_link_id: 'link-1', commission_owed: '60.0000000' },
    { referral_link_id: 'link-2', commission_owed: '30.0000000' },
  ]);

  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /commission_paid = commission_paid \+ \$1/);
  assert.deepEqual(calls[0].params, ['60.0000000', 'link-1']);
  assert.deepEqual(calls[1].params, ['30.0000000', 'link-2']);
});

test('listUserReferralLinks reports commission earned and payout status per campaign', async () => {
  const { listUserReferralLinks } = buildReferral(async () => ({
    rows: [
      {
        referral_link_id: 'link-1',
        code: 'aaaa1111',
        campaign_id: 'camp-1',
        commission_paid: '0',
        created_at: 'now',
        campaign_title: 'Solar',
        campaign_status: 'active',
        asset_type: 'USDC',
        commission_percentage: '10.00',
        contribution_count: 2,
        referred_amount: '500',
      },
      {
        referral_link_id: 'link-2',
        code: 'bbbb2222',
        campaign_id: 'camp-2',
        commission_paid: '25',
        created_at: 'now',
        campaign_title: 'Wells',
        campaign_status: 'funded',
        asset_type: 'USDC',
        commission_percentage: '5.00',
        contribution_count: 1,
        referred_amount: '500',
      },
      {
        referral_link_id: 'link-3',
        code: 'cccc3333',
        campaign_id: 'camp-3',
        commission_paid: '0',
        created_at: 'now',
        campaign_title: 'Books',
        campaign_status: 'active',
        asset_type: 'XLM',
        commission_percentage: '5.00',
        contribution_count: 0,
        referred_amount: '0',
      },
    ],
  }));

  const links = await listUserReferralLinks('user-2');
  assert.equal(links[0].commission_earned, '50.0000000');
  assert.equal(links[0].status, 'pending');
  assert.equal(links[1].status, 'paid');
  assert.equal(links[2].status, 'no_referrals');
  assert.match(links[0].share_url, /\/c\/camp-1\?ref=aaaa1111$/);
});
