/**
 * Node.js test mock for sorobanService.js
 *
 * Drop-in stub used by any test file that does:
 *   jest.mock('../services/sorobanService');        // (if using Jest)
 * or:
 *   const soroban = require('../services/__mocks__/sorobanService');
 *
 * With Node's built-in test runner (node:test) you can override the module
 * in tests by using require stubs or by pointing NODE_PATH to this directory.
 *
 * All functions return minimal realistic data so contract-dependent routes
 * can be exercised without hitting Stellar testnet.
 */

'use strict';

const { nativeToScVal } = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Configurable mock state
// ---------------------------------------------------------------------------
let _shouldFail = false;
let _returnValue = BigInt(0);

/** Call this in your test beforeEach to reset mock state */
function reset() {
  _shouldFail = false;
  _returnValue = BigInt(0);
}

/** Make the next invokeContract call throw (simulates network / contract error) */
function simulateFailure(fail = true) {
  _shouldFail = fail;
}

/** Set the value invokeContract will resolve to */
function setReturnValue(value) {
  _returnValue = value;
}

// ---------------------------------------------------------------------------
// Mocked exports (mirrors sorobanService.js public API)
// ---------------------------------------------------------------------------

/**
 * Mocked invokeContract — returns a configurable value without hitting testnet.
 *
 * @param {{ contractId: string, method: string, args: any[], signerSecret: string }} params
 * @returns {Promise<bigint|any>}
 */
async function invokeContract({ contractId, method, args, signerSecret }) {
  if (!contractId || typeof contractId !== 'string') {
    throw new Error('invokeContract: contractId is required');
  }
  if (!method || typeof method !== 'string') {
    throw new Error('invokeContract: method is required');
  }
  if (!signerSecret || typeof signerSecret !== 'string') {
    throw new Error('invokeContract: signerSecret is required');
  }

  if (_shouldFail) {
    throw new Error(`Simulated Soroban contract failure for method "${method}"`);
  }

  // Record call for assertion in tests
  invokeContract._calls.push({ contractId, method, args, signerSecret });

  return _returnValue;
}
invokeContract._calls = [];

/**
 * Mocked encodeMilestone — returns a minimal ScVal without crypto hashing.
 *
 * @param {{ title: string, release_percentage_units: number }} milestone
 * @returns {object} ScVal-compatible object
 */
function encodeMilestone(milestone) {
  if (!milestone || typeof milestone.title !== 'string') {
    throw new Error('encodeMilestone: milestone.title is required');
  }

  return nativeToScVal({
    title_hash: Buffer.alloc(32, 0), // zero hash for testing
    release_bps: milestone.release_percentage_units ?? 0,
    status: 0,
    evidence_hash: null,
  });
}

module.exports = {
  invokeContract,
  encodeMilestone,
  nativeToScVal, // re-exported as-is from the real SDK
  // Test helpers
  __mock: {
    reset,
    simulateFailure,
    setReturnValue,
    getCalls: () => invokeContract._calls.slice(),
    clearCalls: () => {
      invokeContract._calls = [];
    },
  },
};
