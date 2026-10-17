import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

const buttonBase = {
  border: 0,
  borderRadius: '8px',
  color: '#fff',
  cursor: 'pointer',
  fontWeight: 700,
  padding: '0.55rem 0.85rem',
};

export default function MilestoneVotePanel({ milestones }) {
  const votableMilestones = useMemo(
    () => (milestones || []).filter((milestone) => milestone.status === 'pending_review'),
    [milestones]
  );
  const [votesByMilestone, setVotesByMilestone] = useState({});
  const [notesByMilestone, setNotesByMilestone] = useState({});
  const [busyByMilestone, setBusyByMilestone] = useState({});
  const [errorByMilestone, setErrorByMilestone] = useState({});

  useEffect(() => {
    let active = true;
    if (!votableMilestones.length) {
      setVotesByMilestone({});
      return () => {
        active = false;
      };
    }

    Promise.all(
      votableMilestones.map((milestone) =>
        api
          .getMilestoneVotes(milestone.id)
          .then((result) => [milestone.id, result])
          .catch((err) => [milestone.id, { error: err.message || 'Could not load votes' }])
      )
    ).then((results) => {
      if (!active) return;
      const nextVotes = {};
      const nextErrors = {};
      results.forEach(([milestoneId, result]) => {
        if (result.error) nextErrors[milestoneId] = result.error;
        else nextVotes[milestoneId] = result;
      });
      setVotesByMilestone(nextVotes);
      setErrorByMilestone(nextErrors);
    });

    return () => {
      active = false;
    };
  }, [votableMilestones]);

  if (!votableMilestones.length) return null;

  async function submitVote(milestoneId, vote) {
    setBusyByMilestone((current) => ({ ...current, [milestoneId]: true }));
    setErrorByMilestone((current) => ({ ...current, [milestoneId]: '' }));
    try {
      const result = await api.voteMilestone(milestoneId, {
        vote,
        note: notesByMilestone[milestoneId] || '',
      });
      setVotesByMilestone((current) => ({ ...current, [milestoneId]: result }));
    } catch (err) {
      setErrorByMilestone((current) => ({
        ...current,
        [milestoneId]: err.message || 'Could not submit vote',
      }));
    } finally {
      setBusyByMilestone((current) => ({ ...current, [milestoneId]: false }));
    }
  }

  return (
    <section style={{ marginTop: '1rem', marginBottom: '1.5rem' }} aria-label="Milestone voting">
      <h2
        style={{
          color: 'var(--color-text-primary)',
          fontSize: '1.05rem',
          fontWeight: 800,
          marginBottom: '0.75rem',
        }}
      >
        Contributor milestone votes
      </h2>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {votableMilestones.map((milestone) => {
          const tally = votesByMilestone[milestone.id];
          const busy = !!busyByMilestone[milestone.id];
          const error = errorByMilestone[milestone.id];
          const currentVote = tally?.user_vote?.vote;

          return (
            <article key={milestone.id} className="campaign-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong>{milestone.title}</strong>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.86rem' }}>
                    {tally
                      ? `${tally.approve_count} approve / ${tally.reject_count} reject`
                      : 'Vote tally loading'}
                  </div>
                </div>
                {currentVote && (
                  <span
                    style={{
                      alignSelf: 'flex-start',
                      background:
                        currentVote === 'approve'
                          ? 'var(--color-success-bg)'
                          : 'var(--color-error-bg)',
                      borderRadius: '999px',
                      color:
                        currentVote === 'approve'
                          ? 'var(--color-success-text)'
                          : 'var(--color-error-text)',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      padding: '0.25rem 0.6rem',
                    }}
                  >
                    Your vote: {currentVote}
                  </span>
                )}
              </div>

              <textarea
                value={notesByMilestone[milestone.id] || ''}
                onChange={(event) =>
                  setNotesByMilestone((current) => ({
                    ...current,
                    [milestone.id]: event.target.value,
                  }))
                }
                placeholder="Add an optional note"
                rows={2}
                style={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  color: 'var(--color-text-primary)',
                  marginTop: '0.75rem',
                  padding: '0.65rem',
                  resize: 'vertical',
                  width: '100%',
                }}
              />

              {error && (
                <div
                  className="alert alert--error"
                  style={{ marginTop: '0.65rem', fontSize: '0.82rem' }}
                >
                  {error}
                </div>
              )}

              <div
                style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => submitVote(milestone.id, 'approve')}
                  style={{ ...buttonBase, background: 'var(--color-success, #15803d)' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => submitVote(milestone.id, 'reject')}
                  style={{ ...buttonBase, background: 'var(--color-error, #b91c1c)' }}
                >
                  Reject
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
