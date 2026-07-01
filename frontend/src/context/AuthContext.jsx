import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const refreshUser = useCallback(async () => {
    const userData = await api.getMe();
    if (userData && userData.id) {
      setUser(userData);
    } else {
      setUser(null);
    }
    return userData;
  }, []);

  useEffect(() => {
    let active = true;

    async function validateAndRefreshUser() {
      // Check if user has a valid session (token is in httpOnly cookie)
      try {
        // Always fetch fresh user data from server — never trust client-stored role/admin flags
        const userData = await api.getMe();
        if (!active) return;
        if (userData && userData.id) {
          setUser(userData);
        } else {
          setUser(null);
        }
      } catch (err) {
        if (!active) return;
        // If token is invalid, expired, or user was deleted, log out
        if (err.status === 401 || err.status === 404) {
          setUser(null);
        }
      } finally {
        if (active) {
          setReady(true);
        }
      }
    }

    validateAndRefreshUser();

    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (userData) => {
    setUser(userData);
    Sentry.setUser({ id: userData.id, email: userData.email, role: userData.role });
    setReady(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (_err) {
      /* ignore */
    }
    setUser(null);
    Sentry.setUser(null);
    setReady(true);
  }, []);

  const updateUser = useCallback((userData) => {
    setUser(userData);
  }, []);

  const exitImpersonation = useCallback(async () => {
    await api.adminExitImpersonation();
    return refreshUser();
  }, [refreshUser]);

  return (
    <AuthContext.Provider
      value={{ user, ready, login, logout, updateUser, refreshUser, exitImpersonation }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
