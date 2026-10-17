const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateProportionalRefunds } = require('./dispute');

function sumAmounts(refunds) {
  return refunds.reduce((sum, r) => sum + BigInt(r.amount.replace('.', '')), 0n).toString();
}

test('allocateProportionalRefunds splits evenly for equal contributions', () => {
  const refunds = allocateProportionalRefunds(
    [
      { contributorId: 'a', walletPublicKey: 'GA', contributed: '100' },
      { contributorId: 'b', walletPublicKey: 'GB', contributed: '100' },
    ],
    '200'
  );
  assert.deepEqual(refunds.map(r => r.amount).sort(), ['100.0000000', '100.0000000']);
});

test('allocateProportionalRefunds sums to exactly the balance for indivisible splits', () => {
  const contributions = [
    { contributorId: 'a', walletPublicKey: 'GA', contributed: '10' },
    { contributorId: 'b', walletPublicKey: 'GB', contributed: '10' },
    { contributorId: 'c', walletPublicKey: 'GC', contributed: '10' },
  ];
  const balance = '100.0000001';
  const refunds = allocateProportionalRefunds(contributions, balance);

  const total = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(total.toFixed(7), Number(balance).toFixed(7));
  assert.equal(refunds.length, 3);
});

test('allocateProportionalRefunds is proportional to contribution size, not even split', () => {
  const refunds = allocateProportionalRefunds(
    [
      { contributorId: 'a', walletPublicKey: 'GA', contributed: '10' },
      { contributorId: 'b', walletPublicKey: 'GB', contributed: '90' },
    ],
    '100'
  );
  const byId = Object.fromEntries(refunds.map(r => [r.contributorId, r.amount]));
  assert.equal(byId.a, '10.0000000');
  assert.equal(byId.b, '90.0000000');
});

test('allocateProportionalRefunds handles a balance smaller than total contributed (fees taken)', () => {
  const refunds = allocateProportionalRefunds(
    [
      { contributorId: 'a', walletPublicKey: 'GA', contributed: '50' },
      { contributorId: 'b', walletPublicKey: 'GB', contributed: '50' },
    ],
    '99'
  );
  const total = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(total.toFixed(7), '99.0000000');
});

test('allocateProportionalRefunds returns empty array for zero balance', () => {
  const refunds = allocateProportionalRefunds(
    [{ contributorId: 'a', walletPublicKey: 'GA', contributed: '50' }],
    '0'
  );
  assert.deepEqual(refunds, []);
});

test('allocateProportionalRefunds returns empty array for no contributions', () => {
  const refunds = allocateProportionalRefunds([], '100');
  assert.deepEqual(refunds, []);
});
