import React, { createContext, useContext, useState, useCallback } from 'react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('cp_user');
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed.role) {
      parsed.role = parsed.is_admin ? 'admin' : 'contributor';
    }
    return parsed;
  });

  const login = useCallback(async (userData, jwt) => {
    const normalized = { ...userData, role: userData.role || (userData.is_admin ? 'admin' : 'contributor') };
    setUser(normalized);
    api.setToken(jwt);
    localStorage.setItem('cp_user', JSON.stringify(normalized));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
    }
    setUser(null);
    api.setToken(null);
    localStorage.removeItem('cp_user');
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);