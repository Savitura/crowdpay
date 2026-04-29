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

  if (loading) return <p style={{ color: '#666' }}>Loading disputes…</p>;
  if (!disputes.length) return <p style={{ color: '#666', marginBottom: '2rem' }}>No disputes on record.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div key={d.id} style={{ border: '1px solid #e5e5e5', borderRadius: '12px', padding: '1rem', background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{d.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', background: d.status === 'open' ? '#fee2e2' : '#ede9fe', color: d.status === 'open' ? '#dc2626' : '#7c3aed', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>
                {d.status}
              </span>
            </div>
            <span style={{ fontSize: '0.82rem', color: '#888' }}>{new Date(d.created_at).toLocaleString()}</span>
          </div>
          <div style={{ marginTop: '0.4rem', fontSize: '0.88rem', color: '#555' }}>
            <strong>Reason:</strong> {d.reason} · <strong>By:</strong> {d.raised_by_name} ({d.raised_by_email})
          </div>
          <p style={{ marginTop: '0.5rem', color: '#333', lineHeight: 1.5, fontSize: '0.9rem' }}>{d.description}</p>
          {d.evidence_url && (
            <div style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>
              Evidence: <a href={d.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color: '#7c3aed', fontWeight: 600 }}>Open link</a>
            </div>
          )}
          {d.resolution_note && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#7c3aed' }}>Note: {d.resolution_note}</div>
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
                style={{ background: '#dc2626', borderColor: '#dc2626' }}>
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
  const [loading, setLoading] = useState(true);
  const [busyMilestoneId, setBusyMilestoneId] = useState(null);

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (!user || (user.role !== 'admin' && !user.is_admin)) {
      navigate('/');
      return;
    }

    Promise.all([
      api.getAdminStats(token),
      api.getAdminCampaigns(token),
      api.getAdminMilestones(token),
      api.getAdminUsers(token)
    ]).then(([st, camp, milestoneRows, usrs]) => {
      setStats(st);
      setCampaigns(camp);
      setMilestones(milestoneRows);
      setUsers(usrs);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      navigate('/');
    });

  }, [ready, user, token, navigate]);

  if (!ready || loading) return <div className="container" style={{padding:'2rem'}}>Loading admin panel...</div>;

  async function refreshMilestones() {
    const rows = await api.getAdminMilestones(token);
    setMilestones(rows);
  }

  async function approveMilestone(id) {
    setBusyMilestoneId(id);
    try {
      await api.approveMilestone(id, {}, token);
      await refreshMilestones();
      const camp = await api.getAdminCampaigns(token);
      setCampaigns(camp);
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

  return (
    <div className="container" style={{padding:'2rem', paddingBottom:'4rem'}}>
      <h1 style={{fontSize:'2rem', marginBottom:'1.5rem', fontWeight:800}}>Admin Dashboard</h1>
      <div style={{display:'flex', gap:'1rem', flexWrap:'wrap', marginBottom:'2.5rem'}}>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Total Users</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_users}</p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Active Campaigns</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>
            {stats.campaign_status.find(s => s.status === 'active')?.count || 0}
          </p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Total Contributions</h3>
          <p style={{fontSize:'1.8rem', fontWeight:700}}>{stats.total_contributions}</p>
        </div>
        <div style={cardStyle}>
          <h3 style={{fontSize:'1rem', color:'#555'}}>Platform Fees Collected</h3>
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
                  }} style={{padding:'0.3rem', borderRadius:'4px', border:'1px solid #ccc'}}>
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
        </div>
      )}

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Dispute Queue</h2>
      <DisputeQueue token={token} />

      <h2 style={{fontSize:'1.4rem', fontWeight:700, marginBottom:'1rem'}}>Users Overview</h2>
      <div style={{overflowX:'auto'}}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Admin</th>
              <th style={thStyle}>Campaigns</th>
              <th style={thStyle}>Contributions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={tdStyle}>{u.email}</td>
                <td style={tdStyle}>{u.is_admin ? 'Yes' : 'No'}</td>
                <td style={tdStyle}>{u.campaign_count}</td>
                <td style={tdStyle}>{u.contribution_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cardStyle = {
  border: '1px solid #e5e5e5',
  padding: '1.5rem',
  borderRadius: '8px',
  flex: '1 1 200px',
  background: '#fafafa'
};

const tableStyle = {
  width: '100%',
  textAlign: 'left',
  borderCollapse: 'collapse',
  border: '1px solid #e5e5e5',
  background: '#fff'
};

const thStyle = {
  padding: '0.8rem',
  background: '#f9f9f9',
  borderBottom: '2px solid #e5e5e5',
  fontWeight: 600,
  color: '#333'
};

const tdStyle = {
  padding: '0.8rem',
  borderBottom: '1px solid #e5e5e5',
  color: '#444'
};
