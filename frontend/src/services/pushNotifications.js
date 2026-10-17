const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

function configured() {
  return Object.values(firebaseConfig).every(Boolean) && Boolean(vapidKey);
}

async function messagingClient() {
  if (!configured()) throw new Error('Push notifications are not configured');
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    throw new Error('Push notifications are not supported by this browser');
  }

  const [{ getApp, getApps, initializeApp }, { getMessaging, getToken, deleteToken, isSupported }] =
    await Promise.all([import('firebase/app'), import('firebase/messaging')]);
  if (!(await isSupported()))
    throw new Error('Push notifications are not supported by this browser');

  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const config = globalThis.btoa(JSON.stringify(firebaseConfig));
  const registration = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?config=${encodeURIComponent(config)}`
  );
  return { messaging: getMessaging(app), registration, getToken, deleteToken };
}

export async function subscribeToPush() {
  const permission = await globalThis.Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Push notification permission was not granted');

  const { messaging, registration, getToken } = await messagingClient();
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Unable to create a push notification subscription');
  return token;
}

export async function unsubscribeFromPush() {
  const { messaging, registration, getToken, deleteToken } = await messagingClient();
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  await deleteToken(messaging);
  return token;
}
