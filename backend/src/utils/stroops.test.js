const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_STROOPS,
  AmountError,
  toStroops,
  fromStroops,
  normalizeAmount,
  isValidAmount,
  splitFee,
  mulBpsCeil,
  mulBpsFloor,
  compareAmounts,
  percentToBps,
  divideAmounts,
} = require('./stroops');

test('converts values that drift under binary floating point exactly (#840)', () => {
  // Math.floor(parseFloat(x) * 1e7) yields 82899999 / 199899999 for these.
  assert.equal(Math.floor(parseFloat('8.29') * 10_000_000), 82_899_999, 'sanity: the float bug');
  assert.equal(toStroops('8.29'), 82_900_000n);
  assert.equal(toStroops('19.99'), 199_900_000n);
  assert.equal(toStroops(8.29), 82_900_000n, 'numbers use their shortest decimal form');
  assert.equal(toStroops(19.99), 199_900_000n);
  assert.equal(toStroops('0.3'), 3_000_000n);
  assert.equal(toStroops('1.1'), 11_000_000n);
});

test('one stroop and exactly seven decimals convert exactly', () => {
  assert.equal(toStroops('0.0000001'), 1n);
  assert.equal(toStroops('1e-7'), 1n);
  assert.equal(toStroops('1.2345678'), 12_345_678n);
  assert.equal(toStroops('0.1234567'), 1_234_567n);
});

test('more than seven decimals is rejected, never rounded or truncated', () => {
  for (const value of ['1.00000001', '0.00000005', '8.290000001', '1e-8']) {
    assert.throws(
      () => toStroops(value),
      err => err instanceof AmountError && err.code === 'AMOUNT_TOO_PRECISE'
    );
  }
  // Extra digits that are all zeros are exact and allowed.
  assert.equal(toStroops('1.50000000000'), 15_000_000n);
});

test('zero and negative values are rejected unless explicitly allowed', () => {
  assert.throws(() => toStroops('0'), /greater than zero/);
  assert.throws(() => toStroops('0.0000000'), /greater than zero/);
  assert.throws(() => toStroops('-1'), /negative/);
  assert.throws(() => toStroops('-0.0000001'), /negative/);
  assert.equal(toStroops('0', { allowZero: true }), 0n);
  assert.equal(toStroops('-2.5', { allowNegative: true }), -25_000_000n);
});

test('maximum supported amount is the Stellar int64 stroop limit', () => {
  assert.equal(toStroops('922337203685.4775807'), MAX_STROOPS);
  assert.throws(
    () => toStroops('922337203685.4775808'),
    err => err.code === 'AMOUNT_TOO_LARGE'
  );
  assert.throws(
    () => toStroops('1e20'),
    err => err.code === 'AMOUNT_TOO_LARGE'
  );
});

test('malformed input is rejected', () => {
  for (const value of [
    '',
    ' ',
    '.',
    'abc',
    '1.2.3',
    '1,000',
    '0x10',
    NaN,
    Infinity,
    null,
    undefined,
    {},
  ]) {
    assert.throws(() => toStroops(value), AmountError, `expected ${String(value)} to be rejected`);
  }
});

test('fromStroops renders canonical 7-decimal strings and round-trips', () => {
  assert.equal(fromStroops(82_900_000n), '8.2900000');
  assert.equal(fromStroops(1n), '0.0000001');
  assert.equal(fromStroops(0n), '0.0000000');
  assert.equal(fromStroops(-5n), '-0.0000005');
  assert.equal(fromStroops(MAX_STROOPS), '922337203685.4775807');
  assert.equal(fromStroops('199900000'), '19.9900000');
  for (const v of ['8.29', '19.99', '0.0000001', '922337203685.4775807', '123.4567']) {
    assert.equal(toStroops(fromStroops(toStroops(v))), toStroops(v));
  }
  assert.equal(normalizeAmount('8.29'), '8.2900000');
});

test('isValidAmount reports the same rule without throwing', () => {
  assert.equal(isValidAmount('8.29'), true);
  assert.equal(isValidAmount('8.290000001'), false);
  assert.equal(isValidAmount('0'), false);
  assert.equal(isValidAmount('-1'), false);
});

test('splitFee rounds the fee half-up and the parts always sum to the amount', () => {
  assert.deepEqual(splitFee(toStroops('8.29'), 250), {
    feeStroops: 2_072_500n,
    campaignStroops: 80_827_500n,
  });
  // 1 stroop at 2.5%: 0.025 stroop rounds to 0.
  assert.deepEqual(splitFee(1n, 250), { feeStroops: 0n, campaignStroops: 1n });
  // 20 stroops at 2.5% = 0.5 stroop, rounds half-up to 1.
  assert.deepEqual(splitFee(20n, 250), { feeStroops: 1n, campaignStroops: 19n });
  assert.deepEqual(splitFee(toStroops('19.99'), 0), {
    feeStroops: 0n,
    campaignStroops: 199_900_000n,
  });
  for (const amount of [1n, 7n, 82_900_000n, 199_900_000n, MAX_STROOPS]) {
    for (const bps of [0, 1, 250, 333, 9999, 10000]) {
      const { feeStroops, campaignStroops } = splitFee(amount, bps);
      assert.equal(feeStroops + campaignStroops, amount);
      assert.ok(feeStroops >= 0n && campaignStroops >= 0n);
    }
  }
  assert.throws(() => splitFee(100n, 10001), /basis points/);
  assert.throws(() => splitFee(100n, 2.5), /integer/);
});

test('mulBpsCeil rounds up to the next stroop', () => {
  assert.equal(mulBpsCeil(100n, 10500), 105n);
  assert.equal(mulBpsCeil(1n, 10500), 2n);
  assert.equal(mulBpsCeil(toStroops('8.29'), 10500), toStroops('8.7045'));
});

test('mulBpsFloor rounds down to the stroop so a payout never exceeds its share', () => {
  // 33.33% of 1 stroop-precise amount: 10.0000001 * 3333 / 10000 = 3.33300003333
  assert.equal(mulBpsFloor(toStroops('10.0000001'), 3333), 33_330_000n);
  assert.equal(mulBpsFloor(1n, 9999), 0n, 'sub-stroop share floors to zero');
  assert.equal(mulBpsFloor(toStroops('5000'), 10_000), toStroops('5000'));
  assert.throws(() => mulBpsFloor(-1n, 100), AmountError);
  assert.throws(() => mulBpsFloor(1n, 10_001), /basis points/);
});

test('compareAmounts compares 7-decimal amounts exactly', () => {
  // 0.1 + 0.2 !== 0.3 in floats; the strings compare exactly.
  assert.equal(compareAmounts('0.3000000', '0.3'), 0);
  assert.equal(compareAmounts('922337203685.4775806', '922337203685.4775807'), -1);
  assert.equal(
    parseFloat('922337203685.4775806') < parseFloat('922337203685.4775807'),
    false,
    'sanity: floats cannot tell these apart'
  );
  assert.equal(compareAmounts('0.0000001', '0'), 1);
  assert.equal(compareAmounts('-1', 0), -1);
  assert.equal(compareAmounts(toStroops('2'), '2'), 1, 'bigint is whole units, not stroops');
});

test('percentToBps parses percentages exactly into integer basis points', () => {
  assert.equal(percentToBps('25'), 2500);
  assert.equal(percentToBps('25.5'), 2550);
  assert.equal(percentToBps('33.3300'), 3333, 'trailing zeros (NUMERIC(7,4)) are fine');
  assert.equal(percentToBps(0.29), 29, 'float that drifts: 0.29 * 100 = 28.999999999999996');
  assert.equal(percentToBps(57.01), 5701, '57.01 * 100 = 5700.999999999999 in floats');
  assert.equal(percentToBps('100'), 10_000);
  assert.equal(percentToBps('0'), 0);
});

test('percentToBps rejects values that are not an exact basis point in range', () => {
  for (const bad of ['12.345', '33.3333', '100.01', '-1', 'abc', '', null, undefined, NaN]) {
    assert.throws(
      () => percentToBps(bad),
      err => err instanceof AmountError && err.code === 'INVALID_PERCENTAGE',
      `expected ${String(bad)} to be rejected`
    );
  }
});

test('divideAmounts returns an exact, minimal decimal ratio', () => {
  assert.equal(divideAmounts('105', '100'), '1.05');
  assert.equal(divideAmounts('20', '10'), '2');
  assert.equal(divideAmounts('1', '3'), '0.333333333333333');
  assert.equal(divideAmounts('2', '3'), '0.666666666666667', 'rounds half-up');
  assert.equal(divideAmounts('0.0000001', '1', 7), '0.0000001');
  assert.equal(divideAmounts('0', '5'), '0');
  assert.throws(() => divideAmounts('1', '0'), AmountError);
});
