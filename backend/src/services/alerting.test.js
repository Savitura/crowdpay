const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_URL = process.env.ALERT_WEBHOOK_URL;

function restoreFetch(original) {
  if (original === undefined) delete global.fetch;
  else global.fetch = original;
}

describe('sendAlert', { concurrency: 1 }, () => {
  beforeEach(() => {
    delete require.cache[require.resolve('./alerting')];
    delete process.env.ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = ORIGINAL_URL;
  });

  test('does nothing when no webhook is configured', async () => {
    let called = false;
    const original = global.fetch;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200 };
    };
    try {
      const { sendAlert } = require('./alerting');
      await sendAlert('ignored');
      assert.equal(called, false);
    } finally {
      restoreFetch(original);
    }
  });

  test('posts the alert payload to the webhook', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.test/hook';
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };
    try {
      const { sendAlert } = require('./alerting');
      await sendAlert('Treasury drift', { campaignId: 'camp-1' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://alerts.test/hook');
      assert.equal(calls[0].opts.method, 'POST');
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.text, '*[CrowdPay Alert]* Treasury drift');
      assert.equal(body.attachments[0].color, 'danger');
      assert.match(body.attachments[0].text, /camp-1/);
    } finally {
      restoreFetch(original);
    }
  });

  test('omits attachments when no context is provided', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.test/hook';
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };
    try {
      const { sendAlert } = require('./alerting');
      await sendAlert('Plain');
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.attachments, undefined);
    } finally {
      restoreFetch(original);
    }
  });

  test('does not throw when the webhook is rate limited', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.test/hook';
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 429 });
    try {
      const { sendAlert } = require('./alerting');
      await sendAlert('Too many');
    } finally {
      restoreFetch(original);
    }
  });

  test('does not throw when the webhook times out', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.test/hook';
    const original = global.fetch;
    global.fetch = async () => {
      throw new Error('The operation was aborted due to timeout');
    };
    try {
      const { sendAlert } = require('./alerting');
      await sendAlert('Timed out');
    } finally {
      restoreFetch(original);
    }
  });
});
