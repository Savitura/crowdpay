import React, { useEffect, useState, useCallback } from 'react';
import {
  getNetwork,
  isConnected as isFreighterConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';

const SEND_OPTIONS = [
  { value: 'XLM', label: 'XLM', hint: 'Native Stellar' },
  { value: 'USDC', label: 'USDC', hint: 'Stable dollar' },
];

function friendlyQuoteError(err) {
  if (err.status === 404) {
    return 'No conversion path is available for this pair right now. Try the campaign’s asset or a different amount.';
  }
  return err.message || 'Could not load a quote.';
}

function friendlyContributeError(err) {
  if (err.status === 422) {
    return err.message || 'Conversion failed. Try another amount or asset.';
  }
  if (err.status === 404) {
    return 'Campaign not found or no longer active.';
  }
  if (err.status === 400) {
    return err.message || 'Check your amount and asset selection.';
  }
  return err.message || 'Payment could not be submitted. Try again.';
}

function friendlyFreighterError(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  if (typeof err.error === 'string') return err.error;
  if (err.error && typeof err.error.message === 'string') return err.error.message;
  return fallback;
}

export default function ContributeModal({ campaign, onClose, onSuccess }) {
  const { token } = useAuth();
  const [amount, setAmount] = useState('');
  const [sendAsset, setSendAsset] = useState(campaign.asset_type);
  const [paymentMethod, setPaymentMethod] = useState('custodial');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Submitting…');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState('form');
  const [result, setResult] = useState(null);
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [freighterChecked, setFreighterChecked] = useState(false);

  const isPathPayment = sendAsset !== campaign.asset_type;
  const destAmount = amount.trim();

  const fetchQuote = useCallback(async () => {
    if (!isPathPayment || !destAmount || Number(destAmount) <= 0) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const q = await api.quoteContribution(
        {
          send_asset: sendAsset,
          dest_asset: campaign.asset_type,
          dest_amount: destAmount,
        },
        token
      );
      setQuote(q);
    } catch (err) {
      setQuote(null);
      setQuoteError(friendlyQuoteError(err));
    } finally {
      setQuoteLoading(false);
    }
  }, [isPathPayment, destAmount, sendAsset, campaign.asset_type, token]);

  useEffect(() => {
    if (!isPathPayment) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    const t = setTimeout(() => {
      fetchQuote();
    }, 450);
    return () => clearTimeout(t);
  }, [fetchQuote, isPathPayment]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const connection = await isFreighterConnected();
        if (active) {
          setFreighterAvailable(Boolean(connection?.isConnected));
        }
      } catch {
        if (active) {
          setFreighterAvailable(false);
        }
      } finally {
        if (active) {
          setFreighterChecked(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  async function submitWithCustodial() {
    setLoadingLabel('Submitting with CrowdPay wallet…');
    return api.contribute(
      { campaign_id: campaign.id, amount: destAmount, send_asset: sendAsset },
      token
    );
  }

  async function submitWithFreighter() {
    setLoadingLabel('Connecting to Freighter…');
    const access = await requestAccess();
    if (access?.error) {
      throw new Error(friendlyFreighterError(access.error, 'Could not connect to Freighter.'));
    }
    const signerAddress = access?.address;
    if (!signerAddress) {
      throw new Error('Freighter did not return a Stellar account.');
    }

    setLoadingLabel('Preparing transaction…');
    const prepared = await api.prepareContribution(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        send_asset: sendAsset,
        sender_public_key: signerAddress,
      },
      token
    );

    setLoadingLabel('Checking Freighter network…');
    const network = await getNetwork();
    if (network?.error) {
      throw new Error(friendlyFreighterError(network.error, 'Could not read Freighter network.'));
    }
    if (network?.networkPassphrase !== prepared.network_passphrase) {
      const current = network?.network || 'another network';
      throw new Error(`Freighter is connected to ${current}. Switch it to ${prepared.network_name} and try again.`);
    }

    setLoadingLabel('Waiting for signature…');
    const signed = await signTransaction(prepared.unsigned_xdr, {
      networkPassphrase: prepared.network_passphrase,
      address: signerAddress,
    });
    if (signed?.error) {
      throw new Error(friendlyFreighterError(signed.error, 'Freighter could not sign this transaction.'));
    }
    if (!signed?.signedTxXdr) {
      throw new Error('Freighter did not return a signed transaction.');
    }

    setLoadingLabel('Submitting signed transaction…');
    return api.submitSignedContribution(
      {
        prepare_token: prepared.prepare_token,
        signed_xdr: signed.signedTxXdr,
      },
      token
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!destAmount || Number(destAmount) <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    setLoading(true);
    setLoadingLabel('Submitting…');
    setError('');
    try {
      const data =
        paymentMethod === 'freighter'
          ? await submitWithFreighter()
          : await submitWithCustodial();
      setResult(data);
      setPhase('success');
      onSuccess();
    } catch (err) {
      setError(
        paymentMethod === 'freighter'
          ? friendlyFreighterError(err, 'Freighter payment could not be submitted. Try again.')
          : friendlyContributeError(err)
      );
    } finally {
      setLoading(false);
      setLoadingLabel('Submitting…');
    }
  }

  function handleClose() {
    onClose();
  }

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={handleClose} role="presentation">
      <div
        className="modal-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contribute-title"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'form' ? (
          <>
            <h2 id="contribute-title" style={styles.title}>
              Support this campaign
            </h2>
            <p style={styles.subtitle}>
              Goal currency: <strong>{campaign.asset_type}</strong>. You choose what you send; the campaign receives
              the amount below in <strong>{campaign.asset_type}</strong>.
            </p>

            <form onSubmit={handleSubmit}>
              <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                  Payment method
                </legend>
                <div className="asset-picker" role="radiogroup" aria-label="Contribution payment method">
                  <label
                    className={`asset-picker__option${paymentMethod === 'custodial' ? ' asset-picker__option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="payment_method"
                      value="custodial"
                      checked={paymentMethod === 'custodial'}
                      onChange={() => setPaymentMethod('custodial')}
                    />
                    <div className="asset-picker__code">CrowdPay wallet</div>
                    <div className="asset-picker__hint">Uses your existing custodial balance</div>
                  </label>
                  {freighterAvailable && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'freighter' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="freighter"
                        checked={paymentMethod === 'freighter'}
                        onChange={() => setPaymentMethod('freighter')}
                      />
                      <div className="asset-picker__code">Pay with Freighter</div>
                      <div className="asset-picker__hint">You sign in-browser; CrowdPay never sees your key</div>
                    </label>
                  )}
                </div>
                {freighterChecked && !freighterAvailable && (
                  <span id="contrib-wallet-help" style={styles.help}>
                    Freighter extension not detected. Install it to contribute from your own Stellar wallet.
                  </span>
                )}
              </fieldset>

              <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                  Pay with
                </legend>
                <div className="asset-picker" role="radiogroup" aria-label="Asset to send">
                  {SEND_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      className={`asset-picker__option${sendAsset === opt.value ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="send_asset"
                        value={opt.value}
                        checked={sendAsset === opt.value}
                        onChange={() => setSendAsset(opt.value)}
                      />
                      <div className="asset-picker__code">{opt.label}</div>
                      <div className="asset-picker__hint">{opt.hint}</div>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="form-stack" style={{ marginBottom: '0.25rem' }}>
                <label className="label-strong" htmlFor="contrib-amount">
                  Amount campaign receives ({campaign.asset_type})
                </label>
                <input
                  id="contrib-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.0000001"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby="contrib-amount-help"
                />
                <span id="contrib-amount-help" style={styles.help}>
                  This is the credited amount toward the campaign goal, in {campaign.asset_type}.
                </span>
              </div>

              {isPathPayment && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Cross-asset payment.</strong> Stellar will convert from {sendAsset} to {campaign.asset_type}{' '}
                  when you confirm. Estimated fees are tiny; conversion uses the network DEX.
                </div>
              )}

              {paymentMethod === 'freighter' && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Non-custodial payment.</strong> CrowdPay will prepare the transaction, Freighter will ask you
                  to sign it locally, and only the signed XDR comes back for submission.
                </div>
              )}

              {isPathPayment && destAmount && Number(destAmount) > 0 && (
                <div style={{ marginTop: '0.85rem', minHeight: '3.5rem' }}>
                  {quoteLoading && <p style={{ fontSize: '0.85rem', color: '#666' }}>Fetching live quote…</p>}
                  {!quoteLoading && quote && (
                    <div className="alert alert--success" role="status">
                      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Estimated from your wallet</div>
                      <div style={{ fontSize: '0.875rem', lineHeight: 1.45 }}>
                        Up to <strong>{quote.max_send_amount}</strong> {sendAsset} (includes a small slippage buffer).
                        {Array.isArray(quote.path) && quote.path.length > 0 && (
                          <>
                            {' '}
                            Route: {sendAsset} → {quote.path.join(' → ')} → {campaign.asset_type}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {!quoteLoading && quoteError && (
                    <p className="alert alert--error" role="alert">
                      {quoteError}
                    </p>
                  )}
                </div>
              )}

              {error && (
                <p className="alert alert--error" style={{ marginTop: '0.85rem' }} role="alert">
                  {error}
                </p>
              )}

              <div style={styles.actions}>
                <button type="button" className="btn-secondary" onClick={handleClose}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading || (isPathPayment && (quoteLoading || !!quoteError || !quote))}
                >
                  {loading ? loadingLabel : paymentMethod === 'freighter' ? 'Review in Freighter' : 'Confirm payment'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Payment submitted
            </h2>
            <p className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
              Your contribution is on its way. It usually confirms in a few seconds on Stellar.
            </p>
            {result?.tx_hash && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem', wordBreak: 'break-all' }}>
                <strong>Transaction</strong>{' '}
                <a
                  href={stellarExpertTxUrl(result.tx_hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#7c3aed', fontWeight: 600 }}
                >
                  View on Stellar Expert
                </a>
              </p>
            )}
            {result?.conversion_quote && (
              <div className="alert alert--info" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                <strong>Conversion summary:</strong> up to {result.conversion_quote.max_send_amount}{' '}
                {result.conversion_quote.send_asset} authorized for{' '}
                {result.conversion_quote.campaign_amount} {result.conversion_quote.campaign_asset} received.
              </div>
            )}
            <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={handleClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '0.75rem',
  },
  title: { fontSize: '1.2rem', fontWeight: 800, marginBottom: '0.5rem', color: '#111' },
  subtitle: { color: '#555', fontSize: '0.875rem', lineHeight: 1.55, marginBottom: '1.1rem' },
  help: { fontSize: '0.78rem', color: '#777', marginTop: '0.2rem' },
  actions: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '0.65rem',
    justifyContent: 'stretch',
    marginTop: '1.1rem',
  },
};
