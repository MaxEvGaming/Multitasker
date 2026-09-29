import webpush from 'web-push';
import { q } from './db.js';

const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';

export const pushConfigured = Boolean(publicKey && privateKey);
if (pushConfigured) webpush.setVapidDetails(subject, publicKey, privateKey);

export function vapidPublicKey() {
  return publicKey;
}

export async function subscriptionsFor(userId) {
  return q(
    'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
    [userId]
  );
}

// Sends to every device the user has registered. A 404 or 410 means the browser
// threw the subscription away — the web app was deleted, or iOS cleared it after
// a long idle spell — so the row is removed rather than retried forever.
// The message is passed through as given. For an unencrypted account that is a
// title and a sentence; for an encrypted one it is ciphertext and a code, and
// the worker on the phone makes it readable. Either way this function does not
// look inside.
export async function notify(userId, message) {
  if (!pushConfigured) return { sent: 0, reason: 'push not configured' };

  const subs = await subscriptionsFor(userId);
  if (subs.length === 0) return { sent: 0, reason: 'no devices registered' };

  const payload = JSON.stringify({ ...message, timestamp: Date.now() });
  let sent = 0;
  const dead = [];

  await Promise.all(subs.map(async (sub) => {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(target, payload, { TTL: 600, urgency: 'high' });
      sent += 1;
    } catch (err) {
      const code = err.statusCode || 0;
      if (code === 404 || code === 410) dead.push(sub.id);
      else console.error(`push failed (${code}): ${err.body || err.message}`);
    }
  }));

  if (dead.length) {
    await q('delete from push_subscriptions where id = any($1::bigint[])', [dead]);
  }
  return { sent, dropped: dead.length };
}
