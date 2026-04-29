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
const logger = require('../config/logger');

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
};
