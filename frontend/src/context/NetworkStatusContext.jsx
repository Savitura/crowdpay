import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { retryQueuedRequests } from '../services/api';

const NetworkStatusContext = createContext({ isOnline: true });

export function NetworkStatusProvider({ children }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const wasOfflineRef = useRef(false);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      retryQueuedRequests();
    }
  }, []);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    wasOfflineRef.current = true;
  }, []);

  useEffect(() => {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleOnline, handleOffline]);

  return (
    <NetworkStatusContext.Provider value={{ isOnline }}>
      {children}
    </NetworkStatusContext.Provider>
  );
}

export const useNetworkStatus = () => useContext(NetworkStatusContext);
