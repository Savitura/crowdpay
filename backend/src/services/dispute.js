/**
 * dispute.js
 *
 * Pure, IO-free dispute business logic. HTTP orchestration (DB reads/writes,
 * Stellar calls, emails) stays in routes/disputes.js — this module holds the
 * logic that's worth unit-testing in isolation, chiefly the proportional
 * refund allocation the acceptance criteria hold to an exact-sum guarantee.
 */

const ERROR_CODES = {
  NOT_A_CONTRIBUTOR: 'NOT_A_CONTRIBUTOR',
  CAMPAIGN_DISPUTED: 'CAMPAIGN_DISPUTED',
};

const UNITS_PER_STELLAR_AMOUNT = 10_000_000n; // Stellar amounts have 7 decimal places

function toUnits(amount) {
  // Parse a decimal string/number into integer 1e-7 units without float error.
  const [whole, frac = ''] = String(amount).split('.');
  const fracPadded = (frac + '0000000').slice(0, 7);
  const sign = whole.startsWith('-') ? -1n : 1n;
  const wholeUnits = BigInt(whole.replace('-', '')) * UNITS_PER_STELLAR_AMOUNT;
  const fracUnits = BigInt(fracPadded || '0');
  return sign * (wholeUnits + fracUnits);
}

function fromUnits(units) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / UNITS_PER_STELLAR_AMOUNT;
  const frac = abs % UNITS_PER_STELLAR_AMOUNT;
  const fracStr = frac.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/**
 * Allocates `balance` proportionally across contributors based on their
 * total contributed amount, using a largest-remainder method so the
 * allocated amounts sum to exactly `balance` (no floating point drift).
 *
 * @param {Array<{contributorId: string, walletPublicKey: string, contributed: string|number}>} contributions
 * @param {string|number} balance - the campaign wallet's current balance for this asset
 * @returns {Array<{contributorId: string, walletPublicKey: string, amount: string}>}
 */
function allocateProportionalRefunds(contributions, balance) {
  const balanceUnits = toUnits(balance);
  if (balanceUnits <= 0n || !contributions.length) return [];

  const contributedUnits = contributions.map(c => toUnits(c.contributed));
  const totalContributedUnits = contributedUnits.reduce((sum, u) => sum + u, 0n);
  if (totalContributedUnits <= 0n) return [];

  const shares = contributions.map((c, i) => {
    const numerator = balanceUnits * contributedUnits[i];
    const floorShare = numerator / totalContributedUnits;
    const remainder = numerator % totalContributedUnits;
    return { ...c, floorShare, remainder };
  });

  const allocated = shares.reduce((sum, s) => sum + s.floorShare, 0n);
  let remainingUnits = balanceUnits - allocated;

  // Distribute the leftover units (from flooring) one-by-one to the
  // contributors with the largest remainders, for a deterministic,
  // exact-sum result.
  const byRemainderDesc = [...shares].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder > a.remainder ? 1 : -1;
    return a.contributorId < b.contributorId ? -1 : 1;
  });

  for (const s of byRemainderDesc) {
    if (remainingUnits <= 0n) break;
    s.floorShare += 1n;
    remainingUnits -= 1n;
  }

  return shares
    .filter(s => s.floorShare > 0n)
    .map(s => ({
      contributorId: s.contributorId,
      walletPublicKey: s.walletPublicKey,
      amount: fromUnits(s.floorShare),
    }));
}

module.exports = {
  ERROR_CODES,
  allocateProportionalRefunds,
};
