const crypto = require('crypto');
const db = require('../config/database');

// Stellar memo text is capped at 28 bytes; `ref:` + an 8-char code fits comfortably.
const MEMO_PREFIX = 'ref:';
const REFERRAL_CODE_LENGTH = 8;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STELLAR_DECIMALS = 7;

const MIN_COMMISSION_PERCENTAGE = 1;
const MAX_COMMISSION_PERCENTAGE = 20;
const MIN_MAX_REFERRERS = 1;
const MAX_MAX_REFERRERS = 100;

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function buildShareUrl(campaignId, code) {
  return `${frontendBaseUrl()}/c/${campaignId}?ref=${code}`;
}

function buildReferralMemo(code) {
  return `${MEMO_PREFIX}${code}`;
}

/** Round to Stellar's 7-decimal precision without ever paying out more than is owed. */
function toStellarAmount(value) {
  const scale = 10 ** STELLAR_DECIMALS;
  return (Math.floor(Number(value) * scale) / scale).toFixed(STELLAR_DECIMALS);
}

function randomCode() {
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

async function generateUniqueLinkCode(runner = db) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const { rows } = await runner.query('SELECT 1 FROM referral_links WHERE code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not generate unique referral code');
}

/**
 * Enable referrals on a campaign. Re-running updates the existing program so a
 * creator can adjust the commission without orphaning issued links.
 */
async function createReferralProgram(
  campaignId,
  { commissionPercentage, maxReferrers },
  runner = db
) {
  const percentage = Number(commissionPercentage);
  const referrers = Number(maxReferrers);

  if (
    !Number.isFinite(percentage) ||
    percentage < MIN_COMMISSION_PERCENTAGE ||
    percentage > MAX_COMMISSION_PERCENTAGE
  ) {
    throw httpError(
      400,
      'INVALID_COMMISSION_PERCENTAGE',
      `commissionPercentage must be between ${MIN_COMMISSION_PERCENTAGE} and ${MAX_COMMISSION_PERCENTAGE}`
    );
  }
  if (
    !Number.isInteger(referrers) ||
    referrers < MIN_MAX_REFERRERS ||
    referrers > MAX_MAX_REFERRERS
  ) {
    throw httpError(
      400,
      'INVALID_MAX_REFERRERS',
      `maxReferrers must be an integer between ${MIN_MAX_REFERRERS} and ${MAX_MAX_REFERRERS}`
    );
  }

  const { rows } = await runner.query(
    `INSERT INTO referral_programs (campaign_id, commission_percentage, max_referrers)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id) DO UPDATE
       SET commission_percentage = EXCLUDED.commission_percentage,
           max_referrers = EXCLUDED.max_referrers
     RETURNING id, campaign_id, commission_percentage, max_referrers, created_at`,
    [campaignId, percentage, referrers]
  );
  return rows[0];
}

async function getReferralProgram(campaignId, runner = db) {
  const { rows } = await runner.query(
    `SELECT id, campaign_id, commission_percentage, max_referrers, created_at
     FROM referral_programs WHERE campaign_id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

/**
 * Issue (or return the existing) referral link for a user on a campaign.
 * Rejects with REFERRER_LIMIT_REACHED once max_referrers links exist.
 */
async function createReferralLink({ campaignId, userId }, runner = db) {
  const program = await getReferralProgram(campaignId, runner);
  if (!program) {
    throw httpError(
      404,
      'REFERRAL_PROGRAM_NOT_FOUND',
      'This campaign does not have a referral program'
    );
  }

  const { rows: existing } = await runner.query(
    'SELECT id, code, created_at FROM referral_links WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId]
  );
  if (existing.length) {
    return {
      link: existing[0],
      created: false,
      code: existing[0].code,
      shareUrl: buildShareUrl(campaignId, existing[0].code),
    };
  }

  const { rows: countRows } = await runner.query(
    'SELECT COUNT(*)::int AS total FROM referral_links WHERE campaign_id = $1',
    [campaignId]
  );
  if ((countRows[0]?.total || 0) >= program.max_referrers) {
    throw httpError(
      409,
      'REFERRER_LIMIT_REACHED',
      `This campaign has reached its limit of ${program.max_referrers} referrers`
    );
  }

  const code = await generateUniqueLinkCode(runner);
  const { rows } = await runner.query(
    `INSERT INTO referral_links (campaign_id, user_id, code)
     VALUES ($1, $2, $3)
     RETURNING id, code, created_at`,
    [campaignId, userId, code]
  );
  return {
    link: rows[0],
    created: true,
    code: rows[0].code,
    shareUrl: buildShareUrl(campaignId, rows[0].code),
  };
}

/**
 * Resolve a referral code for a campaign. A code that exists but belongs to a
 * different campaign is treated exactly like a missing one.
 */
async function resolveReferralLink({ campaignId, code }, runner = db) {
  if (!code) return null;
  const { rows } = await runner.query(
    'SELECT id, campaign_id, user_id, code FROM referral_links WHERE code = $1 AND campaign_id = $2',
    [code, campaignId]
  );
  if (!rows.length) {
    throw httpError(404, 'INVALID_REFERRAL_CODE', 'Referral code is not valid for this campaign');
  }
  return rows[0];
}

/**
 * Commission owed to every referrer of a campaign, net of commission already
 * paid out by earlier withdrawals. Referrers with nothing owed are excluded so
 * a zero-amount payment can never reach the withdrawal transaction.
 */
async function calculateCommissions(campaignId, runner = db) {
  const program = await getReferralProgram(campaignId, runner);
  if (!program) {
    return { program: null, commissions: [], totalCommission: '0.0000000' };
  }

  const { rows } = await runner.query(
    `SELECT rl.id AS referral_link_id,
            rl.code,
            rl.user_id,
            rl.commission_paid,
            u.name AS referrer_name,
            u.wallet_public_key,
            COUNT(c.id)::int AS contribution_count,
            COALESCE(SUM(c.amount), 0)::numeric AS referred_amount
     FROM referral_links rl
     JOIN users u ON u.id = rl.user_id
     LEFT JOIN contributions c
       ON c.referral_link_id = rl.id AND c.refunded = FALSE
     WHERE rl.campaign_id = $1
     GROUP BY rl.id, rl.code, rl.user_id, rl.commission_paid, u.name, u.wallet_public_key
     ORDER BY referred_amount DESC`,
    [campaignId]
  );

  const rate = Number(program.commission_percentage) / 100;
  const commissions = [];
  let total = 0;

  for (const row of rows) {
    const referredAmount = Number(row.referred_amount);
    const earned = Number(toStellarAmount(referredAmount * rate));
    const owed = Number(toStellarAmount(earned - Number(row.commission_paid)));
    if (owed <= 0) continue;

    commissions.push({
      referral_link_id: row.referral_link_id,
      code: row.code,
      user_id: row.user_id,
      referrer_name: row.referrer_name,
      destination_public_key: row.wallet_public_key,
      contribution_count: row.contribution_count,
      referred_amount: toStellarAmount(referredAmount),
      commission_earned: toStellarAmount(earned),
      commission_paid: toStellarAmount(row.commission_paid),
      commission_owed: toStellarAmount(owed),
    });
    total += owed;
  }

  return {
    program: {
      commission_percentage: Number(program.commission_percentage),
      max_referrers: program.max_referrers,
    },
    commissions,
    totalCommission: toStellarAmount(total),
  };
}

/**
 * Full referrer breakdown for the campaign analytics tab — unlike
 * calculateCommissions this keeps referrers who have not converted yet.
 */
async function listCampaignReferrers(campaignId, runner = db) {
  const program = await getReferralProgram(campaignId, runner);
  if (!program) return { program: null, referrers: [] };

  const { rows } = await runner.query(
    `SELECT rl.id AS referral_link_id,
            rl.code,
            rl.user_id,
            rl.commission_paid,
            rl.created_at,
            u.name AS referrer_name,
            COUNT(c.id)::int AS contribution_count,
            COALESCE(SUM(c.amount), 0)::numeric AS referred_amount
     FROM referral_links rl
     JOIN users u ON u.id = rl.user_id
     LEFT JOIN contributions c
       ON c.referral_link_id = rl.id AND c.refunded = FALSE
     WHERE rl.campaign_id = $1
     GROUP BY rl.id, rl.code, rl.user_id, rl.commission_paid, rl.created_at, u.name
     ORDER BY referred_amount DESC, rl.created_at ASC`,
    [campaignId]
  );

  const rate = Number(program.commission_percentage) / 100;
  return {
    program: {
      commission_percentage: Number(program.commission_percentage),
      max_referrers: program.max_referrers,
      referrer_count: rows.length,
    },
    referrers: rows.map(row => {
      const earned = Number(toStellarAmount(Number(row.referred_amount) * rate));
      return {
        referral_link_id: row.referral_link_id,
        code: row.code,
        user_id: row.user_id,
        referrer_name: row.referrer_name,
        contribution_count: row.contribution_count,
        referred_amount: toStellarAmount(row.referred_amount),
        commission_earned: toStellarAmount(earned),
        commission_paid: toStellarAmount(row.commission_paid),
        commission_owed: toStellarAmount(Math.max(earned - Number(row.commission_paid), 0)),
        created_at: row.created_at,
      };
    }),
  };
}

/** Every referral link a user holds, with the commission each has earned. */
async function listUserReferralLinks(userId, runner = db) {
  const { rows } = await runner.query(
    `SELECT rl.id AS referral_link_id,
            rl.code,
            rl.campaign_id,
            rl.commission_paid,
            rl.created_at,
            c.title AS campaign_title,
            c.status AS campaign_status,
            c.asset_type,
            rp.commission_percentage,
            COUNT(ctr.id)::int AS contribution_count,
            COALESCE(SUM(ctr.amount), 0)::numeric AS referred_amount
     FROM referral_links rl
     JOIN campaigns c ON c.id = rl.campaign_id
     LEFT JOIN referral_programs rp ON rp.campaign_id = rl.campaign_id
     LEFT JOIN contributions ctr
       ON ctr.referral_link_id = rl.id AND ctr.refunded = FALSE
     WHERE rl.user_id = $1
     GROUP BY rl.id, rl.code, rl.campaign_id, rl.commission_paid, rl.created_at,
              c.title, c.status, c.asset_type, rp.commission_percentage
     ORDER BY rl.created_at DESC`,
    [userId]
  );

  return rows.map(row => {
    const rate = Number(row.commission_percentage || 0) / 100;
    const earned = Number(toStellarAmount(Number(row.referred_amount) * rate));
    const paid = Number(row.commission_paid);
    return {
      referral_link_id: row.referral_link_id,
      code: row.code,
      campaign_id: row.campaign_id,
      campaign_title: row.campaign_title,
      campaign_status: row.campaign_status,
      asset_type: row.asset_type,
      commission_percentage: Number(row.commission_percentage || 0),
      share_url: buildShareUrl(row.campaign_id, row.code),
      contribution_count: row.contribution_count,
      referred_amount: toStellarAmount(row.referred_amount),
      commission_earned: toStellarAmount(earned),
      commission_paid: toStellarAmount(paid),
      commission_owed: toStellarAmount(Math.max(earned - paid, 0)),
      status: earned <= 0 ? 'no_referrals' : paid >= earned ? 'paid' : 'pending',
      created_at: row.created_at,
    };
  });
}

/**
 * Record commissions that have just been submitted on-chain so the next
 * withdrawal for the campaign does not pay them again.
 */
async function settleCommissions(client, commissions = []) {
  const runner = client || db;
  for (const commission of commissions) {
    await runner.query(
      'UPDATE referral_links SET commission_paid = commission_paid + $1 WHERE id = $2',
      [commission.commission_owed ?? commission.amount, commission.referral_link_id]
    );
  }
}

module.exports = {
  buildReferralMemo,
  buildShareUrl,
  calculateCommissions,
  createReferralLink,
  createReferralProgram,
  generateUniqueLinkCode,
  getReferralProgram,
  listCampaignReferrers,
  listUserReferralLinks,
  resolveReferralLink,
  settleCommissions,
  toStellarAmount,
  MEMO_PREFIX,
  REFERRAL_CODE_LENGTH,
};
