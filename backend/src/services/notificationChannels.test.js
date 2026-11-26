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

test('isCriticalEvent recognises all critical event types and rejects non-critical types', () => {
  const { mod } = loadChannels();
  for (const type of [
    'campaign_deadline',
    'withdrawal_approved',
    'withdrawal_rejected',
    'campaign_failed',
    'refund_available',
    'funds_released',
    'dispute_opened',
    'dispute_resolved',
  ]) {
    assert.equal(mod.isCriticalEvent(type), true);
  }
  assert.equal(mod.isCriticalEvent('campaign_update'), false);
  assert.equal(mod.isCriticalEvent(''), false);
});

test('messageText joins non-empty title, body, and link without blank lines', () => {
  const { mod } = loadChannels();
  assert.equal(mod.messageText({ title: 'T', body: 'B', link: 'https://x' }), 'T\nB\nhttps://x');
  assert.equal(mod.messageText({ title: 'T', body: '', link: null }), 'T');
  assert.equal(mod.messageText({ title: 'T', link: 'https://x' }), 'T\nhttps://x');
});

test('deliver returns false for unsupported channels (in_app, email, unknown)', async () => {
  const globalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200 };
  };
  try {
    const { mod } = loadChannels();
    const settings = {
      push_token: 'tok',
      slack_webhook_url: 'https://slack',
      discord_webhook_url: 'https://discord',
      sms_phone_number: '+15550001111',
    };
    assert.equal(await mod.deliver('in_app', settings, { type: 't', title: 'hi' }), false);
    assert.equal(await mod.deliver('email', settings, { type: 't', title: 'hi' }), false);
    assert.equal(await mod.deliver('pagerduty', settings, { type: 't', title: 'hi' }), false);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = globalFetch;
  }
});

test('deliver push: posts payload when PUSH_PROVIDER_URL is configured and skips gracefully when unset', async () => {
  const globalFetch = global.fetch;
  const prevUrl = process.env.PUSH_PROVIDER_URL;
  const calls = [];
  const infos = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  try {
    const mod = proxyquire('./notificationChannels', {
      '../config/logger': {
        info: (msg, meta) => infos.push({ msg, meta }),
        error: () => {},
        warn: () => {},
      },
    });

    // Provider unset -> graceful fallback without HTTP call
    delete process.env.PUSH_PROVIDER_URL;
    const skippedOk = await mod.deliver(
      'push',
      { push_token: 'device-token-1' },
      { type: 'funds_released', title: 'Released', body: 'Milestone 1', link: 'https://app/m1' }
    );
    assert.equal(skippedOk, true);
    assert.equal(calls.length, 0);
    assert.equal(infos.length, 1);

    // Provider configured -> posts structured push payload
    process.env.PUSH_PROVIDER_URL = 'https://push.provider.test/send';
    const sentOk = await mod.deliver(
      'push',
      { push_token: 'device-token-1' },
      { type: 'funds_released', title: 'Released', body: 'Milestone 1', link: 'https://app/m1' }
    );
    assert.equal(sentOk, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://push.provider.test/send');
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      to: 'device-token-1',
      title: 'Released',
      body: 'Milestone 1',
      data: { link: 'https://app/m1', type: 'funds_released' },
    });
  } finally {
    global.fetch = globalFetch;
    if (prevUrl === undefined) delete process.env.PUSH_PROVIDER_URL;
    else process.env.PUSH_PROVIDER_URL = prevUrl;
  }
});

test('deliver sms: posts payload without link when SMS_PROVIDER_URL is configured and skips when unset', async () => {
  const globalFetch = global.fetch;
  const prevUrl = process.env.SMS_PROVIDER_URL;
  const calls = [];
  const infos = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  try {
    const mod = proxyquire('./notificationChannels', {
      '../config/logger': {
        info: (msg, meta) => infos.push({ msg, meta }),
        error: () => {},
        warn: () => {},
      },
    });

    // Provider unset -> graceful fallback without HTTP call
    delete process.env.SMS_PROVIDER_URL;
    const skippedOk = await mod.deliver(
      'sms',
      { sms_phone_number: '+15551234567' },
      { type: 'withdrawal_approved', title: 'Approved', body: 'Sent to wallet', link: 'https://x' }
    );
    assert.equal(skippedOk, true);
    assert.equal(calls.length, 0);
    assert.equal(infos.length, 1);

    // Provider configured -> posts SMS payload omitting link
    process.env.SMS_PROVIDER_URL = 'https://sms.provider.test/messages';
    const sentOk = await mod.deliver(
      'sms',
      { sms_phone_number: '+15551234567' },
      { type: 'withdrawal_approved', title: 'Approved', body: 'Sent to wallet', link: 'https://x' }
    );
    assert.equal(sentOk, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://sms.provider.test/messages');
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      to: '+15551234567',
      message: 'Approved\nSent to wallet',
    });
  } finally {
    global.fetch = globalFetch;
    if (prevUrl === undefined) delete process.env.SMS_PROVIDER_URL;
    else process.env.SMS_PROVIDER_URL = prevUrl;
  }
});

test('deliver catches network/timeout errors, logs them, and returns false without throwing', async () => {
  const errors = [];
  const mod = proxyquire('./notificationChannels', {
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: (msg, meta) => errors.push({ msg, meta }),
    },
    '../utils/fetchWithTimeout': {
      fetchWithTimeout: async () => {
        throw new Error('request timed out');
      },
    },
  });

  const ok = await mod.deliver(
    'discord',
    { discord_webhook_url: 'https://discord.test/hook' },
    { type: 'dispute_opened', title: 'Dispute' }
  );
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.channel, 'discord');
  assert.equal(errors[0].meta.type, 'dispute_opened');
  assert.equal(errors[0].meta.error, 'request timed out');
});

test('deliver returns false and logs error when push or sms provider returns non-2xx status', async () => {
  const prevPush = process.env.PUSH_PROVIDER_URL;
  const prevSms = process.env.SMS_PROVIDER_URL;
  process.env.PUSH_PROVIDER_URL = 'https://push.provider.test/send';
  process.env.SMS_PROVIDER_URL = 'https://sms.provider.test/messages';
  const errors = [];
  const mod = proxyquire('./notificationChannels', {
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: (msg, meta) => errors.push({ msg, meta }),
    },
    '../utils/fetchWithTimeout': {
      fetchWithTimeout: async url => ({
        ok: false,
        status: url.includes('push') ? 503 : 502,
      }),
    },
  });

  try {
    const pushOk = await mod.deliver(
      'push',
      { push_token: 'tok-1' },
      { type: 'campaign_failed', title: 'Failed' }
    );
    const smsOk = await mod.deliver(
      'sms',
      { sms_phone_number: '+15550001111' },
      { type: 'refund_available', title: 'Refund' }
    );
    assert.equal(pushOk, false);
    assert.equal(smsOk, false);
    assert.equal(errors.length, 2);
    assert.equal(errors[0].meta.error, 'webhook responded 503');
    assert.equal(errors[1].meta.error, 'webhook responded 502');
  } finally {
    if (prevPush === undefined) delete process.env.PUSH_PROVIDER_URL;
    else process.env.PUSH_PROVIDER_URL = prevPush;
    if (prevSms === undefined) delete process.env.SMS_PROVIDER_URL;
    else process.env.SMS_PROVIDER_URL = prevSms;
  }
});
