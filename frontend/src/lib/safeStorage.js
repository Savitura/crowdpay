/**
 * Safe storage helper that protects against SecurityError, QuotaExceededError,
 * and disabled storage environments (e.g. private browsing, restricted iframes).
 */

function createSafeStorage(getStorage) {
  return {
    getItem(key, fallback = null) {
      try {
        const storage = getStorage();
        if (!storage) return fallback;
        const value = storage.getItem(key);
        return value !== null ? value : fallback;
      } catch {
        return fallback;
      }
    },

    setItem(key, value) {
      try {
        const storage = getStorage();
        if (!storage) return false;
        storage.setItem(key, String(value));
        return true;
      } catch {
        return false;
      }
    },

    removeItem(key) {
      try {
        const storage = getStorage();
        if (!storage) return false;
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },

    clear() {
      try {
        const storage = getStorage();
        if (!storage) return false;
        storage.clear();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const safeLocalStorage = createSafeStorage(() =>
  typeof window !== 'undefined' ? window.localStorage : null
);

export const safeSessionStorage = createSafeStorage(() =>
  typeof window !== 'undefined' ? window.sessionStorage : null
);

export const safeStorage = {
  local: safeLocalStorage,
  session: safeSessionStorage,
  getItem: (key, fallback) => safeLocalStorage.getItem(key, fallback),
  setItem: (key, value) => safeLocalStorage.setItem(key, value),
  removeItem: (key) => safeLocalStorage.removeItem(key),
  clear: () => safeLocalStorage.clear(),
};

export default safeStorage;
