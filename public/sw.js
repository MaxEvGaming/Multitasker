// The worker on the phone. Two jobs: show what arrives, and — for an encrypted
// account — make it readable first, because the server that sent it could not.
//
// Two rules here are iOS quirks rather than preferences:
//   1. Every push MUST end in a visible notification. If one arrives and nothing
//      is shown, iOS revokes the subscription and the phone goes quiet for good.
//      So every path below, including every failure, still shows something.
//   2. The payload may be absent or unparseable. Falling back is better than
//      throwing, because throwing means (1).
// Registered as a module worker so this import works at all. That needs iOS
// 16.4, which is already the floor for web push on a phone, so it costs nothing
// that was not already spent.
import { recallMaster, subKeysFrom, decryptText } from '/crypto.js';
import { t, setLang } from '/i18n.js';

// The words come from the same book the screens use. Which language, though,
// has to travel with the notification: a worker wakes with no page and no
// session, so it cannot go and ask, and the phone may have been asleep since
// before the language was last changed.
const REASON = {
  signal: 'why.signal', timeout: 'why.timeout', unmatched: 'why.unmatched',
  // The PC's answers to a command square, and the absence of one.
  done: 'why.done', failed: 'why.failed', expired: 'why.expired',
};

async function readable(payload) {
  // Nothing sealed: an account that has not been switched over.
  setLang(payload.lang || 'en');

  if (!payload.titleCipher && !payload.toCipher) {
    return { title: payload.title || 'Claude', body: payload.body || '' };
  }

  try {
    const master = await recallMaster();
    if (!master) {
      // The key is not on this device — signed out, or never unlocked here.
      // Say that something happened without pretending to know what.
      return { title: t('app.title'), body: t('push.locked') };
    }

    const { dataKey } = await subKeysFrom(master);
    const [title, from, to] = await Promise.all([
      decryptText(dataKey, payload.titleCipher),
      decryptText(dataKey, payload.fromCipher),
      decryptText(dataKey, payload.toCipher),
    ]);

    const why = REASON[payload.reason] ? t(REASON[payload.reason]) : '';
    return {
      title: title
        || (payload.slot !== undefined ? t('board.square', { n: payload.slot + 1 }) : t('app.title')),
      body: from && to ? t('why.where', { why, from, to }) : why,
    };
  } catch (_) {
    return { title: t('app.title'), body: t('push.arrived') };
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    const { title, body } = await readable(payload);
    await self.registration.showNotification(title, {
      body,
      tag: payload.tag || undefined,      // same tag replaces rather than stacks
      renotify: Boolean(payload.tag),
      data: { url: payload.url || '/' },
      icon: '/icon-180.png',
      badge: '/icon-180.png',
      timestamp: payload.timestamp || Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow ? clients.openWindow(url) : undefined;
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
