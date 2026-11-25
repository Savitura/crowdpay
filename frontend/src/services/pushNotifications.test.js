import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  getApp: vi.fn(() => ({ name: 'app' })),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: 'app' })),
  getMessaging: vi.fn(() => ({ name: 'messaging' })),
  getToken: vi.fn(),
  deleteToken: vi.fn(),
  isSupported: vi.fn(),
}));

vi.mock('firebase/app', () => ({
  getApp: firebaseMocks.getApp,
  getApps: firebaseMocks.getApps,
  initializeApp: firebaseMocks.initializeApp,
}));

vi.mock('firebase/messaging', () => ({
  deleteToken: firebaseMocks.deleteToken,
  getMessaging: firebaseMocks.getMessaging,
  getToken: firebaseMocks.getToken,
  isSupported: firebaseMocks.isSupported,
}));

const config = {
  apiKey: 'test-api-key',
  authDomain: 'test.example.com',
  projectId: 'test-project',
  messagingSenderId: '123456789',
  appId: 'test-app-id',
};
const vapidKey = 'test-vapid-key';

async function loadPushNotifications() {
  return import('./pushNotifications');
}

describe('pushNotifications', () => {
  let serviceWorkerDescriptor;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', config.apiKey);
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', config.authDomain);
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', config.projectId);
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', config.messagingSenderId);
    vi.stubEnv('VITE_FIREBASE_APP_ID', config.appId);
    vi.stubEnv('VITE_FIREBASE_VAPID_KEY', vapidKey);

    firebaseMocks.getApp.mockClear();
    firebaseMocks.getApps.mockReset().mockReturnValue([]);
    firebaseMocks.initializeApp.mockClear();
    firebaseMocks.getMessaging.mockReset().mockReturnValue({ name: 'messaging' });
    firebaseMocks.getToken.mockReset().mockResolvedValue('push-token');
    firebaseMocks.deleteToken.mockReset().mockResolvedValue(true);
    firebaseMocks.isSupported.mockReset().mockResolvedValue(true);

    serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue({ scope: '/firebase-messaging-sw.js' }) },
    });
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
  });

  afterEach(() => {
    if (serviceWorkerDescriptor) {
      Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
    } else {
      delete navigator.serviceWorker;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['denied', 'default'])(
    'does not subscribe when notification permission is %s',
    async (permission) => {
      globalThis.Notification.requestPermission.mockResolvedValue(permission);
      const { subscribeToPush } = await loadPushNotifications();

      await expect(subscribeToPush()).rejects.toThrow(
        'Push notification permission was not granted'
      );
      expect(firebaseMocks.initializeApp).not.toHaveBeenCalled();
      expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
    }
  );

  it('creates a subscription after permission is granted', async () => {
    const { subscribeToPush } = await loadPushNotifications();

    await expect(subscribeToPush()).resolves.toBe('push-token');

    const encodedConfig = encodeURIComponent(globalThis.btoa(JSON.stringify(config)));
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith(
      `/firebase-messaging-sw.js?config=${encodedConfig}`
    );
    expect(firebaseMocks.initializeApp).toHaveBeenCalledWith(config);
    expect(firebaseMocks.getToken).toHaveBeenCalledWith(
      { name: 'messaging' },
      {
        vapidKey,
        serviceWorkerRegistration: { scope: '/firebase-messaging-sw.js' },
      }
    );
  });

  it('rejects when the messaging service returns no subscription token', async () => {
    firebaseMocks.getToken.mockResolvedValue('');
    const { subscribeToPush } = await loadPushNotifications();

    await expect(subscribeToPush()).rejects.toThrow(
      'Unable to create a push notification subscription'
    );
  });

  it('deletes an existing push subscription and returns its token', async () => {
    const { unsubscribeFromPush } = await loadPushNotifications();

    await expect(unsubscribeFromPush()).resolves.toBe('push-token');
    expect(firebaseMocks.deleteToken).toHaveBeenCalledWith({ name: 'messaging' });
  });
});
