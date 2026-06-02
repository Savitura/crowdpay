import React, { createContext, useCallback, useContext, useState } from 'react';
import { Toast } from '../components/Toast';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, type = 'success') => setToast({ message, type }), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
