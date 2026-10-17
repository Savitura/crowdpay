const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Operation,
} = require('@stellar/stellar-sdk');
const {
  MULTISIG_STANDARD_THRESHOLDS,
  MULTISIG_DISPUTE_FROZEN_THRESHOLDS,
  MULTISIG_DISPUTE_RELEASED_THRESHOLDS,
  MULTISIG_CLEANUP_THRESHOLDS,
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_SIGNER_WEIGHT_REMOVE,
  MULTISIG_MASTER_WEIGHT_DISABLED,
  buildAddSignerOperation,
  buildRemoveSignerOperation,
  buildCampaignMultisigOperations,
  applyCampaignMultisig,
  buildFreezeEscrowOperations,
  buildReleaseEscrowFreezeOperations,
  buildCloseWalletMultisigOperations,
} = require('./campaignMultisig');

test('buildAddSignerOperation and buildRemoveSignerOperation construct correct SetOptions', () => {
  const pubKey = Keypair.random().publicKey();

  const addOp = Operation.fromXDRObject(buildAddSignerOperation(pubKey, 1));
  assert.equal(addOp.type, 'setOptions');
  assert.equal(addOp.signer.ed25519PublicKey, pubKey);
  assert.equal(addOp.signer.weight, 1);

  const removeOp = Operation.fromXDRObject(buildRemoveSignerOperation(pubKey));
  assert.equal(removeOp.type, 'setOptions');
  assert.equal(removeOp.signer.ed25519PublicKey, pubKey);
  assert.equal(removeOp.signer.weight, 0);

  assert.throws(() => buildAddSignerOperation(null), /valid ed25519PublicKey/);
  assert.throws(() => buildAddSignerOperation(''), /valid ed25519PublicKey/);
});

test('buildCampaignMultisigOperations builds standard 2-of-2 multisig operations', () => {
  const creatorKey = Keypair.random().publicKey();
  const platformKey = Keypair.random().publicKey();

  const rawOps = buildCampaignMultisigOperations({
    creatorPublicKey: creatorKey,
    platformPublicKey: platformKey,
  });

  assert.equal(rawOps.length, 3);
  const ops = rawOps.map(op => Operation.fromXDRObject(op));

  // 1. Creator signer
  assert.equal(ops[0].type, 'setOptions');
  assert.equal(ops[0].signer.ed25519PublicKey, creatorKey);
  assert.equal(ops[0].signer.weight, MULTISIG_SIGNER_WEIGHT);

  // 2. Platform signer
  assert.equal(ops[1].type, 'setOptions');
  assert.equal(ops[1].signer.ed25519PublicKey, platformKey);
  assert.equal(ops[1].signer.weight, MULTISIG_SIGNER_WEIGHT);

  // 3. Master key disabled + 1-2-2 thresholds
  assert.equal(ops[2].type, 'setOptions');
  assert.equal(ops[2].masterWeight, MULTISIG_MASTER_WEIGHT_DISABLED);
  assert.equal(ops[2].lowThreshold, MULTISIG_STANDARD_THRESHOLDS.lowThreshold);
  assert.equal(ops[2].medThreshold, MULTISIG_STANDARD_THRESHOLDS.medThreshold);
  assert.equal(ops[2].highThreshold, MULTISIG_STANDARD_THRESHOLDS.highThreshold);

  assert.throws(
    () =>
      buildCampaignMultisigOperations({ creatorPublicKey: null, platformPublicKey: platformKey }),
    /creatorPublicKey is required/
  );
  assert.throws(
    () =>
      buildCampaignMultisigOperations({ creatorPublicKey: creatorKey, platformPublicKey: null }),
    /platformPublicKey is required/
  );
});

test('applyCampaignMultisig appends all multisig operations to TransactionBuilder', () => {
  const accountKey = Keypair.random();
  const creatorKey = Keypair.random().publicKey();
  const platformKey = Keypair.random().publicKey();

  const account = {
    accountId: () => accountKey.publicKey(),
    sequenceNumber: () => '1',
    incrementSequenceNumber: () => {},
  };

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });

  applyCampaignMultisig(builder, {
    creatorPublicKey: creatorKey,
    platformPublicKey: platformKey,
  });

  const tx = builder.setTimeout(30).build();
  assert.equal(tx.operations.length, 3);
  assert.equal(tx.operations[0].signer.ed25519PublicKey, creatorKey);
  assert.equal(tx.operations[1].signer.ed25519PublicKey, platformKey);
  assert.equal(tx.operations[2].masterWeight, 0);
  assert.equal(tx.operations[2].medThreshold, 2);
});

test('buildFreezeEscrowOperations builds 3-of-3 dispute freeze operations', () => {
  const arbitratorKey = Keypair.random().publicKey();

  const rawOps = buildFreezeEscrowOperations({ arbitratorPublicKey: arbitratorKey });
  assert.equal(rawOps.length, 2);
  const ops = rawOps.map(op => Operation.fromXDRObject(op));

  // 1. Arbitrator signer
  assert.equal(ops[0].type, 'setOptions');
  assert.equal(ops[0].signer.ed25519PublicKey, arbitratorKey);
  assert.equal(ops[0].signer.weight, MULTISIG_SIGNER_WEIGHT);

  // 2. Raise thresholds to 3-of-3
  assert.equal(ops[1].type, 'setOptions');
  assert.equal(ops[1].medThreshold, MULTISIG_DISPUTE_FROZEN_THRESHOLDS.medThreshold);
  assert.equal(ops[1].highThreshold, MULTISIG_DISPUTE_FROZEN_THRESHOLDS.highThreshold);

  assert.throws(() => buildFreezeEscrowOperations({}), /arbitratorPublicKey is required/);
});

test('buildReleaseEscrowFreezeOperations builds 2-of-2 release operations', () => {
  const arbitratorKey = Keypair.random().publicKey();

  const rawOps = buildReleaseEscrowFreezeOperations({ arbitratorPublicKey: arbitratorKey });
  assert.equal(rawOps.length, 2);
  const ops = rawOps.map(op => Operation.fromXDRObject(op));

  // 1. Arbitrator signer revoked
  assert.equal(ops[0].type, 'setOptions');
  assert.equal(ops[0].signer.ed25519PublicKey, arbitratorKey);
  assert.equal(ops[0].signer.weight, MULTISIG_SIGNER_WEIGHT_REMOVE);

  // 2. Restore thresholds to 2-of-2
  assert.equal(ops[1].type, 'setOptions');
  assert.equal(ops[1].medThreshold, MULTISIG_DISPUTE_RELEASED_THRESHOLDS.medThreshold);
  assert.equal(ops[1].highThreshold, MULTISIG_DISPUTE_RELEASED_THRESHOLDS.highThreshold);

  assert.throws(() => buildReleaseEscrowFreezeOperations({}), /arbitratorPublicKey is required/);
});

test('buildCloseWalletMultisigOperations removes signers and lowers thresholds to 1-1-1', () => {
  const walletKey = Keypair.random().publicKey();
  const platformKey = Keypair.random().publicKey();

  const rawOps = buildCloseWalletMultisigOperations({
    walletPublicKey: walletKey,
    platformPublicKey: platformKey,
  });

  assert.equal(rawOps.length, 3);
  const ops = rawOps.map(op => Operation.fromXDRObject(op));

  assert.equal(ops[0].signer.ed25519PublicKey, walletKey);
  assert.equal(ops[0].signer.weight, 0);
  assert.equal(ops[1].signer.ed25519PublicKey, platformKey);
  assert.equal(ops[1].signer.weight, 0);
  assert.equal(ops[2].lowThreshold, MULTISIG_CLEANUP_THRESHOLDS.lowThreshold);
  assert.equal(ops[2].medThreshold, MULTISIG_CLEANUP_THRESHOLDS.medThreshold);
  assert.equal(ops[2].highThreshold, MULTISIG_CLEANUP_THRESHOLDS.highThreshold);
});
