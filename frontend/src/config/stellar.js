const network = import.meta.env.VITE_STELLAR_NETWORK || 'testnet';

const HORIZON_URLS = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

export function stellarNetwork() {
  return network === 'public' || network === 'mainnet' ? 'public' : 'testnet';
}

export function stellarExpertTxUrl(hash, networkOverride) {
  if (!hash) return '#';
  const resolvedNetwork =
    networkOverride === 'public' || networkOverride === 'mainnet'
      ? 'public'
      : networkOverride === 'testnet'
        ? 'testnet'
        : stellarNetwork();
  return `https://stellar.expert/explorer/${resolvedNetwork}/tx/${hash}`;
}

export function stellarExpertAccountUrl(publicKey, networkOverride) {
  if (!publicKey) return '#';
  const resolvedNetwork =
    networkOverride === 'public' || networkOverride === 'mainnet'
      ? 'public'
      : networkOverride === 'testnet'
        ? 'testnet'
        : stellarNetwork();
  return `https://stellar.expert/explorer/${resolvedNetwork}/account/${publicKey}`;
}

export function stellarExpertContractUrl(contractId, networkOverride) {
  if (!contractId) return '#';
  const resolvedNetwork =
    networkOverride === 'public' || networkOverride === 'mainnet'
      ? 'public'
      : networkOverride === 'testnet'
        ? 'testnet'
        : stellarNetwork();
  return `https://stellar.expert/explorer/${resolvedNetwork}/contract/${contractId}`;
}

export function horizonTxUrl(hash, networkOverride) {
  if (!hash) return '#';
  const resolvedNetwork =
    networkOverride === 'public' || networkOverride === 'mainnet'
      ? 'public'
      : networkOverride === 'testnet'
        ? 'testnet'
        : stellarNetwork();
  const baseUrl = HORIZON_URLS[resolvedNetwork] || HORIZON_URLS.testnet;
  return `${baseUrl}/transactions/${hash}`;
}
