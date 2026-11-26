import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import {
  horizonTxUrl,
  stellarExpertAccountUrl,
  stellarExpertTxUrl,
} from '../config/stellar';

function downloadBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function shortenAddress(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function TaxReceipts() {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api
      .getTaxReceipts()
      .then((data) => {
        if (active) setReceipts(data.receipts || []);
      })
      .catch((err) => {
        if (active) setError(err.message || 'Could not load tax receipts');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function downloadAll() {
    setDownloading('all');
    setError('');
    try {
      downloadBlob(await api.downloadTaxReceiptsPdf());
    } catch (err) {
      setError(err.message || 'Could not download receipts');
    } finally {
      setDownloading('');
    }
  }

  async function downloadOne(id) {
    setDownloading(id);
    setError('');
    try {
      downloadBlob(await api.downloadTaxReceiptPdf(id));
    } catch (err) {
      setError(err.message || 'Could not download receipt');
    } finally {
      setDownloading('');
    }
  }

  async function copyTxHash(id, txHash) {
    if (!txHash || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedId(id);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
  }

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0 }}>Tax receipts</h1>
          <p style={{ color: 'var(--color-text-secondary)', margin: '0.35rem 0 0' }}>
            Download contributor receipts with verifiable Stellar transaction references.
          </p>
        </div>
        {receipts.length > 0 && (
          <button
            type="button"
            className="btn-primary"
            disabled={downloading === 'all'}
            onClick={downloadAll}
          >
            {downloading === 'all' ? 'Preparing...' : 'Download all PDFs'}
          </button>
        )}
      </div>

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading receipts...</p>
      ) : receipts.length === 0 ? (
        <p className="alert alert--info">
          No contribution receipts are available yet.{' '}
          <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
            Browse campaigns
          </Link>
          .
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {receipts.map((receipt) => {
            const verification = receipt.verification || {};
            const network =
              verification.network || receipt.stellar_network || 'testnet';
            const txHash = verification.tx_hash || receipt.tx_hash;
            const explorerUrl =
              verification.explorer_url ||
              receipt.explorer_url ||
              stellarExpertTxUrl(txHash, network);
            const horizonUrl =
              verification.horizon_tx_url ||
              receipt.horizon_tx_url ||
              horizonTxUrl(txHash, network);
            const memo = verification.memo || receipt.memo;
            const ledgerSeq =
              verification.ledger_sequence ?? receipt.ledger_sequence ?? null;
            const senderWallet =
              verification.sender_public_key || receipt.sender_public_key;
            const destinationWallet =
              verification.destination_public_key || receipt.destination_public_key;

            return (
              <article key={receipt.id} className="campaign-card" style={{ minHeight: 'auto' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: 1, minWidth: '240px' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <Link
                        to={`/campaigns/${receipt.campaign_id}`}
                        style={{ color: 'var(--color-accent)', fontWeight: 700 }}
                      >
                        {receipt.campaign_title}
                      </Link>
                      {txHash && (
                        <span
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            padding: '0.12rem 0.45rem',
                            borderRadius: '999px',
                            background: 'var(--color-border-lighter)',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          Stellar {network}
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        marginTop: '0.35rem',
                        color: 'var(--color-text-primary)',
                        fontWeight: 600,
                      }}
                    >
                      {Number(receipt.amount).toLocaleString()} {receipt.asset}
                    </div>
                    <div style={{ fontSize: '0.84rem', color: 'var(--color-text-secondary)' }}>
                      {new Date(receipt.created_at).toLocaleString()} | {receipt.campaign_status}
                      {receipt.id ? ` | Receipt #${receipt.id}` : ''}
                    </div>

                    {txHash && (
                      <section
                        aria-label={`Stellar verification reference for receipt ${receipt.id}`}
                        style={{
                          marginTop: '0.6rem',
                          padding: '0.6rem 0.75rem',
                          borderRadius: '8px',
                          background: 'var(--color-surface-subtle, rgba(0, 0, 0, 0.03))',
                          fontSize: '0.82rem',
                          display: 'grid',
                          gap: '0.28rem',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            flexWrap: 'wrap',
                          }}
                        >
                          <strong>Stellar Tx Hash:</strong>
                          <code
                            style={{
                              wordBreak: 'break-all',
                              fontSize: '0.78rem',
                            }}
                          >
                            {txHash}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyTxHash(receipt.id, txHash)}
                            aria-label={`Copy transaction hash for receipt ${receipt.id}`}
                            style={{
                              fontSize: '0.74rem',
                              padding: '0.15rem 0.45rem',
                            }}
                          >
                            {copiedId === receipt.id ? 'Copied' : 'Copy hash'}
                          </button>
                        </div>

                        {(memo || ledgerSeq !== null) && (
                          <div
                            style={{
                              display: 'flex',
                              gap: '1rem',
                              flexWrap: 'wrap',
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            {memo && (
                              <span>
                                <strong>Memo:</strong> <code>{memo}</code>
                              </span>
                            )}
                            {ledgerSeq !== null && (
                              <span>
                                <strong>Ledger:</strong> #{ledgerSeq}
                              </span>
                            )}
                          </div>
                        )}

                        {(senderWallet || destinationWallet) && (
                          <div
                            style={{
                              display: 'flex',
                              gap: '1rem',
                              flexWrap: 'wrap',
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            {senderWallet && (
                              <span>
                                <strong>Sender:</strong>{' '}
                                <a
                                  href={stellarExpertAccountUrl(senderWallet, network)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={senderWallet}
                                  style={{ color: 'var(--color-accent)' }}
                                >
                                  {shortenAddress(senderWallet)}
                                </a>
                              </span>
                            )}
                            {destinationWallet && (
                              <span>
                                <strong>Destination:</strong>{' '}
                                <a
                                  href={stellarExpertAccountUrl(destinationWallet, network)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={destinationWallet}
                                  style={{ color: 'var(--color-accent)' }}
                                >
                                  {shortenAddress(destinationWallet)}
                                </a>
                              </span>
                            )}
                          </div>
                        )}

                        <div
                          style={{
                            display: 'flex',
                            gap: '0.85rem',
                            flexWrap: 'wrap',
                            marginTop: '0.2rem',
                          }}
                        >
                          <a
                            href={explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                          >
                            View transaction
                          </a>
                          <a
                            href={horizonUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--color-accent)' }}
                          >
                            Verify on Horizon API
                          </a>
                        </div>
                      </section>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={downloading === receipt.id}
                    onClick={() => downloadOne(receipt.id)}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {downloading === receipt.id ? 'Preparing...' : 'Download PDF'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
