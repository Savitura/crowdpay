function getStellarExpertTxUrl(txHash) {
  const network = process.env.STELLAR_NETWORK || "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

module.exports = { getStellarExpertTxUrl };
