import { useCallback, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { api } from '../../services/api';
import { cardStyle } from './AdminShared';

function ContractUpgradeModal({ campaign, onClose, onUpgraded }) {
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState(null);

  async function confirmUpgrade() {
    setUpgrading(true);
    setError(null);
    try {
      await api.adminUpgradeCampaignContract(campaign.id);
      onUpgraded();
    } catch (err) {
      setError(err.message || 'Could not upgrade contract');
    } finally {
      setUpgrading(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{ ...cardStyle, maxWidth: '420px', width: '90%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Upgrade Contract to V2</h3>
        <p style={{ fontSize: '0.9rem' }}>
          <strong>Campaign:</strong> {campaign.title}
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)', wordBreak: 'break-all' }}>
          <strong>Current contract:</strong> {campaign.escrow_contract_id}
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
          <strong>Estimated migration time:</strong> ~1&ndash;2 minutes
        </p>
        <p
          style={{
            fontSize: '0.85rem',
            padding: '0.6rem',
            borderRadius: '6px',
            background: 'var(--color-warning-bg, #fff3cd)',
            color: 'var(--color-warning-text, #7a5b00)',
          }}
        >
          Contributions and milestone submissions will be paused for this campaign until migration
          completes.
        </p>
        {error && <p style={{ fontSize: '0.85rem', color: 'var(--color-error-text)' }}>{error}</p>}
        <div
          style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}
        >
          <button type="button" onClick={onClose} disabled={upgrading}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmUpgrade}
            disabled={upgrading}
            style={{
              background: 'var(--color-teal)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.4rem 0.8rem',
            }}
          >
            {upgrading ? 'Upgrading…' : 'Confirm Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}

ContractUpgradeModal.propTypes = {
  campaign: PropTypes.shape({
    id: PropTypes.string.isRequired,
    title: PropTypes.string.isRequired,
    escrow_contract_id: PropTypes.string.isRequired,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  onUpgraded: PropTypes.func.isRequired,
};

export default function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [upgradeTarget, setUpgradeTarget] = useState(null);

  const reload = useCallback(() => {
    return api.getAdminCampaigns({ flagged_only: flaggedOnly }).then(setCampaigns);
  }, [flaggedOnly]);

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, [reload]);

  async function handleUpgraded() {
    setUpgradeTarget(null);
    await reload();
  }

  async function unflag(id) {
    if (!window.confirm('Remove duplicate flag and allow publishing?')) return;
    try {
      await api.adminUnflagCampaign(id);
      const updated = await api.getAdminCampaigns({ flagged_only: flaggedOnly });
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not unflag campaign');
    }
  }

  async function feature(id) {
    const note = window.prompt('Featured note (optional):', '');
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      const updated = await api.getAdminCampaigns();
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!window.confirm('Remove from featured?')) return;
    try {
      await api.adminUnfeatureCampaign(id);
      const updated = await api.getAdminCampaigns();
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading campaigns…</p>;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => setFlaggedOnly(e.target.checked)}
          />
          Show flagged potential duplicates only
        </label>
      </div>
      <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
        {campaigns.map((c) => (
          <div key={c.id} style={cardStyle}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div>
                <strong>{c.title}</strong>
                {c.escrow_contract_id && (
                  <span
                    title="Milestone escrow contract version"
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      padding: '0.1rem 0.4rem',
                      borderRadius: '4px',
                      background:
                        c.escrow_contract_version >= 2
                          ? 'var(--color-teal)'
                          : 'var(--color-text-hint)',
                      color: '#fff',
                    }}
                  >
                    {c.escrow_contract_version >= 2 ? 'V2' : 'V1'}
                  </span>
                )}
                {c.is_flagged_duplicate && (
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.75rem',
                      padding: '0.1rem 0.4rem',
                      borderRadius: '4px',
                      background: 'var(--color-error-bg)',
                      color: 'var(--color-error-text)',
                    }}
                  >
                    Flagged Duplicate
                  </span>
                )}
                <span
                  style={{
                    marginLeft: '0.5rem',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-hint)',
                  }}
                >
                  {c.status} · #{c.id.slice(0, 8)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {c.is_flagged_duplicate ? (
                  <button
                    type="button"
                    onClick={() => unflag(c.id)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.7rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: 'var(--color-teal)',
                      color: '#fff',
                      border: 'none',
                    }}
                  >
                    Unflag
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => feature(c.id)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.25rem 0.7rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                      }}
                    >
                      Feature
                    </button>
                    <button
                      type="button"
                      onClick={() => unfeature(c.id)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.25rem 0.7rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                      }}
                    >
                      Unfeature
                    </button>
                  </>
                )}
                {c.escrow_contract_id && c.escrow_contract_version < 2 && !c.has_active_review && (
                  <button
                    type="button"
                    onClick={() => setUpgradeTarget(c)}
                    disabled={c.migration_in_progress}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.7rem',
                      borderRadius: '6px',
                      cursor: c.migration_in_progress ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {c.migration_in_progress ? 'Migrating…' : 'Upgrade Contract'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {upgradeTarget && (
        <ContractUpgradeModal
          campaign={upgradeTarget}
          onClose={() => setUpgradeTarget(null)}
          onUpgraded={handleUpgraded}
        />
      )}
    </div>
  );
}
