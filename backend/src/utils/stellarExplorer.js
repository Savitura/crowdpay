const VALID_NETWORKS = ['testnet', 'public'];

function getStellarExpertTxUrl(txHash) {
  const network = process.env.STELLAR_NETWORK || 'testnet';
  const resolvedNetwork = VALID_NETWORKS.includes(network) ? network : 'testnet';
  return `https://stellar.expert/explorer/${resolvedNetwork}/tx/${encodeURIComponent(txHash)}`;
}

module.exports = { getStellarExpertTxUrl };
