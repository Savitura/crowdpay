const logger = require('../config/logger');

// Delivery adapters for each outbound notification channel. Each adapter is a
// pure async function `(destination, message) -> void` where `message` is
// `{ type, title, body, link }`. Adapters isolate the transport details
// (HTTP webhook shape, SMS provider, push provider) from the notification
// service, which only decides *whether* and *where* to deliver.

const CHANNELS = ['in_app', 'push', 'slack', 'discord', 'sms'];

// Events important enough to bypass quiet-hours batching and deliver
// immediately (issue #429: campaign deadline, withdrawal approved, etc).
const CRITICAL_EVENT_TYPES = new Set([
  'campaign_deadline',
  'withdrawal_approved',
  'withdrawal_rejected',
  'campaign_failed',
  'refund_available',
  'dispute_opened',
  'dispute_resolved',
]);

function isCriticalEvent(type) {
  return CRITICAL_EVENT_TYPES.has(type);
}

function messageText({ title, body, link }) {
  return [title, body, link].filter(Boolean).join('\n');
}

// POST a JSON body to a webhook URL with a bounded timeout. Shared by the
// Slack and Discord adapters, which differ only in payload shape.
async function postWebhook(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook responded ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverSlack(webhookUrl, message) {
  // Slack incoming-webhook payload: https://api.slack.com/messaging/webhooks
  await postWebhook(webhookUrl, { text: messageText(message) });
}

async function deliverDiscord(webhookUrl, message) {
  // Discord webhook payload: https://discord.com/developers/docs/resources/webhook
  await postWebhook(webhookUrl, { content: messageText(message) });
}

async function deliverPush(pushToken, message) {
  const endpoint = process.env.PUSH_PROVIDER_URL;
  if (!endpoint) {
    logger.info('Push provider not configured; skipping push notification', {
      type: message.type,
    });
    return;
  }
  await postWebhook(endpoint, {
    to: pushToken,
    title: message.title,
    body: message.body || '',
    data: { link: message.link || null, type: message.type },
  });
}

async function deliverSms(phoneNumber, message) {
  const endpoint = process.env.SMS_PROVIDER_URL;
  if (!endpoint) {
    logger.info('SMS provider not configured; skipping SMS notification', {
      type: message.type,
    });
    return;
  }
  await postWebhook(endpoint, {
    to: phoneNumber,
    message: messageText({ title: message.title, body: message.body }),
  });
}

const ADAPTERS = {
  push: deliverPush,
  slack: deliverSlack,
  discord: deliverDiscord,
  sms: deliverSms,
};

// Resolve the destination string for a channel from a channel-settings row.
function destinationFor(channel, settings) {
  if (!settings) return null;
  switch (channel) {
    case 'push':
      return settings.push_token || null;
    case 'slack':
      return settings.slack_webhook_url || null;
    case 'discord':
      return settings.discord_webhook_url || null;
    case 'sms':
      return settings.sms_phone_number || null;
    default:
      return null;
  }
}

// Deliver `message` over a single external channel. Returns true on success,
// false when there is no destination or delivery fails (failures are logged,
// never thrown, so one bad channel can't break the others).
async function deliver(channel, settings, message) {
  const adapter = ADAPTERS[channel];
  if (!adapter) return false;

  const destination = destinationFor(channel, settings);
  if (!destination) return false;

  try {
    await adapter(destination, message);
    return true;
  } catch (err) {
    logger.error('Notification channel delivery failed', {
      channel,
      type: message.type,
      error: err.message,
    });
    return false;
  }
}

module.exports = {
  CHANNELS,
  CRITICAL_EVENT_TYPES,
  isCriticalEvent,
  destinationFor,
  deliver,
  messageText,
};
