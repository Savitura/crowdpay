import React from 'react';

function statusTone(status) {
  if (status === 'released') return { bg: '#dcfce7', fg: '#166534', label: 'Released' };
  if (status === 'approved') return { bg: '#dbeafe', fg: '#1d4ed8', label: 'Approved' };
  return { bg: '#f3f4f6', fg: '#4b5563', label: 'Pending' };
}

export default function MilestoneTracker({ milestones, assetType }) {
  if (!milestones?.length) return null;

  return (
    <section style={{ marginTop: '1.5rem' }} aria-label="Milestone progress">
      <h2 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.75rem', color: '#111' }}>
        Milestone releases
      </h2>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {milestones.map((milestone, index) => {
          const tone = statusTone(milestone.status);
          return (
            <article key={milestone.id} className="campaign-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '0.78rem', color: '#777', marginBottom: '0.2rem' }}>
                    Milestone {index + 1}
                  </div>
                  <strong>{milestone.title}</strong>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignSelf: 'flex-start' }}>
                  {milestone.on_chain && (
                    <div
                      title="This milestone is managed by a Soroban smart contract"
                      style={{
                        background: '#fef3c7',
                        color: '#92400e',
                        borderRadius: '999px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        padding: '0.25rem 0.6rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem'
                      }}
                    >
                      <span aria-hidden="true">⛓️</span> On-chain
                    </div>
                  )}
                  <div
                    style={{
                      background: tone.bg,
                      color: tone.fg,
                      borderRadius: '999px',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      padding: '0.25rem 0.6rem',
                    }}
                  >
                    {tone.label}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: '0.45rem', color: '#444', lineHeight: 1.55, fontSize: '0.92rem' }}>
                {milestone.description || 'No description provided yet.'}
              </div>
              <div style={{ marginTop: '0.55rem', fontSize: '0.85rem', color: '#555' }}>
                Releases {Number(milestone.release_percentage).toLocaleString()}% of campaign funds in {assetType}.
              </div>
              {milestone.evidence_url && (
                <div style={{ marginTop: '0.45rem', fontSize: '0.84rem' }}>
                  Evidence:{' '}
                  <a href={milestone.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color: '#7c3aed', fontWeight: 600 }}>
                    View proof
                  </a>
                </div>
              )}
              {milestone.review_note && (
                <div className="alert alert--info" style={{ marginTop: '0.55rem', fontSize: '0.82rem' }}>
                  {milestone.review_note}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
