import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import MilestoneTracker from '../components/MilestoneTracker';
import KycPrompt from '../components/KycPrompt';
import VerificationBadge from '../components/VerificationBadge';

function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

export default function Dashboard() {
  const { token, user, ready, updateUser } = useAuth();
  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [milestonesByCampaign, setMilestonesByCampaign] = useState({});
  const [milestoneForms, setMilestoneForms] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [milestoneBusyId, setMilestoneBusyId] = useState(null);

  const [disputesByCampaign, setDisputesByCampaign] = useState({});

  useEffect(() => {
    if (!token) return;
    Promise.all([api.getMe(token), api.getMyStats(token), api.getMyCampaigns(token)])
      .then(async ([me, s, c]) => {
        updateUser(me);
        setStats(s);
        setCampaigns(c);
        const milestoneEntries = await Promise.all(
          c.map(async (campaign) => {
            const milestones = await api.getMilestones(campaign.id).catch(() => []);
            return [campaign.id, milestones];
          })
        );
        const milestoneMap = Object.fromEntries(milestoneEntries);
        setMilestonesByCampaign(milestoneMap);
        setMilestoneForms(
          Object.fromEntries(
            milestoneEntries.flatMap(([campaignId, milestones]) =>
              milestones.map((milestone) => [
                milestone.id,
                {
                  campaignId,
                  evidence_url: milestone.evidence_url || '',
                  destination_key: milestone.destination_key || '',
                },
              ])
            )
          )
        );
        // Load open disputes for each campaign
        const disputeEntries = await Promise.all(
          c.map(async (campaign) => {
            const disputes = await api.getCampaignDisputes(campaign.id, token).catch(() => []);
            return [campaign.id, disputes.filter((d) => d.status === 'open' || d.status === 'under_review')];
          })
        );
        setDisputesByCampaign(Object.fromEntries(disputeEntries));
      })
      .catch((err) => setError(err.message || 'Could not load dashboard'))
      .finally(() => setLoading(false));
  }, [token, updateUser]);

  function setMilestoneField(milestoneId, field, value) {
    setMilestoneForms((current) => ({
      ...current,
      [milestoneId]: {
        ...current[milestoneId],
        [field]: value,
      },
    }));
  }

  async function submitMilestone(milestoneId) {
    const payload = milestoneForms[milestoneId];
    if (!payload?.evidence_url || !payload?.destination_key) {
      setError('Milestone evidence and payout destination are both required.');
      return;
    }

    setMilestoneBusyId(milestoneId);
    setError('');
    try {
      await api.submitMilestoneEvidence(
        milestoneId,
        {
          evidence_url: payload.evidence_url.trim(),
          destination_key: payload.destination_key.trim(),
        },
        token
      );
      const milestones = await api.getMilestones(payload.campaignId);
      setMilestonesByCampaign((current) => ({ ...current, [payload.campaignId]: milestones }));
    } catch (err) {
      setError(err.message || 'Could not submit milestone evidence');
    } finally {
      setMilestoneBusyId(null);
    }
  }

  if (!ready) {
    return (
      <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
        <p style={{ color: '#666' }}>Restoring your session...</p>
      </main>
    );
  }
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role !== 'creator' && user?.role !== 'admin') return <Navigate to="/" replace />;
  const kycRequired = user?.kyc_required_for_campaigns ?? (
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false'
  );

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>Creator Dashboard</h1>
      {error && <p className="alert alert--error">{error}</p>}
      {loading ? (
        <p style={{ color: '#666' }}>Loading dashboard...</p>
      ) : (
        <>
          <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <strong>Identity verification</strong>
                <div style={{ color: '#666', fontSize: '0.88rem', marginTop: '0.2rem' }}>
                  Status: {user?.kyc_status || 'unverified'}
                  {user?.kyc_completed_at ? ` • Completed ${new Date(user.kyc_completed_at).toLocaleDateString()}` : ''}
                </div>
              </div>
              <VerificationBadge status={user?.kyc_status} />
            </div>
            {kycRequired && user?.kyc_status !== 'verified' && (
              <div style={{ marginTop: '0.85rem' }}>
                <KycPrompt token={token} onUserUpdate={updateUser} />
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            <div className="campaign-card"><strong>{stats?.total_campaigns || 0}</strong><div>Total campaigns</div></div>
            <div className="campaign-card"><strong>{Number(stats?.total_raised || 0).toLocaleString()}</strong><div>Total raised</div></div>
            <div className="campaign-card"><strong>{stats?.active_campaigns || 0}</strong><div>Active campaigns</div></div>
            <div className="campaign-card"><strong>{stats?.in_progress_campaigns || 0}</strong><div>In progress</div></div>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <Link to="/campaigns/new" style={{ color: '#7c3aed', fontWeight: 600 }}>+ Create new campaign</Link>
          </div>
          {campaigns.length === 0 ? (
            <p className="alert alert--info">No campaigns yet. Create your first campaign to get started.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {campaigns.map((campaign) => {
                const pct = progressPct(campaign).toFixed(1);
                const milestones = milestonesByCampaign[campaign.id] || [];
                return (
                  <div key={campaign.id} className="campaign-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <strong>{campaign.title}</strong>
                      <span>{campaign.status}</span>
                    </div>
                    <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                      {Number(campaign.raised_amount).toLocaleString()} / {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
                    </div>
                    <div style={{ background: '#eee', borderRadius: '99px', height: '6px', marginTop: '0.35rem' }}>
                      <div style={{ background: '#7c3aed', height: '6px', borderRadius: '99px', width: `${pct}%` }} />
                    </div>
                    <div style={{ marginTop: '0.35rem', color: '#666', fontSize: '0.85rem' }}>
                      {campaign.contributor_count} contributors {campaign.deadline ? `• Deadline ${new Date(campaign.deadline).toLocaleDateString()}` : ''}
                    </div>
                    <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.75rem' }}>
                      <Link to={`/campaigns/${campaign.id}`} style={{ color: '#7c3aed' }}>View</Link>
                      <Link to={`/campaigns/${campaign.id}`} style={{ color: '#7c3aed' }}>
                        {milestones.length ? 'View milestone releases' : 'Manage withdrawals'}
                      </Link>
                    </div>
                    {(disputesByCampaign[campaign.id] || []).length > 0 && (
                      <div className="alert alert--error" style={{ marginTop: '0.75rem', fontSize: '0.88rem' }} role="alert">
                        ⚠ <strong>{disputesByCampaign[campaign.id].length} open dispute{disputesByCampaign[campaign.id].length > 1 ? 's' : ''}</strong> raised against this campaign.
                        Withdrawals are frozen until the platform resolves the dispute.
                      </div>
                    )}
                    {milestones.length > 0 && (
                      <div style={{ marginTop: '1rem' }}>
                        <MilestoneTracker milestones={milestones} assetType={campaign.asset_type} />
                        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                          {milestones
                            .filter((milestone) => milestone.status !== 'released')
                            .map((milestone) => (
                              <div key={milestone.id} style={{ border: '1px solid #eee', borderRadius: '12px', padding: '0.85rem', background: '#fafafa' }}>
                                <strong>{milestone.title}</strong>
                                <div style={{ fontSize: '0.84rem', color: '#666', marginTop: '0.25rem' }}>
                                  Submit proof and destination so CrowdPay can release this tranche after approval.
                                </div>
                                {milestone.review_note && (
                                  <div className="alert alert--info" style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>
                                    {milestone.review_note}
                                  </div>
                                )}
                                <input
                                  style={{ marginTop: '0.6rem' }}
                                  placeholder="Evidence URL"
                                  value={milestoneForms[milestone.id]?.evidence_url || ''}
                                  onChange={(e) => setMilestoneField(milestone.id, 'evidence_url', e.target.value)}
                                />
                                <input
                                  style={{ marginTop: '0.6rem' }}
                                  placeholder="Payout destination (G...)"
                                  value={milestoneForms[milestone.id]?.destination_key || ''}
                                  onChange={(e) => setMilestoneField(milestone.id, 'destination_key', e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="btn-primary"
                                  style={{ marginTop: '0.6rem', width: '100%' }}
                                  disabled={milestoneBusyId === milestone.id}
                                  onClick={() => submitMilestone(milestone.id)}
                                >
                                  {milestoneBusyId === milestone.id ? 'Submitting…' : 'Submit milestone evidence'}
                                </button>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}
