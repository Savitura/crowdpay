const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function hoursFromNow(date) {
  return (new Date(date).getTime() - Date.now()) / (60 * 60 * 1000);
}

function loadService({ campaignsForWindow, backers, sendImpl } = {}) {
  const campaignQueries = [];
  const backerQueries = [];
  const sent = [];
  const errors = [];
  const dedupeKeys = new Set();

  const service = proxyquire('./deadlineReminderService', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('FROM campaigns')) {
          campaignQueries.push(params);
          const hoursLeft = Math.round(hoursFromNow(params[0]));
          const rows =
            typeof campaignsForWindow === 'function'
              ? campaignsForWindow(hoursLeft)
              : campaignsForWindow || [];
          return { rows };
        }
        if (text.includes('FROM contributions')) {
          backerQueries.push(params);
          return { rows: backers || [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
    '../config/logger': {
      info: () => {},
      error: (message, meta) => errors.push({ message, meta }),
      warn: () => {},
    },
    './emailService': {
      sendCampaignDeadlineReminderEmail: async payload => {
        const dedupeKey = `campaign_deadline_reminder:${payload.campaignId}:${payload.hoursLeft}:${payload.to}`;
        if (sendImpl) return sendImpl(payload, dedupeKey);
        if (dedupeKeys.has(dedupeKey)) return;
        dedupeKeys.add(dedupeKey);
        sent.push({ ...payload, dedupeKey });
      },
    },
  });

  return { service, campaignQueries, backerQueries, sent, errors, dedupeKeys };
}

const campaign = {
  id: 'camp-1',
  title: 'Solar Garden',
  target_amount: '1000',
  raised_amount: '400',
};

const backers = [
  { id: 'user-1', email: 'ada@example.com', name: 'Ada' },
  { id: 'user-2', email: 'grace@example.com', name: 'Grace' },
];

describe('deadline reminders', { concurrency: 1 }, () => {
  test('queries the 48 hour and 12 hour windows and emails each backer once per window', async () => {
    const { service, campaignQueries, backerQueries, sent } = loadService({
      campaignsForWindow: () => [campaign],
      backers,
    });

    await service.sendDeadlineReminders();

    assert.equal(campaignQueries.length, 2);
    const windows = campaignQueries.map(params => Math.round(hoursFromNow(params[0])));
    assert.deepEqual(
      windows.sort((a, b) => a - b),
      [12, 48]
    );
    for (const params of campaignQueries) {
      const span = hoursFromNow(params[0]) - hoursFromNow(params[1]);
      assert.ok(span > 11 && span < 13);
    }

    assert.equal(backerQueries.length, 2);
    assert.deepEqual(backerQueries[0], ['camp-1']);
    assert.equal(sent.length, 4);
    assert.deepEqual(sent.map(item => item.dedupeKey).sort(), [
      'campaign_deadline_reminder:camp-1:12:ada@example.com',
      'campaign_deadline_reminder:camp-1:12:grace@example.com',
      'campaign_deadline_reminder:camp-1:48:ada@example.com',
      'campaign_deadline_reminder:camp-1:48:grace@example.com',
    ]);
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    assert.equal(sent[0].campaignTitle, 'Solar Garden');
    assert.equal(sent[0].campaignUrl, `${frontendBase}/campaigns/camp-1`);
    assert.equal(sent[0].contributorName, 'Ada');
  });

  test('does not send a second reminder for the same campaign, window, and recipient', async () => {
    const { service, sent } = loadService({
      campaignsForWindow: hoursLeft => (hoursLeft === 48 ? [campaign] : []),
      backers: [backers[0]],
    });

    await service.sendDeadlineReminders();
    await service.sendDeadlineReminders();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].hoursLeft, 48);
    assert.equal(sent[0].to, 'ada@example.com');
  });

  test('keeps dispatching when one reminder send fails', async () => {
    const { service, sent, errors } = loadService({
      campaignsForWindow: hoursLeft => (hoursLeft === 48 ? [campaign] : []),
      backers,
      sendImpl: async payload => {
        if (payload.to === 'ada@example.com') throw new Error('smtp down');
        sent.push(payload);
      },
    });

    await service.sendDeadlineReminders();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'grace@example.com');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.email, 'ada@example.com');
    assert.equal(errors[0].meta.campaignId, 'camp-1');
  });

  test('logs and swallows a database failure', async () => {
    const errors = [];
    const service = proxyquire('./deadlineReminderService', {
      '../config/database': {
        query: async () => {
          throw new Error('db unavailable');
        },
      },
      '../config/logger': {
        info: () => {},
        error: (message, meta) => errors.push({ message, meta }),
        warn: () => {},
      },
      './emailService': { sendCampaignDeadlineReminderEmail: async () => {} },
    });

    await service.sendDeadlineReminders();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.error, 'db unavailable');
  });
});
