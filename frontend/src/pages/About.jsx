export default function About() {
  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.75rem' }}>About CrowdPay</h1>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.65, marginBottom: '1.25rem' }}>
        CrowdPay is a fundraising platform built to move contributions from backer to creator with as
        little friction and as much transparency as possible — wherever in the world either of you
        happens to be.
      </p>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.65, marginBottom: '1.25rem' }}>
        Every campaign owner completes identity verification before they can withdraw funds. Funding
        totals, milestones, and creator updates are visible on every campaign page, so backers can see
        exactly what their contribution is supporting and how it's progressing.
      </p>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
        Payments settle in seconds rather than days, and backers can pay with a bank, a card, or a
        wallet they already hold — the underlying payment rail stays out of the way.
      </p>
    </main>
  );
}
