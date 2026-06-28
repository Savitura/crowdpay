import { useTranslation } from 'react-i18next';
import { useNetworkStatus } from '../context/NetworkStatusContext';

export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  const { t } = useTranslation();

  if (isOnline) return null;

  return (
    <div
      role="alert"
      className="alert alert--warning offline-banner"
    >
      {t('offline.banner')}
    </div>
  );
}
