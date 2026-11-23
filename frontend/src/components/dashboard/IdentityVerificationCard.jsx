import { useTranslation } from 'react-i18next';
import VerificationBadge from '../VerificationBadge';
import KycPrompt from '../KycPrompt';

export default function IdentityVerificationCard({ user, kycRequired, onUserUpdate }) {
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
            <strong>{t('dashboard.identityVerification')}</strong>
            <div
              style={{
                color: 'var(--color-text-hint)',
                fontSize: '0.88rem',
                marginTop: '0.2rem',
              }}
            >
              {t('dashboard.status')}: {user?.kyc_status || t('dashboard.unverified')}
              {user?.kyc_completed_at
                ? ` • ${t('dashboard.completedOn', { date: new Date(user.kyc_completed_at).toLocaleDateString() })}`
                : ''}
            </div>
          </div>
          <VerificationBadge
            status={user?.verification_status || user?.kyc_status}
            tier={user?.verification_tier}
            showTier
          />
        </div>
        {kycRequired && user?.kyc_status !== 'verified' && (
          <div style={{ marginTop: '0.85rem' }}>
            <KycPrompt onUserUpdate={onUserUpdate} />
          </div>
        )}
      </div>
    </>
  );
}
