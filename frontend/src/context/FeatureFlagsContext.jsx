import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiClient } from '../services/api';

const FeatureFlagsContext = createContext(null);

export function FeatureFlagsProvider({ children }) {
  const [flags, setFlags] = useState(new Map());
  const [ready, setReady] = useState(false);

  const refreshFlags = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/feature-flags');
      const next = new Map();
      for (const f of data) {
        // Resolve: enabled OR (not explicitly set AND default_enabled)
        const effective = f.enabled ?? f.default_enabled ?? false;
        next.set(f.key, effective);
      }
      setFlags(next);
      setReady(true);
    } catch {
      // Fail closed: if we cannot reach the server, rely on defaults (all false)
      setFlags(new Map());
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refreshFlags();
  }, [refreshFlags]);

  const isEnabled = useCallback(
    (key) => flags.get(key) ?? false,
    [flags]
  );

  const value = { flags, ready, isEnabled, refreshFlags };
  return (
    <FeatureFlagsContext.Provider value={value}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

export function useFeatureFlags() {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) {
    throw new Error('useFeatureFlags must be used inside FeatureFlagsProvider');
  }
  return ctx;
}
