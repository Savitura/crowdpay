import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];

function DisputeQueue({ token }) {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    // Load open/under_review disputes across all campaigns via admin endpoint
    api.getAdminCampaigns(token)
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api.getCampaignDisputes(c.id, token)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function resolve(dispute, status) {
    const note = window.prompt(`Resolution note (${status}):`, '');
    if (note === null) return;
    setBusyId(dispute.id);
    try {
      const updated = await api.updateDispute(dispute.id, { status, resolution_note: note || undefined }, token);
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      alert(err.message || 'Could not update dispute');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;
  if (!disputes.length) return <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No disputes on record.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div key={d.id} style={{ border: '1px solid var(--color-border-light)', borderRadius: '12px', padding: '1rem', background: 'var(--color-bg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{d.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', background: d.status === 'open' ? 'var(--color-status-error-bg)' : 'var(--color-accent-lighter)', color: d.status === 'open' ? 'var(--color-status-error)' : 'var(--color-accent)', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>
                {d.status}
              </span>
            </div>
            <span style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>{new Date(d.created_at).toLocaleString()}</span>
          </div>
          <div style={{ marginTop: '0.4rem', fontSize: '0.88rem', color: 'var(--color-text-secondary)' }}>
            <strong>Reason:</strong> {d.reason} · <strong>By:</strong> {d.raised_by_name} ({d.raised_by_email})
          </div>
          <p style={{ marginTop: '0.5rem', color: 'var(--color-text-primary)', lineHeight: 1.5, fontSize: '0.9rem' }}>{d.description}</p>
          {d.evidence_url && (
            <div style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>
              Evidence: <a href={d.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>Open link</a>
            </div>
          )}
          {d.resolution_note && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--color-accent)' }}>Note: {d.resolution_note}</div>
          )}
          {['open', 'under_review'].includes(d.status) && (
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.85rem' }}>
              {d.status === 'open' && (
                <button type="button" className="btn-secondary" disabled={busyId === d.id}
                  onClick={() => resolve(d, 'under_review')}>
                  Mark under review
                </button>
              )}
              <button type="button" className="btn-primary" disabled={busyId === d.id}
                onClick={() => resolve(d, 'resolved_contributor')}
                style={{ background: 'var(--color-status-error)', borderColor: 'var(--color-status-error)' }}>
                {busyId === d.id ? 'Processing…' : 'Resolve → Refund contributor'}
              </button>
              <button type="button" className="btn-secondary" disabled={busyId === d.id}
                onClick={() => resolve(d, 'resolved_creator')}>
                {busyId === d.id ? 'Processing…' : 'Resolve → Favour creator'}
              </button>
              <button type="button" className="btn-secondary" disabled={busyId === d.id}
                onClick={() => resolve(d, 'closed')}>
                Close
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  const { user, token, ready } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [users, setUsers] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyMilestoneId, setBusyMilestoneId] = useState(null);
  const [busyCampaignId, setBusyCampaignId] = useState(null);
  const [busyUserId, setBusyUserId] = useState(null);
  const [activeTab, setActiveTab] = useState('campaigns');

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (!user || !user.is_admin) {
      navigate('/');
      return;
    }

    Promise.all([
      api.getAdminStats(token),
      api.getAdminCampaigns(token),
      api.getAdminMilestones(token),
      api.getAdminUsers(token),
      api.getAdminAuditLog(token)
    ]).then(([st, camp, milestoneRows, usrs, audit]) => {
      setStats(st);
      setCampaigns(camp);
      setMilestones(milestoneRows);
      setUsers(usrs);
      setAuditLog(audit);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      navigate('/');
    });

  }, [ready, user, token, navigate]);

  if (!ready || loading) return <div className="container" style={{padding:'2rem'}}>Loading admin panel...</div>;

  async function refreshCampaigns() {
    const camp = await api.getAdminCampaigns(token);
    setCampaigns(camp);
  }

  async function refreshUsers() {
    const usrs = await api.getAdminUsers(token, true);
    setUsers(usrs);
  }

  async function refreshAuditLog() {
    const audit = await api.getAdminAuditLog(token);
    setAuditLog(audit);
  }

  async function refreshMilestones() {
    const rows = await api.getAdminMilestones(token);
    setMilestones(rows);
  }

  async function approveMilestone(id) {
    setBusyMilestoneId(id);
    try {
      await api.approveMilestone(id, {}, token);
      await refreshMilestones();
      await refreshCampaigns();
    } finally {
      setBusyMilestoneId(null);
    }
  }

  async function rejectMilestone(id) {
    const reason = window.prompt('Reason for rejection:', 'Need more evidence before release');
    if (reason === null) return;
    setBusyMilestoneId(id);
    try {
      await api.rejectMilestone(id, { reason: reason || 'Rejected by platform' }, token);
      await refreshMilestones();
    } finally {
      setBusyMilestoneId(null);
    }
  }

  async function suspendCampaign(campaignId) {
    const reason = window.prompt('Reason for suspension:', 'Campaign violates terms of service');
    if (reason === null) return;
    setBusyCampaignId(campaignId);
    try {
      await api.adminSuspendCampaign(campaignId, { reason }, token);
      await refreshCampaigns();
      await refreshAuditLog();
      alert('Campaign suspended');
    } catch (err) {
      alert(err.message || 'Failed to suspend campaign');
    } finally {
      setBusyCampaignId(null);
    }
  }

  async function restoreCampaign(campaignId) {
    if (!window.confirm('Restore this campaign to active?')) return;
    setBusyCampaignId(campaignId);
    try {
      await api.adminRestoreCampaign(campaignId, token);
      await refreshCampaigns();
      await refreshAuditLog();
      alert('Campaign restored');
    } catch (err) {
      alert(err.message || 'Failed to restore campaign');
    } finally {
      setBusyCampaignId(null);
    }
  }

  async function deleteCampaign(campaignId) {
    const reason = window.prompt('Reason for deletion:', 'Campaign deleted for policy violation');
    if (reason === null) return;
    if (!window.confirm('This will permanently delete the campaign. Are you sure?')) return;
    setBusyCampaignId(campaignId);
    try {
      await api.adminDeleteCampaign(campaignId, { reason }, token);
      await refreshCampaigns();
      await refreshAuditLog();
      alert('Campaign deleted');
    } catch (err) {
      alert(err.message || 'Failed to delete campaign');
    } finally {
      setBusyCampaignId(null);
    }
  }

  async function banUser(userId) {
    const reason = window.prompt('Reason for ban:', 'User violated platform terms of service');
    if (reason === null) return;
    setBusyUserId(userId);
    try {
      await api.adminBanUser(userId, { reason }, token);
      await refreshUsers();
      await refreshAuditLog();
      alert('User banned');
    } catch (err) {
      alert(err.message || 'Failed to ban user');
    } finally {
      setBusyUserId(null);
    }
  }

  async function unbanUser(userId) {
    if (!window.confirm('Unban this user?')) return;
    setBusyUserId(userId);
    try {
      await api.adminUnbanUser(userId, token);
      await refreshUsers();
      await refreshAuditLog();
      alert('User unbanned');
    } catch (err) {
      alert(err.message || 'Failed to unban user');
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="container" style={{padding:'2rem', paddingBottom:'4rem'}}>
      <h1 style={{fontSize:'2rem', marginBottom:'1.5rem', fontWeight:800}}>Admin Dashboard</h1>
      <div style={{display:'flex', gap:'1rem', flexWrap:'wrap', marginBottom:'2.5rem'}}>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'var(--color-text-secondary)'}}>Total Users</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_users}</p>
          {stats.banned_users > 0 && <p style={{fontSize:'0.9rem', color:'#d32f2f'}}>Banned: {stats.banned_users}</p>}
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'var(--color-text-secondary)'}}>Active Campaigns</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>
            {stats.campaign_status.find(s => s.status === 'active')?.count || 0}
          </p>
          {stats.deleted_campaigns > 0 && <p style={{fontSize:'0.9rem', color:'#d32f2f'}}>Deleted: {stats.deleted_campaigns}</p>}
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'var(--color-text-secondary)'}}>Total Contributions</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_contributions}</p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Suspended Campaigns</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>
            {stats.campaign_status.find(s => s.status === 'suspended')?.count || 0}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex', gap:'1rem', marginBottom:'2rem', borderBottom:'2px solid #e5e5e5'}}>
        {['campaigns', 'users', 'disputes', 'milestones', 'audit'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              background: activeTab === tab ? '#7c3aed' : 'transparent',
              color: activeTab === tab ? '#fff' : '#666',
              fontWeight: activeTab === tab ? 600 : 400,
              cursor: 'pointer',
              borderRadius: '4px 4px 0 0'
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Campaigns Tab */}
      {activeTab === 'campaigns' && (
        <>
          <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Campaign Moderation</h2>
          <div style={{overflowX:'auto', marginBottom:'2.5rem'}}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>Creator</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Raised</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => (
                  <tr key={c.id} style={{ background: c.status === 'suspended' ? '#fee2e2' : 'inherit' }}>
                    <td style={tdStyle}>{c.title}</td>
                    <td style={tdStyle}>{c.creator_email}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        background: c.status === 'suspended' ? '#fee2e2' : c.status === 'active' ? '#dcfce7' : '#f3f4f6',
                        color: c.status === 'suspended' ? '#dc2626' : c.status === 'active' ? '#16a34a' : '#374151'
                      }}>
                        {c.status}
                      </span>
                    </td>
                    <td style={tdStyle}>{parseFloat(c.raised_amount).toFixed(2)}/{parseFloat(c.target_amount).toFixed(2)}</td>
                    <td style={{...tdStyle, display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
                      {c.status !== 'suspended' && (
                        <button
                          className="btn-primary"
                          style={{background: '#d32f2f', borderColor: '#d32f2f', padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
                          disabled={busyCampaignId === c.id}
                          onClick={() => suspendCampaign(c.id)}
                        >
                          {busyCampaignId === c.id ? '...' : 'Suspend'}
                        </button>
                      )}
                      {c.status === 'suspended' && (
                        <button
                          className="btn-secondary"
                          style={{padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
                          disabled={busyCampaignId === c.id}
                          onClick={() => restoreCampaign(c.id)}
                        >
                          {busyCampaignId === c.id ? '...' : 'Restore'}
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        style={{background: '#dc2626', color: '#fff', borderColor: '#dc2626', padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
                        disabled={busyCampaignId === c.id}
                        onClick={() => deleteCampaign(c.id)}
                      >
                        {busyCampaignId === c.id ? '...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && (
        <>
          <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>User Management</h2>
          <div style={{overflowX:'auto'}}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Admin</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Campaigns</th>
                  <th style={thStyle}>Contributions</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ background: u.is_banned ? '#fee2e2' : 'inherit' }}>
                    <td style={tdStyle}>{u.email}</td>
                    <td style={tdStyle}>{u.is_admin ? '✓' : '—'}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        background: u.is_banned ? '#fee2e2' : '#dcfce7',
                        color: u.is_banned ? '#dc2626' : '#16a34a'
                      }}>
                        {u.is_banned ? 'Banned' : 'Active'}
                      </span>
                    </td>
                    <td style={tdStyle}>{u.campaign_count}</td>
                    <td style={tdStyle}>{u.contribution_count}</td>
                    <td style={{...tdStyle, display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
                      {!u.is_banned && (
                        <button
                          className="btn-primary"
                          style={{background: '#d32f2f', borderColor: '#d32f2f', padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
                          disabled={busyUserId === u.id}
                          onClick={() => banUser(u.id)}
                        >
                          {busyUserId === u.id ? '...' : 'Ban'}
                        </button>
                      )}
                      {u.is_banned && (
                        <button
                          className="btn-secondary"
                          style={{padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
                          disabled={busyUserId === u.id}
                          onClick={() => unbanUser(u.id)}
                        >
                          {busyUserId === u.id ? '...' : 'Unban'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Disputes Tab */}
      {activeTab === 'disputes' && (
        <>
          <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Dispute Queue</h2>
          <DisputeQueue token={token} />
        </>
      )}

      {/* Milestones Tab */}
      {activeTab === 'milestones' && (
        <>
          <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Milestone Reviews</h2>
          {milestones.length === 0 ? (
            <p style={{ color: '#666', marginBottom: '2rem' }}>No milestone activity yet.</p>
          ) : (
            <div style={{display:'grid', gap:'0.9rem', marginBottom:'2.5rem'}}>
              {milestones.map((milestone) => (
                <div key={milestone.id} style={{ border:'1px solid #e5e5e5', borderRadius:'12px', padding:'1rem', background:'#fff' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', gap:'0.75rem', flexWrap:'wrap' }}>
                    <div>
                      <strong>{milestone.title}</strong>
                      <div style={{ color:'#666', fontSize:'0.9rem', marginTop:'0.2rem' }}>
                        {milestone.campaign_title} · {milestone.release_percentage}% · {milestone.status}
                      </div>
                    </div>
                    <div style={{ color:'#666', fontSize:'0.84rem' }}>{milestone.creator_email}</div>
          <h3 style={{fontSize:'1rem', color:'var(--color-text-secondary)'}}>Platform Fees Collected</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>${stats.platform_fees_collected}</p>
        </div>
      </div>

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Campaign Management</h2>
      <div style={{overflowX:'auto', marginBottom:'2.5rem'}}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>Creator</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(c => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.title}</td>
                <td style={tdStyle}>{c.creator_email}</td>
                <td style={tdStyle}>{c.status}</td>
                <td style={tdStyle}>
                  <select value={c.status} onChange={(e) => {
                    api.updateCampaignStatus(c.id, e.target.value, token).then(() => {
                      setCampaigns(campaigns.map(camp => camp.id === c.id ? {...camp, status: e.target.value} : camp));
                    });
                  }} style={{padding:'0.3rem', borderRadius:'4px', border:'1px solid var(--color-border-light)'}}>
                    <option value="active">Active</option>
                    <option value="funded">Funded</option>
                    <option value="in_progress">In progress</option>
                    <option value="completed">Completed</option>
                    <option value="closed">Closed</option>
                    <option value="withdrawn">Withdrawn</option>
                    <option value="failed">Failed</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Milestone Reviews</h2>
      {milestones.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No milestone activity yet.</p>
      ) : (
        <div style={{display:'grid', gap:'0.9rem', marginBottom:'2.5rem'}}>
          {milestones.map((milestone) => (
            <div key={milestone.id} style={{ border:'1px solid var(--color-border-light)', borderRadius:'12px', padding:'1rem', background:'var(--color-bg)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:'0.75rem', flexWrap:'wrap' }}>
                <div>
                  <strong>{milestone.title}</strong>
                  <div style={{ color:'var(--color-text-hint)', fontSize:'0.9rem', marginTop:'0.2rem' }}>
                    {milestone.campaign_title} · {milestone.release_percentage}% · {milestone.status}
                  </div>
                  <div style={{ marginTop:'0.6rem', color:'#444', lineHeight:1.5 }}>
                    {milestone.description || 'No description provided.'}
                  </div>
                  {milestone.evidence_url && (
                    <div style={{ marginTop:'0.6rem', fontSize:'0.88rem' }}>
                      Evidence:{' '}
                      <a href={milestone.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color:'#7c3aed', fontWeight:600 }}>
                        Open link
                      </a>
                    </div>
                  )}
                  {milestone.destination_key && (
                    <div style={{ marginTop:'0.35rem', fontSize:'0.84rem', color:'#555' }}>
                      Destination: {milestone.destination_key}
                    </div>
                  )}
                  {milestone.review_note && (
                    <div style={{ marginTop:'0.6rem', fontSize:'0.84rem', color:'#7c3aed' }}>
                      Note: {milestone.review_note}
                    </div>
                  )}
                  {milestone.status !== 'released' && (
                    <div style={{ display:'flex', gap:'0.75rem', flexWrap:'wrap', marginTop:'0.85rem' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busyMilestoneId === milestone.id || !milestone.evidence_url || !milestone.destination_key}
                        onClick={() => approveMilestone(milestone.id)}
                      >
                        {busyMilestoneId === milestone.id ? 'Processing…' : 'Approve & release'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busyMilestoneId === milestone.id}
                        onClick={() => rejectMilestone(milestone.id)}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
                <div style={{ color:'var(--color-text-hint)', fontSize:'0.84rem' }}>{milestone.creator_email}</div>
              </div>
              <div style={{ marginTop:'0.6rem', color:'var(--color-text-secondary)', lineHeight:1.5 }}>
                {milestone.description || 'No description provided.'}
              </div>
              {milestone.evidence_url && (
                <div style={{ marginTop:'0.6rem', fontSize:'0.88rem' }}>
                  Evidence:{' '}
                  <a href={milestone.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--color-accent)', fontWeight:600 }}>
                    Open link
                  </a>
                </div>
              )}
              {milestone.destination_key && (
                <div style={{ marginTop:'0.35rem', fontSize:'0.84rem', color:'var(--color-text-secondary)' }}>
                  Destination: {milestone.destination_key}
                </div>
              )}
              {milestone.review_note && (
                <div style={{ marginTop:'0.6rem', fontSize:'0.84rem', color:'var(--color-accent)' }}>
                  Note: {milestone.review_note}
                </div>
              )}
              {milestone.status !== 'released' && (
                <div style={{ display:'flex', gap:'0.75rem', flexWrap:'wrap', marginTop:'0.85rem' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busyMilestoneId === milestone.id || !milestone.evidence_url || !milestone.destination_key}
                    onClick={() => approveMilestone(milestone.id)}
                  >
                    {busyMilestoneId === milestone.id ? 'Processing…' : 'Approve & release'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busyMilestoneId === milestone.id}
                    onClick={() => rejectMilestone(milestone.id)}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Audit Log Tab */}
      {activeTab === 'audit' && (
        <>
          <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Admin Action Audit Log</h2>
          <div style={{overflowX:'auto'}}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>Admin</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Target</th>
                  <th style={thStyle}>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map(log => (
                  <tr key={log.id}>
                    <td style={tdStyle}>{new Date(log.created_at).toLocaleString()}</td>
                    <td style={tdStyle}>{log.admin_email}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        background: log.action_type === 'ban' || log.action_type === 'suspend' || log.action_type === 'delete' ? '#fee2e2' : '#dbeafe',
                        color: log.action_type === 'ban' || log.action_type === 'suspend' || log.action_type === 'delete' ? '#dc2626' : '#0284c7'
                      }}>
                        {log.action_type}
                      </span>
                    </td>
                    <td style={tdStyle}>{log.target_type}: {log.target_id.substring(0, 8)}...</td>
                    <td style={tdStyle}>{JSON.stringify(log.details || {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--color-border-light)',
  padding: '1.5rem',
  borderRadius: '8px',
  flex: '1 1 200px',
  background: 'var(--color-surface)'
};

const tableStyle = {
  width: '100%',
  textAlign: 'left',
  borderCollapse: 'collapse',
  border: '1px solid var(--color-border-light)',
  background: 'var(--color-bg)'
};

const thStyle = {
  padding: '0.8rem',
  background: 'var(--color-surface)',
  borderBottom: '2px solid var(--color-border-light)',
  fontWeight: 600,
  color: 'var(--color-text-primary)'
};

const tdStyle = {
  padding: '0.8rem',
  borderBottom: '1px solid var(--color-border-light)',
  color: 'var(--color-text-secondary)'
};
