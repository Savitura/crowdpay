const {
  Contract,
  Address,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  Operation,
} = require('@stellar/stellar-sdk');
const { server, networkPassphrase } = require('../config/stellar');
const logger = require('../config/logger');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');
const crypto = require('crypto');

async function simulateAndPrepare(tx) {
  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue().type() === xdr.ScValType.scvError) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.result)}`);
    }
  }
  return server.prepareTransaction(tx);
}

async function invokeContract({ contractId, method, args, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    if (result.resultMetaXdr) {
      const resultMetaXdrParsed = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const sorobanMeta = resultMetaXdrParsed.v3().sorobanMeta();
      if (sorobanMeta && sorobanMeta.returnValue()) {
        return scValToNative(sorobanMeta.returnValue());
      }
    }
    return null;
  }
  throw new Error(`Transaction failed: ${result.status}`);
}

async function invokeContractReadOnly({ contractId, method, args }) {
  const source = await server.loadAccount(
    Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey()
  );

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue()) {
      if (sorobanMeta.returnValue().type() === xdr.ScValType.scvError) {
        throw new Error(`Simulation returned error: ${JSON.stringify(simulation.result)}`);
      }
      return scValToNative(sorobanMeta.returnValue());
    }
  }
  throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
}

async function initializeEscrow({
  contractId,
  adminAddress,
  campaignId,
  target,
  deadline,
  assetContractAddress,
  platformFeeBps,
  platformFeeRecipientAddress,
  signerSecret,
}) {
  return invokeContract({
    contractId,
    method: 'initialize',
    args: [
      nativeToScVal(Address.fromString(adminAddress), { type: 'address' }),
      nativeToScVal(campaignId, { type: 'u64' }),
      nativeToScVal(target, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
      nativeToScVal(Address.fromString(assetContractAddress), { type: 'address' }),
      nativeToScVal(platformFeeBps, { type: 'u32' }),
      nativeToScVal(Address.fromString(platformFeeRecipientAddress), { type: 'address' }),
    ],
    signerSecret,
  });
}

async function initializeMilestones({
  contractId,
  creatorAddress,
  platformAddress,
  escrowContractId,
  milestones,
  signerSecret,
}) {
  const milestoneScVals = milestones.map((m) => {
    const titleHash = Buffer.alloc(32);
    Buffer.from(crypto.createHash('sha256').update(m.title).digest()).copy(titleHash);
    return nativeToScVal({
      title_hash: titleHash,
      release_bps: m.release_percentage_units || Math.round(parseFloat(m.release_percentage) * 100),
      status: 0,
      evidence_hash: null,
    });
  });

  return invokeContract({
    contractId,
    method: 'initialize',
    args: [
      nativeToScVal(Address.fromString(creatorAddress), { type: 'address' }),
      nativeToScVal(Address.fromString(platformAddress), { type: 'address' }),
      nativeToScVal(Address.fromString(escrowContractId), { type: 'address' }),
      nativeToScVal(milestoneScVals),
    ],
    signerSecret,
  });
}

async function depositToEscrow({ contractId, fromAddress, amount, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'deposit',
    args: [
      nativeToScVal(Address.fromString(fromAddress), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ],
    signerSecret,
  });
}

async function requestRefund({ contractId, contributorAddress, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'refund',
    args: [
      nativeToScVal(Address.fromString(contributorAddress), { type: 'address' }),
    ],
    signerSecret,
  });
}

async function getEscrowTotalRaised(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_total_raised',
    args: [],
  });
}

async function getEscrowAsset(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_asset',
    args: [],
  });
}

async function getEscrowPlatformFeeConfig(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_platform_fee_config',
    args: [],
  });
}

function encodeMilestone(m) {
  const titleHash = Buffer.alloc(32);
  Buffer.from(crypto.createHash('sha256').update(m.title).digest()).copy(titleHash);

  return nativeToScVal({
    title_hash: titleHash,
    release_bps: m.release_percentage_units ||
      Math.round(parseFloat(m.release_percentage || m.release_percentage_units || 0) * 100),
    status: 0,
    evidence_hash: null,
  });
}

function scvAddressFromString(addressString) {
  return nativeToScVal(Address.fromString(addressString), { type: 'address' });
}

async function createContractFromWasmHash({ wasmHash, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.createContract(wasmHash))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(signer);
  const result = await server.submitTransaction(tx);

  if (result.status === 'SUCCESS') {
    if (result.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const created = meta.v3().sorobanMeta().createdContracts();
      if (created && created.length > 0) {
        return created[0].contractId().toString('hex');
      }
    }
  }
  throw new Error(`Contract creation failed: ${result.status}`);
}

async function uploadContractWasm(wasmBuffer, signerSecret) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.uploadContractWasm(wasmBuffer))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    if (result.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const retVal = meta.v3().sorobanMeta().returnValue();
      return scValToNative(retVal);
    }
  }
  throw new Error(`WASM upload failed: ${result.status}`);
}

async function refund(contractId, contributorPublicKey) {
  return invokeContract({
    contractId,
    method: 'refund',
    args: [nativeToScVal(Address.fromString(contributorPublicKey), { type: 'address' })],
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });
}

/**
 * Deploy and initialize both escrow and milestones contracts for a campaign.
 * Uses pre-deployed contract IDs from env when set, otherwise deploys new instances.
 * Falls back to mock IDs if SOROBAN_ENABLED is not true.
 */
async function deployCampaignContracts({
  creatorPublicKey,
  platformPublicKey,
  campaignId,
  targetAmount,
  deadlineUnix,
  assetContractAddress,
  platformFeeBps,
  milestones,
  signerSecret,
}) {
  const envEscrowId = process.env.ESCROW_CONTRACT_ID || null;
  const envMilestonesId = process.env.MILESTONES_CONTRACT_ID || null;

  if (envEscrowId || envMilestonesId) {
    if (envEscrowId) {
      await initializeEscrow({
        contractId: envEscrowId,
        adminAddress: creatorPublicKey,
        campaignId,
        target: targetAmount,
        deadline: deadlineUnix,
        assetContractAddress,
        platformFeeBps,
        platformFeeRecipientAddress: platformPublicKey,
        signerSecret,
      });
    }

    if (envMilestonesId && milestones && milestones.length) {
      await initializeMilestones({
        contractId: envMilestonesId,
        creatorAddress: creatorPublicKey,
        platformAddress: platformPublicKey,
        escrowContractId: envEscrowId,
        milestones,
        signerSecret,
      });
    }

    return { escrowContractId: envEscrowId, milestonesContractId: envMilestonesId };
  }

  const sorobanEnabled = process.env.SOROBAN_ENABLED === 'true';
  const escrowWasmHash = process.env.ESCOW_WASM_HASH;
  const milestonesWasmHash = process.env.MILESTONES_WASM_HASH;

  if (!sorobanEnabled) {
    const mockEscrowId = 'C' + crypto.randomBytes(24).toString('hex').toUpperCase();
    const mockMilestonesId = 'C' + crypto.randomBytes(24).toString('hex').toUpperCase();
    logger.info('Soroban disabled, using mock contract IDs', {
      mockEscrowId,
      mockMilestonesId,
    });
    return { escrowContractId: mockEscrowId, milestonesContractId: mockMilestonesId };
  }

  if (!escrowWasmHash || !milestonesWasmHash) {
    throw new Error(
      'SOROBAN_ENABLED is true but ESCROW_WASM_HASH or MILESTONES_WASM_HASH is not configured'
    );
  }

  try {
    logger.info('Deploying escrow contract instance...');
    const escrowContractId = await createContractFromWasmHash({
      wasmHash: escrowWasmHash,
      signerSecret,
    });

    logger.info('Deploying milestones contract instance...');
    const milestonesContractId = await createContractFromWasmHash({
      wasmHash: milestonesWasmHash,
      signerSecret,
    });

    logger.info('Initializing escrow contract...');
    await initializeEscrow({
      contractId: escrowContractId,
      adminAddress: milestonesContractId,
      campaignId: parseInt(campaignId.replace(/-/g, '').slice(0, 8), 16) || 1,
      target: targetAmount,
      deadline: deadlineUnix,
      assetContractAddress,
      platformFeeBps,
      platformFeeRecipientAddress: platformPublicKey,
      signerSecret,
    });

    logger.info('Initializing milestones contract...');
    await initializeMilestones({
      contractId: milestonesContractId,
      creatorAddress: creatorPublicKey,
      platformAddress: platformPublicKey,
      escrowContractId,
      milestones,
      signerSecret,
    });

    return { escrowContractId, milestonesContractId };
  } catch (err) {
    logger.error('Soroban contract deployment failed', { error: err.message });
    throw new Error(`Soroban contract deployment failed: ${err.message}`);
  }
}

async function submitMilestone({ contractId, creatorAddress, title, releaseBps, signerSecret }) {
  const titleHash = Buffer.alloc(32);
  Buffer.from(crypto.createHash('sha256').update(title).digest()).copy(titleHash);

  return invokeContract({
    contractId,
    method: 'submit_milestone',
    args: [
      nativeToScVal(Address.fromString(creatorAddress), { type: 'address' }),
      nativeToScVal(titleHash, { type: 'bytes' }),
      nativeToScVal(releaseBps, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function approveMilestone({ contractId, milestoneIndex, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'approve_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function rejectMilestone({ contractId, milestoneIndex, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'reject_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function getMilestone(contractId, milestoneIndex) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
  });
}

async function getAllMilestones(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_all_milestones',
    args: [],
  });
}

const MILESTONE_STATUS_LABELS = {
  0: 'pending',
  1: 'submitted',
  2: 'released',
  3: 'rejected',
};

function mapMilestoneOnChainStatus(statusValue) {
  if (statusValue && typeof statusValue === 'object' && 'tag' in statusValue) {
    const tag = String(statusValue.tag).toLowerCase();
    if (tag.includes('approved')) return 'released';
    if (tag.includes('submitted')) return 'submitted';
    if (tag.includes('rejected')) return 'rejected';
    return 'pending';
  }
  return MILESTONE_STATUS_LABELS[Number(statusValue)] || 'pending';
}

/**
 * Deploy and initialize Soroban contracts for a campaign.
 * Returns the primary contract address (escrow) plus milestones contract ID.
 */
async function initializeCampaignContract({
  campaignId,
  creator,
  goal,
  deadline,
  milestones,
  platformPublicKey,
  assetContractAddress,
  platformFeeBps = 0,
  signerSecret,
}) {
  const { escrowContractId, milestonesContractId } = await deployCampaignContracts({
    creatorPublicKey: creator,
    platformPublicKey,
    campaignId,
    targetAmount: goal,
    deadlineUnix: deadline,
    assetContractAddress,
    platformFeeBps,
    milestones,
    signerSecret,
  });

  return {
    contractAddress: escrowContractId,
    escrowContractId,
    milestonesContractId,
  };
}

/**
 * Release a milestone on-chain via the milestones contract.
 */
async function releaseMilestone({ milestonesContractId, milestoneIndex, signerSecret }) {
  if (!milestonesContractId) {
    throw new Error('Campaign does not have a milestones contract deployed');
  }

  try {
    return await approveMilestone({
      contractId: milestonesContractId,
      milestoneIndex,
      signerSecret,
    });
  } catch (err) {
    throw new Error(`On-chain milestone release failed: ${err.message}`);
  }
}

/**
 * Trigger an on-chain refund for a contributor via the escrow contract.
 */
async function triggerRefund({ escrowContractId, contributorAddress, signerSecret }) {
  if (!escrowContractId) {
    throw new Error('Campaign does not have an escrow contract deployed');
  }

  try {
    return await requestRefund({
      contractId: escrowContractId,
      contributorAddress,
      signerSecret,
    });
  } catch (err) {
    throw new Error(`On-chain refund failed: ${err.message}`);
  }
}

/**
 * Read on-chain campaign status from deployed Soroban contracts.
 */
async function getContractStatus({
  escrowContractId,
  milestonesContractId,
  deadlineUnix,
  targetAmount,
}) {
  const result = {
    status: 'unknown',
    totalRaised: 0,
    milestones: [],
  };

  if (!escrowContractId && !milestonesContractId) {
    return result;
  }

  if (escrowContractId) {
    result.totalRaised = Number(await getEscrowTotalRaised(escrowContractId)) || 0;
    const target = Number(targetAmount) || 0;
    const now = Math.floor(Date.now() / 1000);

    if (target > 0 && result.totalRaised >= target) {
      result.status = 'funded';
    } else if (deadlineUnix && now >= deadlineUnix) {
      result.status = 'failed';
    } else {
      result.status = 'active';
    }
  }

  if (milestonesContractId) {
    const onChainMilestones = await getAllMilestones(milestonesContractId);
    const items = Array.isArray(onChainMilestones) ? onChainMilestones : [];
    result.milestones = items.map((milestone, index) => ({
      index,
      on_chain_status: mapMilestoneOnChainStatus(milestone?.status),
      released: mapMilestoneOnChainStatus(milestone?.status) === 'released',
    }));
  }

  return result;
}

module.exports = {
  invokeContract,
  invokeContractReadOnly,
  initializeEscrow,
  initializeMilestones,
  depositToEscrow,
  requestRefund,
  getEscrowTotalRaised,
  getEscrowAsset,
  getEscrowPlatformFeeConfig,
  createContractFromWasmHash,
  uploadContractWasm,
  deployCampaignContracts,
  encodeMilestone,
  scvAddressFromString,
  nativeToScVal,
  submitMilestone,
  approveMilestone,
  rejectMilestone,
  getMilestone,
  getAllMilestones,
  initializeCampaignContract,
  releaseMilestone,
  triggerRefund,
  getContractStatus,
  mapMilestoneOnChainStatus,
  refund,
};
