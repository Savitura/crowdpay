const {
  Contract,
  Address,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
} = require('@stellar/stellar-sdk');
const { server, networkPassphrase } = require('../config/stellar');

async function simulateAndPrepare(tx) {
  const simulation = await server.simulateTransaction(tx);
  if (xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64').v3().sorobanMeta().returnValue().type() === xdr.ScValType.scvError) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.result)}`);
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
    .setTimeout(30)
    .build();
    
  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);
  
  if (result.status === 'SUCCESS') {
     // Parse return value if needed
     const resultMetaXdr = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
     const returnValue = resultMetaXdr.v3().sorobanMeta().returnValue();
     return scValToNative(returnValue);
  }
  throw new Error(`Transaction failed: ${result.status}`);
}

/**
 * Invoke the on-chain contribution router contract.
 *
 * Enforces slippage ceiling and atomically splits dest_amount between
 * campaign_wallet and platform_wallet.
 *
 * @param {object} params
 * @param {string} params.senderSecret       - Contributor's Stellar secret key
 * @param {string} params.sendAssetAddress   - SAC address of the send asset
 * @param {string} params.sendMax            - Max source amount (stroops as string)
 * @param {string} params.destAssetAddress   - SAC address of the destination asset
 * @param {string} params.destAmount         - Exact dest amount (stroops as string)
 * @param {string[]} params.path             - Intermediate asset addresses (may be empty)
 * @param {string} params.campaignWallet     - Campaign treasury address
 * @param {string} params.platformWallet     - Platform fee recipient address
 * @param {number} params.feeBps             - Platform fee in basis points (e.g. 100 = 1%)
 * @param {number} params.maxSlippageBps     - Max slippage in basis points (e.g. 500 = 5%)
 * @returns {Promise<string>} Transaction hash
 */
async function routeContribution({
  senderSecret,
  sendAssetAddress,
  sendMax,
  destAssetAddress,
  destAmount,
  path = [],
  campaignWallet,
  platformWallet,
  feeBps,
  maxSlippageBps,
}) {
  const contractId = process.env.ROUTER_CONTRACT_ID;
  if (!contractId) throw new Error('ROUTER_CONTRACT_ID not configured');

  const pathVec = path.length > 0
    ? nativeToScVal(path.map((a) => new Address(a)))
    : nativeToScVal([], { type: 'vec' });

  const result = await invokeContract({
    contractId,
    method: 'route_contribution',
    args: [
      new Address(Keypair.fromSecret(senderSecret).publicKey()).toScVal(),
      new Address(sendAssetAddress).toScVal(),
      nativeToScVal(BigInt(sendMax),   { type: 'i128' }),
      new Address(destAssetAddress).toScVal(),
      nativeToScVal(BigInt(destAmount), { type: 'i128' }),
      pathVec,
      new Address(campaignWallet).toScVal(),
      new Address(platformWallet).toScVal(),
      nativeToScVal(feeBps,         { type: 'u32' }),
      nativeToScVal(maxSlippageBps, { type: 'u32' }),
    ],
    signerSecret: senderSecret,
  });

  return result;
}

/**
 * Encodes a milestone object for the Soroban contract.
 */
function encodeMilestone(m) {
  // Milestone structure in Rust:
  // pub struct Milestone {
  //     pub title_hash: BytesN<32>,
  //     pub release_bps: u32,
  //     pub status: MilestoneStatus,
  //     pub evidence_hash: Option<BytesN<32>>,
  // }
  
  // We use a simple hash of the title for now as title_hash
  const titleHash = Buffer.alloc(32);
  Buffer.from(require('crypto').createHash('sha256').update(m.title).digest()).copy(titleHash);

  return nativeToScVal({
    title_hash: titleHash,
    release_bps: m.release_percentage_units, // 10000 based
    status: 0, // Pending
    evidence_hash: null,
  });
}

module.exports = {
  invokeContract,
  encodeMilestone,
  nativeToScVal,
  routeContribution,
};
