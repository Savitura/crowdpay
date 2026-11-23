import { describe, it, expect, beforeEach, vi } from 'vitest';
import { safeLocalStorage, safeSessionStorage, safeStorage } from './safeStorage';

describe('safeStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('safely gets, sets, and removes items from localStorage', () => {
    expect(safeLocalStorage.getItem('test_key')).toBeNull();
    expect(safeLocalStorage.getItem('test_key', 'default')).toBe('default');

    expect(safeLocalStorage.setItem('test_key', 'hello')).toBe(true);
    expect(safeLocalStorage.getItem('test_key')).toBe('hello');

    expect(safeLocalStorage.removeItem('test_key')).toBe(true);
    expect(safeLocalStorage.getItem('test_key')).toBeNull();
  });

  it('safely gets, sets, and removes items from sessionStorage', () => {
    expect(safeSessionStorage.getItem('session_key')).toBeNull();
    expect(safeSessionStorage.setItem('session_key', 'world')).toBe(true);
    expect(safeSessionStorage.getItem('session_key')).toBe('world');
    expect(safeSessionStorage.removeItem('session_key')).toBe(true);
    expect(safeSessionStorage.getItem('session_key')).toBeNull();
  });

  it('handles thrown exceptions gracefully (e.g. quota exceeded or disabled storage)', () => {
    const storageProto = window.Storage?.prototype || Object.getPrototypeOf(window.localStorage);
    const spy = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    expect(safeLocalStorage.setItem('fail_key', 'value')).toBe(false);

    spy.mockRestore();
  });

  it('provides safeStorage.local and safeStorage.session aliases', () => {
    safeStorage.local.setItem('alias_key', 'local_val');
    expect(safeStorage.local.getItem('alias_key')).toBe('local_val');

    safeStorage.session.setItem('alias_session', 'sess_val');
    expect(safeStorage.session.getItem('alias_session')).toBe('sess_val');
  });
});
