import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  const [anchorInfo, setAnchorInfo] = useState({ anchors: [] });
  const [selectedAnchorId, setSelectedAnchorId] = useState('');
  const [anchorSession, setAnchorSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Submitting…');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState('form');
  const [result, setResult] = useState(null);
  const [feeBps, setFeeBps] = useState(0);

  useEffect(() => {
    api.getPlatformConfig().then((cfg) => setFeeBps(cfg.platform_fee_bps || 0)).catch(() => {});
  }, []);
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [freighterChecked, setFreighterChecked] = useState(false);
  const [existingContributions, setExistingContributions] = useState([]);
  const [displayName, setDisplayName] = useState('');
  const [tiers, setTiers] = useState([]);
  const [unlockedTier, setUnlockedTier] = useState(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizedData, setFinalizedData] = useState(null);
  const anchorPopupRef = useRef(null);

  useEffect(() => {
    if (campaign?.id) {
      api.getContributions(campaign.id)
        .then(setExistingContributions)
        .catch(() => setExistingContributions([]));
      api.getCampaignTiers(campaign.id)
        .then(setTiers)
        .catch(() => setTiers([]));
    }
  }, [campaign?.id]);

  const selectedAnchor = anchorInfo.anchors.find((anchor) => anchor.id === selectedAnchorId) || null;
  const effectiveSendAsset =
    paymentMethod === 'anchor' ? selectedAnchor?.asset?.code || campaign.asset_type : sendAsset;
  const isPathPayment = effectiveSendAsset !== campaign.asset_type;
  const destAmount = amount.trim();

  const fetchQuote = useCallback(async () => {
    if (!isPathPayment || !effectiveSendAsset || !destAmount || Number(destAmount) <= 0) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const q = await api.quoteContribution(
        {
          send_asset: effectiveSendAsset,
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
  }, [isPathPayment, destAmount, effectiveSendAsset, campaign.asset_type, token]);

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

  useEffect(() => {
    let active = true;
    api
      .getAnchorInfo()
      .then((info) => {
        if (!active) return;
        setAnchorInfo(info || { anchors: [] });
        const firstAvailable = (info?.anchors || []).find((anchor) => anchor.available);
        if (firstAvailable) {
          setSelectedAnchorId(firstAvailable.id);
        }
      })
      .catch(() => {
        if (active) {
          setAnchorInfo({ anchors: [] });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'anchor' || !anchorSession?.id) return undefined;
    let stopped = false;

    const closePopup = () => {
      if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
    };

    const poll = async () => {
      try {
        const next = await api.getAnchorDepositStatus(anchorSession.id, token);
        if (stopped) return;
        setAnchorSession(next);
        if (next.contribution_tx_hash) {
          setResult({
            tx_hash: next.contribution_tx_hash,
            conversion_quote: next.conversion_quote,
            anchor_transaction_id: next.anchor_transaction_id,
            anchor_id: next.anchor_id,
          });
          setPhase('success');
          closePopup();
          onSuccess();
          return;
        }
        if (next.status === 'failed') {
          setError(next.last_error || 'The anchor deposit could not be completed.');
          setPhase('form');
          closePopup();
        }
      } catch (err) {
        if (!stopped) {
          setError(err.message || 'Could not refresh the anchor deposit status.');
        }
      }
    };

    poll();
    const intervalId = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [anchorSession?.id, onSuccess, phase, token]);

  async function submitWithCustodial() {
    setLoadingLabel('Submitting with CrowdPay wallet…');
    return api.contribute(
      { campaign_id: campaign.id, amount: destAmount, send_asset: sendAsset, display_name: displayName.trim() || undefined },
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
        amount: destAmount,
        send_asset: sendAsset,
        sender_public_key: signerAddress,
        display_name: displayName.trim() || undefined,
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

  async function submitWithAnchor() {
    if (!selectedAnchorId) {
      throw new Error('No deposit anchor is available right now.');
    }

    const popup = window.open('', 'crowdpay-anchor-deposit', 'popup,width=520,height=780');
    anchorPopupRef.current = popup;

    setLoadingLabel('Preparing deposit flow…');
    const session = await api.startAnchorDeposit(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        anchor_id: selectedAnchorId,
      },
      token
    );

    if (popup && !popup.closed) {
      popup.location.href = session.interactive_url;
    } else {
      window.open(session.interactive_url, '_blank', 'noopener,noreferrer');
    }

    setAnchorSession(session);
    setPhase('anchor');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!destAmount || Number(destAmount) <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    const amountNum = Number(destAmount);
    if (campaign.min_contribution && amountNum < Number(campaign.min_contribution)) {
      setError(`Contribution amount is below the minimum limit of ${campaign.min_contribution} ${campaign.asset_type}.`);
      return;
    }
    if (campaign.max_contribution) {
      const existingSum = existingContributions
        .filter((c) => c.sender_public_key === user?.wallet_public_key)
        .reduce((sum, c) => sum + Number(c.amount), 0);

      if (existingSum + amountNum > Number(campaign.max_contribution)) {
        setError(`Contribution violates the maximum limit of ${campaign.max_contribution} ${campaign.asset_type} per backer.`);
        return;
      }
    }
    setLoading(true);
    setLoadingLabel('Submitting…');
    setError('');
    try {
      const data =
        paymentMethod === 'anchor'
          ? await submitWithAnchor()
          : paymentMethod === 'freighter'
          ? await submitWithFreighter()
          : await submitWithCustodial();
      if (paymentMethod === 'anchor') return;
      setResult(data);
      if (data.tx_hash) {
        setPhase('finalizing');
        startFinalizationPolling(data.tx_hash);
      } else {
        setPhase('success');
        onSuccess();
      }
    } catch (err) {
      if (paymentMethod === 'anchor' && anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
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

  async function startFinalizationPolling(txHash) {
    setFinalizing(true);
    let attempts = 0;
    const maxAttempts = 15;
    const interval = 2000;

    const poll = async () => {
      try {
        const data = await api.getContributionFinalization(txHash, token);
        if (data.finalization_status === 'finalized') {
          setFinalizedData(data);
          setFinalizing(false);
          setPhase('success');
          onSuccess();
          return;
        }
        if (data.finalization_status === 'failed') {
          setFinalizing(false);
          setPhase('success'); // Still show success for submission, but maybe a note
          onSuccess();
          return;
        }
      } catch (err) {
        console.error('Finalization poll error', err);
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        setTimeout(poll, interval);
      } else {
        setFinalizing(false);
        setPhase('success');
        onSuccess();
      }
    };

    setTimeout(poll, interval);
  }

  const qualifyingTier = [...tiers]
    .sort((a, b) => Number(b.min_amount) - Number(a.min_amount))
    .find((t) => Number(amount) >= Number(t.min_amount) && (t.limit === null || t.claimed_count < t.limit));

  function handleClose() {
    if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
      anchorPopupRef.current.close();
    }
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
                  {anchorInfo.anchors.some((anchor) => anchor.available) && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'anchor' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="anchor"
                        checked={paymentMethod === 'anchor'}
                        onChange={() => setPaymentMethod('anchor')}
                      />
                      <div className="asset-picker__code">Deposit via anchor</div>
                      <div className="asset-picker__hint">Open a bank or cash ramp, fund your Stellar wallet, then contribute automatically</div>
                    </label>
                  )}
                </div>
                {freighterChecked && !freighterAvailable && (
                  <span id="contrib-wallet-help" style={styles.help}>
                    Freighter extension not detected. Install it to contribute from your own Stellar wallet.
                  </span>
                )}
              </fieldset>

              {paymentMethod === 'anchor' ? (
                <>
                  <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                    <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                      Deposit partner
                    </legend>
                    <div className="asset-picker" role="radiogroup" aria-label="Anchor selection">
                      {anchorInfo.anchors
                        .filter((anchor) => anchor.available)
                        .map((anchor) => (
                          <label
                            key={anchor.id}
                            className={`asset-picker__option${selectedAnchorId === anchor.id ? ' asset-picker__option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="anchor_id"
                              value={anchor.id}
                              checked={selectedAnchorId === anchor.id}
                              onChange={() => setSelectedAnchorId(anchor.id)}
                            />
                            <div className="asset-picker__code">{anchor.name}</div>
                            <div className="asset-picker__hint">
                              Deposit asset: {anchor.asset.code} · {anchor.environment}
                            </div>
                          </label>
                        ))}
                    </div>
                  </fieldset>
                  {selectedAnchor && (
                    <div className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
                      <strong>{selectedAnchor.name}.</strong> CrowdPay will open the anchor’s hosted KYC and payment flow,
                      wait for {selectedAnchor.asset.code} to arrive in your Stellar wallet, and then submit the campaign contribution for you.
                    </div>
                  )}
                </>
              ) : (
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
              )}

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
                  {(() => {
                    if (!campaign.max_contribution) return null;
                    const existingSum = existingContributions
                      .filter((c) => c.sender_public_key === user?.wallet_public_key)
                      .reduce((sum, c) => sum + Number(c.amount), 0);
                    if (existingSum > 0) {
                      const remaining = Math.max(0, Number(campaign.max_contribution) - existingSum);
                      return (
                        <span style={{ display: 'block', marginTop: '0.25rem', color: '#7c3aed', fontWeight: 600 }}>
                          You can contribute up to {remaining.toLocaleString()} {campaign.asset_type} more.
                        </span>
                      );
                    }
                    return null;
                  })()}
                </span>
              </div>

              <div className="form-stack" style={{ marginBottom: '1rem' }}>
                <label className="label-strong" htmlFor="contrib-display-name">
                  Display name <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
                </label>
                <input
                  id="contrib-display-name"
                  placeholder="e.g. Satoshi"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={50}
                />
                <span style={styles.help}>
                  Visible on the campaign’s backer wall. Leave blank to contribute anonymously.
                </span>
              </div>

              {isPathPayment && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Cross-asset payment.</strong> Stellar will convert from {effectiveSendAsset} to {campaign.asset_type}{' '}
                  when you confirm. Estimated fees are tiny; conversion uses the network DEX.
                </div>
              )}

              {paymentMethod === 'freighter' && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Non-custodial payment.</strong> CrowdPay will prepare the transaction, Freighter will ask you
                  to sign it locally, and only the signed XDR comes back for submission.
                </div>
              )}

              {paymentMethod === 'anchor' && selectedAnchor && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Anchor deposit.</strong> This starts a SEP-24 flow with {selectedAnchor.name}. After the deposit
                  confirms, CrowdPay submits the normal Stellar contribution from your custodial wallet.
                </div>
              )}

              {isPathPayment && destAmount && Number(destAmount) > 0 && (
                <div style={{ marginTop: '0.85rem', minHeight: '3.5rem' }}>
                  {quoteLoading && <p style={{ fontSize: '0.85rem', color: '#666' }}>Fetching live quote…</p>}
                  {!quoteLoading && quote && (
                    <div className="alert alert--success" role="status">
                      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Estimated from your wallet</div>
                      <div style={{ fontSize: '0.875rem', lineHeight: 1.45 }}>
                        Up to <strong>{quote.max_send_amount}</strong> {effectiveSendAsset} (includes a small slippage buffer).
                        {Array.isArray(quote.path) && quote.path.length > 0 && (
                          <>
                            {' '}
                            Route: {effectiveSendAsset} → {quote.path.join(' → ')} → {campaign.asset_type}
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

{qualifyingTier && (
  <div style={{ marginTop: "0.85rem" }}>
    <div
      style={{
        background: "#f5f3ff",
        border: "1px solid #ddd6fe",
        borderRadius: "8px",
        padding: "0.75rem",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      <div style={{ fontSize: "1.25rem" }}>🎁</div>
      <div>
        <div
          style={{
            fontSize: "0.75rem",
            fontWeight: 700,
            color: "#7c3aed",
            textTransform: "uppercase",
            letterSpacing: "0.025em",
          }}
        >
          Unlocked Reward
        </div>
        <div
          style={{
            fontWeight: 700,
            fontSize: "0.95rem",
            color: "#1e1b4b",
          }}
        >
          {qualifyingTier.title}
        </div>
      </div>
    </div>
  </div>
)}

{feeBps > 0 && destAmount && Number(destAmount) > 0 && (
  <div
    className="alert alert--info"
    style={{ marginTop: "0.85rem", fontSize: "0.875rem" }}
    role="status"
  >
    {(() => {
      const feeAmt = (Number(destAmount) * feeBps / 10000).toFixed(7);
      const netAmt = (Number(destAmount) - Number(feeAmt)).toFixed(7);

      return (
        <>
          <strong>Platform fee:</strong> {feeBps / 100}% = {feeAmt}{" "}
          {campaign.asset_type} — campaign receives{" "}
          <strong>
            {netAmt} {campaign.asset_type}
          </strong>
        </>
      );
    })()}
  </div>
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
                  {loading
                    ? loadingLabel
                    : paymentMethod === 'anchor'
                    ? 'Open deposit flow'
                    : paymentMethod === 'freighter'
                    ? 'Review in Freighter'
                    : 'Confirm payment'}
                </button>
              </div>
            </form>
          </>
        ) : phase === 'anchor' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Complete your deposit
            </h2>
            <p className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
              Finish the hosted deposit flow in the popup window. CrowdPay is polling the anchor and will submit the campaign contribution automatically when the funds arrive.
            </p>
            {anchorSession?.anchor_transaction_id && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                <strong>Anchor transaction:</strong> {anchorSession.anchor_transaction_id}
              </p>
            )}
            {anchorSession?.conversion_quote && (
              <div className="alert alert--success" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                <strong>Planned contribution:</strong> up to {anchorSession.conversion_quote.max_send_amount}{' '}
                {anchorSession.conversion_quote.send_asset} will be used so the campaign receives{' '}
                {anchorSession.conversion_quote.campaign_amount} {anchorSession.conversion_quote.campaign_asset}.
              </div>
            )}
            {anchorSession?.interactive_url && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginBottom: '0.75rem' }}
                onClick={() => window.open(anchorSession.interactive_url, '_blank', 'noopener,noreferrer')}
              >
                Reopen deposit window
              </button>
            )}
            <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={handleClose}>
              Close
            </button>
          </div>
        ) : phase === 'finalizing' ? (
          <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
            <div className="spinner" style={{ margin: '0 auto 1.5rem' }}></div>
            <h2 style={styles.title}>Finalizing contribution…</h2>
            <p style={styles.subtitle}>
              Waiting for the Stellar ledger to index your payment. This usually takes 3–5 seconds.
            </p>
            <p style={{ fontSize: '0.85rem', color: '#888' }}>
              Transaction Hash: <code style={{ fontSize: '0.75rem' }}>{result?.tx_hash?.slice(0, 16)}…</code>
            </p>
          </div>
        ) : (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Support Confirmed!
            </h2>
            <p className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
              Your contribution of <strong>{amount} {campaign.asset_type}</strong> has been successfully processed.
            </p>

            {finalizedData?.contribution?.reward && (
              <div style={{ marginBottom: '1.25rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎉</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Reward Unlocked</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#14532d' }}>{finalizedData.contribution.reward.title}</div>
                <p style={{ fontSize: '0.9rem', color: '#166534', marginTop: '0.5rem', lineHeight: 1.4 }}>
                  {finalizedData.contribution.reward.description}
                </p>
              </div>
            )}
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
            {result?.anchor_transaction_id && (
              <div className="alert alert--info" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                <strong>Anchor reference:</strong> {result.anchor_transaction_id}
              </div>
            )}

            <div style={{ marginTop: '1.5rem', borderTop: '1px solid #eee', paddingTop: '1.25rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem' }}>Tell your friends!</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  onClick={() => {
                    const text = encodeURIComponent(`I just backed ${campaign.title} on CrowdPay! Join me: ${window.location.origin}/campaigns/${campaign.id}`);
                    window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
                  }}
                >
                  Share on X
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  onClick={() => {
                    const text = encodeURIComponent(`I just backed ${campaign.title} on CrowdPay! Join me: ${window.location.origin}/campaigns/${campaign.id}`);
                    window.open(`https://wa.me/?text=${text}`, '_blank');
                  }}
                >
                  WhatsApp
                </button>
              </div>
            </div>

            <button type="button" className="btn-primary" style={{ width: '100%', marginTop: '1.25rem' }} onClick={handleClose}>
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
