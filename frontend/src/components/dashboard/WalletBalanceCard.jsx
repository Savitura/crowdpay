import { useTranslation } from 'react-i18next';
import { stellarExpertAccountUrl } from '../../config/stellar';

export default function WalletBalanceCard({
  balance,
  balanceLoading,
  walletPublicKey,
  onAddFunds,
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div>
            <strong>{t('dashboard.walletBalance')}</strong>
            <div
              style={{ color: 'var(--color-text-hint)', fontSize: '0.88rem', marginTop: '0.2rem' }}
            >
              {balanceLoading
                ? t('common.loading')
                : balance
                  ? Object.entries(balance)
                      .filter(([, v]) => Number(v) > 0)
                      .map(([code, val]) => `${Number(val).toLocaleString()} ${code}`)
                      .join(' · ') || t('dashboard.noFunds')
                  : t('dashboard.noFunds')}
              {walletPublicKey && (
                <span style={{ marginLeft: '0.5rem' }}>
                  ·{' '}
                  <a
                    href={stellarExpertAccountUrl(walletPublicKey)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    {t('dashboard.viewOnStellarExpert')}
                  </a>
                </span>
              )}
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={onAddFunds}>
            {t('dashboard.addFunds')}
          </button>
        </div>
      </div>
    </>
  );
}
