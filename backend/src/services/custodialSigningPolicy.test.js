const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT,
  CustodialSigningLimitError,
  assertCustodialWithdrawalAllowed,
  getCustodialWithdrawalLimit,
} = require('./custodialSigningPolicy');

function withLimit(value, fn) {
  const previous = process.env.CUSTODIAL_WITHDRAWAL_LIMIT;
  if (value === undefined) delete process.env.CUSTODIAL_WITHDRAWAL_LIMIT;
  else process.env.CUSTODIAL_WITHDRAWAL_LIMIT = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.CUSTODIAL_WITHDRAWAL_LIMIT;
    else process.env.CUSTODIAL_WITHDRAWAL_LIMIT = previous;
  }
}

test('custodial creators can sign withdrawals up to the limit', () => {
  withLimit('500', () => {
    assert.doesNotThrow(() =>
      assertCustodialWithdrawalAllowed({ walletType: 'custodial', amount: '500.0000000' })
    );
    assert.doesNotThrow(() =>
      assertCustodialWithdrawalAllowed({ walletType: 'custodial', amount: '12.5' })
    );
  });
});

test('custodial creators are refused above the limit', () => {
  withLimit('500', () => {
    assert.throws(
      () => assertCustodialWithdrawalAllowed({ walletType: 'custodial', amount: '500.0000001' }),
      err => {
        assert.ok(err instanceof CustodialSigningLimitError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'NON_CUSTODIAL_SIGNATURE_REQUIRED');
        assert.equal(err.limit, '500');
        return true;
      }
    );
  });
});

test('a missing wallet type is treated as custodial', () => {
  withLimit('10', () => {
    assert.throws(
      () => assertCustodialWithdrawalAllowed({ amount: '11' }),
      CustodialSigningLimitError
    );
  });
});

test('Freighter creators are never capped, since they sign client-side', () => {
  withLimit('10', () => {
    assert.doesNotThrow(() =>
      assertCustodialWithdrawalAllowed({ walletType: 'freighter', amount: '1000000' })
    );
  });
});

test('refunds to contributors are exempt from the cap', () => {
  withLimit('10', () => {
    assert.doesNotThrow(() =>
      assertCustodialWithdrawalAllowed({ walletType: 'custodial', amount: '5000', isRefund: true })
    );
  });
});

test('malformed amounts are refused rather than waved through', () => {
  withLimit('10', () => {
    for (const amount of ['abc', '-1', '', null, '1e9', '1.12345678']) {
      assert.throws(
        () => assertCustodialWithdrawalAllowed({ walletType: 'custodial', amount }),
        CustodialSigningLimitError,
        `expected ${amount} to be refused`
      );
    }
  });
});

test('falls back to the default limit when unset or invalid', () => {
  withLimit(undefined, () => {
    assert.equal(getCustodialWithdrawalLimit(), DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT);
  });
  withLimit('not-a-number', () => {
    assert.equal(getCustodialWithdrawalLimit(), DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT);
  });
  withLimit('250.5', () => {
    assert.equal(getCustodialWithdrawalLimit(), '250.5');
  });
});
