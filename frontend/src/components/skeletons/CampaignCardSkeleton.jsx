import React from 'react';

export default function CampaignCardSkeleton() {
  return (
    <div className="skeleton--card" aria-hidden="true">
      <div style={styles.header}>
        <span className="skeleton" style={styles.badge} />
      </div>
      <div className="skeleton" style={styles.title} />
      <div className="skeleton" style={styles.descLine1} />
      <div className="skeleton" style={styles.descLine2} />
      <div className="skeleton" style={styles.bar} />
      <div style={styles.meta}>
        <div className="skeleton" style={styles.metaLeft} />
        <div className="skeleton" style={styles.metaRight} />
      </div>
      <div className="skeleton" style={styles.target} />
    </div>
  );
}

const styles = {
  header: { marginBottom: '0.6rem', display: 'flex', justifyContent: 'space-between' },
  badge: { width: '40px', height: '20px', borderRadius: '99px' },
  title: { height: '18px', width: '70%', marginBottom: '0.5rem' },
  descLine1: { height: '13px', width: '100%', marginBottom: '0.3rem' },
  descLine2: { height: '13px', width: '60%', marginBottom: '1rem' },
  bar: { height: '6px', borderRadius: '99px', marginBottom: '0.5rem' },
  meta: { display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' },
  metaLeft: { height: '13px', width: '45%' },
  metaRight: { height: '13px', width: '20%' },
  target: { height: '12px', width: '35%', marginTop: '0.3rem' },
};
