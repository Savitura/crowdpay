const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadChannels(fetchImpl) {
  const calls = [];
  const wrappedFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (fetchImpl) return fetchImpl(url, opts);
    return { ok: true, status: 200 };
  };
  const mod = proxyquire('./notificationChannels', {
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
  });
  return { mod, calls, wrappedFetch };
}

test('isCriticalEvent recognises deadline and withdrawal events', () => {
  const { mod } = loadChannels();
  assert.equal(mod.isCriticalEvent('campaign_deadline'), true);
  assert.equal(mod.isCriticalEvent('withdrawal_approved'), true);
  assert.equal(mod.isCriticalEvent('thank_you'), false);
});

test('destinationFor maps each channel to the right settings column', () => {
  const { mod } = loadChannels();
  const settings = {
    push_token: 'tok',
    slack_webhook_url: 'https://slack',
    discord_webhook_url: 'https://discord',
    sms_phone_number: '+15550001111',
  };
  assert.equal(mod.destinationFor('push', settings), 'tok');
  assert.equal(mod.destinationFor('slack', settings), 'https://slack');
  assert.equal(mod.destinationFor('discord', settings), 'https://discord');
  assert.equal(mod.destinationFor('sms', settings), '+15550001111');
  assert.equal(mod.destinationFor('in_app', settings), null);
  assert.equal(mod.destinationFor('slack', null), null);
});

test('deliver returns false and does not throw when no destination configured', async () => {
  const { mod } = loadChannels();
  const ok = await mod.deliver('slack', { slack_webhook_url: null }, { type: 't', title: 'hi' });
  assert.equal(ok, false);
});

test('deliver posts a Slack-shaped payload to the configured webhook', async () => {
  const globalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  try {
    const { mod } = loadChannels();
    const ok = await mod.deliver(
      'slack',
      { slack_webhook_url: 'https://hooks.slack.test/abc' },
      { type: 'campaign_update', title: 'New update', body: 'Body', link: 'https://app/x' }
    );
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hooks.slack.test/abc');
    const payload = JSON.parse(calls[0].opts.body);
    assert.ok(payload.text.includes('New update'));
    assert.ok(payload.text.includes('Body'));
  } finally {
    global.fetch = globalFetch;
  }
});

test('deliver posts a Discord-shaped payload (content field)', async () => {
  const globalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  try {
    const { mod } = loadChannels();
    const ok = await mod.deliver(
      'discord',
      { discord_webhook_url: 'https://discord.test/hook' },
      { type: 'campaign_update', title: 'Hello' }
    );
    assert.equal(ok, true);
    const payload = JSON.parse(calls[0].opts.body);
    assert.ok(payload.content.includes('Hello'));
  } finally {
    global.fetch = globalFetch;
  }
});

test('deliver returns false when the webhook responds with an error status', async () => {
  const globalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    const { mod } = loadChannels();
    const ok = await mod.deliver(
      'slack',
      { slack_webhook_url: 'https://hooks.slack.test/abc' },
      { type: 't', title: 'hi' }
    );
    assert.equal(ok, false);
  } finally {
    global.fetch = globalFetch;
  }
});
