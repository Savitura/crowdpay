const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EMAILS_DIR = __dirname;
const UNSUBSCRIBE_URL = 'https://crowdpay.io/unsubscribe?token=unsub-token-123';

const XSS_PAYLOAD = '<script>alert("xss")</script>';
const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>';
const ESCAPED_SCRIPT = '&lt;script&gt;';

const CAMPAIGN_URL = 'https://crowdpay.io/campaigns/clean-water';

function campaignFixture(overrides = {}) {
  return {
    title: 'Clean water for Kano',
    raisedLabel: '4,200 USDC',
    targetLabel: '10,000 USDC',
    progressPercent: 42,
    isNew: true,
    category: 'Community',
    updates: ['We broke ground on the first well.'],
    milestones: ['Well #1 completed'],
    statusChanges: ['Campaign moved from draft to active'],
    upcomingDeadlines: ['Final milestone due 2026-12-01'],
    campaignUrl: CAMPAIGN_URL,
    ...overrides,
  };
}

// One entry per exported builder. `args` are realistic values; every template
// also receives `unsubscribeUrl` so the footer link is exercised.
const REGISTRY = {
  'campaignComment.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      commenterName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      commentBody: 'When will the second well break ground?',
    },
    buildForCommenter: {
      commenterName: 'John Doe',
      replierName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      replyBody: 'Next month, as soon as the permits clear.',
      isCreatorReply: true,
    },
  },
  'campaignDeadlineReminder.js': {
    build: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      hoursLeft: 12,
      targetAmount: '10,000 USDC',
      raisedAmount: '4,200 USDC',
    },
  },
  'campaignFailed.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      targetAmount: '10,000 USDC',
      raisedAmount: '4,200 USDC',
      deadlineText: 'November 20, 2026',
    },
    buildForContributor: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      refundsUrl: 'https://crowdpay.io/dashboard/refunds',
    },
  },
  'campaignFraudFlagged.js': {
    build: {
      adminName: 'Platform Admin',
      campaignTitle: 'Clean water for Kano',
      campaignId: '00000000-0000-0000-0000-000000000010',
      score: 82,
      breakdown: {
        velocity: { score: 40, detail: '18 contributions in 2 minutes' },
        geography: { score: 42, detail: 'Contributors share a single device' },
      },
      autoSuspended: true,
    },
  },
  'campaignFunded.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      targetAmount: '10,000 USDC',
      raisedAmount: '10,050 USDC',
    },
    buildForContributor: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
    },
  },
  'campaignUpdatePosted.js': {
    build: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      updateTitle: 'First well is live',
      updateExcerpt: 'Water is flowing for 400 households.',
      updateBody: 'Water is flowing for 400 households. Thank you all.',
    },
  },
  'contributionReceipt.js': {
    build: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      amount: '50',
      asset: 'USDC',
      txHash: 'a1b2c3d4e5f6',
      date: 'November 24, 2026',
    },
  },
  'disputeOpened.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      reason: 'Milestone evidence missing',
    },
    buildForAdmin: {
      campaignTitle: 'Clean water for Kano',
      campaignId: '00000000-0000-0000-0000-000000000010',
      raisedByName: 'John Doe',
      reason: 'Milestone evidence missing',
      description: 'No proof was uploaded for milestone 2.',
      adminUrl: 'https://crowdpay.io/admin/disputes/1',
    },
  },
  'disputeResolved.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      outcome: 'Resolved in favour of the creator',
      resolutionNote: 'Evidence was supplied retroactively.',
      campaignUrl: CAMPAIGN_URL,
    },
    buildForContributor: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      outcome: 'Resolved in favour of the creator',
      campaignUrl: CAMPAIGN_URL,
    },
  },
  'fundsReleased.js': {
    buildContributorRelease: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      amount: '500',
      asset: 'USDC',
      txHash: 'f00dbabe1234',
      usage: 'Milestone 1: well drilling',
      recipient: 'GAAAA...CREATOR',
    },
  },
  'impactReportPublished.js': {
    buildForContributor: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      reportTitle: '2026 impact report',
      reportSummary: '412 households now have clean water.',
      campaignUrl: CAMPAIGN_URL,
    },
  },
  'kycApproved.js': {
    build: {
      name: 'Amina Bello',
      dashboardUrl: 'https://crowdpay.io/dashboard',
    },
  },
  'kycRejected.js': {
    build: {
      name: 'Amina Bello',
      reason: 'The document photo was blurry.',
      retryUrl: 'https://crowdpay.io/kyc/retry',
    },
  },
  'milestoneEvidenceSubmitted.js': {
    buildForAdmin: {
      adminName: 'Platform Admin',
      campaignTitle: 'Clean water for Kano',
      milestoneTitle: 'Well #1 completed',
      evidenceUrl: 'https://cdn.crowdpay.io/evidence/1.jpg',
      evidenceDescription: 'Photos of the completed well.',
      creatorName: 'Amina Bello',
      adminUrl: 'https://crowdpay.io/admin/milestones/1',
    },
  },
  'milestoneReleased.js': {
    buildForCreator: {
      creatorName: 'Amina Bello',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      milestoneTitle: 'Well #1 completed',
      amount: '2,000',
      asset: 'USDC',
      txHash: 'deadbeef1234',
    },
    buildForContributor: {
      contributorName: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      milestoneTitle: 'Well #1 completed',
    },
  },
  'recurringContributionNotice.js': {
    buildUpcoming: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      amount: '25',
      asset: 'USDC',
      scheduledAt: '2026-12-01T09:00:00.000Z',
      manageUrl: 'https://crowdpay.io/dashboard/recurring',
    },
    buildCharged: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      amount: '25',
      asset: 'USDC',
      txHash: 'cafebabe1234',
      campaignUrl: CAMPAIGN_URL,
    },
    buildFailed: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      amount: '25',
      asset: 'USDC',
      manageUrl: 'https://crowdpay.io/dashboard/recurring',
    },
  },
  'teamMemberInvited.js': {
    build: {
      campaignTitle: 'Clean water for Kano',
      role: 'treasurer',
      inviteUrl: 'https://crowdpay.io/invites/abc123',
    },
  },
  'thankYou.js': {
    build: {
      name: 'John Doe',
      campaignTitle: 'Clean water for Kano',
      message: 'Your early support made the first well possible.',
      campaignUrl: CAMPAIGN_URL,
    },
  },
  'walletFundingFailed.js': {
    build: {
      name: 'Amina Bello',
      walletPublicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
  },
  'weeklyDigest.js': {
    build: {
      name: 'John Doe',
      campaigns: [campaignFixture(), campaignFixture({ title: 'Solar for schools', isNew: false })],
      digestUrl: 'https://crowdpay.io/dashboard/contributions',
      windowLabel: 'Nov 17 – Nov 24, 2026',
    },
  },
  'welcome.js': {
    build: {
      name: 'Amina Bello',
      walletPublicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
  },
  'withdrawalApproved.js': {
    build: {
      creatorName: 'Amina Bello',
      amount: '1,500',
      asset: 'USDC',
      campaignTitle: 'Clean water for Kano',
      campaignUrl: CAMPAIGN_URL,
      txHash: '0badf00d1234',
    },
  },
  'withdrawalRejected.js': {
    build: {
      creatorName: 'Amina Bello',
      amount: '1,500',
      asset: 'USDC',
      campaignTitle: 'Clean water for Kano',
      reason: 'Recipient wallet does not belong to the campaign.',
    },
  },
};

function templateFiles() {
  return fs
    .readdirSync(EMAILS_DIR)
    .filter(file => file.endsWith('.js') && file !== 'layout.js' && !file.endsWith('.test.js'))
    .sort();
}

function withUnsubscribe(args) {
  return { ...args, unsubscribeUrl: UNSUBSCRIBE_URL };
}

function renderAll(argsTransform) {
  const rendered = [];
  for (const [file, builders] of Object.entries(REGISTRY)) {
    const mod = require(path.join(EMAILS_DIR, file));
    for (const [builder, args] of Object.entries(builders)) {
      assert.equal(typeof mod[builder], 'function', `${file} must export ${builder}()`);
      rendered.push({
        name: `${file}:${builder}`,
        result: mod[builder](argsTransform(withUnsubscribe(args))),
      });
    }
  }
  return rendered;
}

function replaceStringsDeep(value, replacement) {
  if (typeof value === 'string') return replacement(value);
  if (Array.isArray(value)) return value.map(item => replaceStringsDeep(item, replacement));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceStringsDeep(item, replacement)])
    );
  }
  return value;
}

test('every transactional email template is covered by the test registry', () => {
  assert.deepEqual(Object.keys(REGISTRY).sort(), templateFiles());
});

test('each builder returns a complete subject, plaintext body and HTML document', () => {
  for (const { name, result } of renderAll(args => args)) {
    assert.equal(typeof result.subject, 'string', `${name} must return a subject`);
    assert.ok(result.subject.trim().length > 0, `${name} returned an empty subject`);
    assert.equal(
      /[\r\n]/.test(result.subject),
      false,
      `${name} subject must be a single line to avoid header injection`
    );

    assert.equal(typeof result.text, 'string', `${name} must return plaintext`);
    assert.ok(result.text.trim().length > 0, `${name} returned an empty plaintext body`);
    assert.equal(
      /<[a-z][^>]*>/i.test(result.text),
      false,
      `${name} plaintext body must not contain HTML tags`
    );

    assert.equal(typeof result.html, 'string', `${name} must return HTML`);
    assert.match(result.html, /^<!DOCTYPE html>/, `${name} HTML must be a full document`);
    assert.match(result.html, /<\/html>$/, `${name} HTML must be closed`);
  }
});

test('each rendered email includes the unsubscribe link in the HTML footer', () => {
  for (const { name, result } of renderAll(args => args)) {
    assert.ok(
      result.html.includes('Unsubscribe from these emails'),
      `${name} is missing the unsubscribe footer`
    );
    assert.ok(
      result.html.includes(UNSUBSCRIBE_URL),
      `${name} is missing the unsubscribe URL in the footer`
    );
  }
});

test('rendered emails never contain placeholder artifacts', () => {
  for (const { name, result } of renderAll(args => args)) {
    for (const [field, value] of Object.entries(result)) {
      assert.equal(value.includes('undefined'), false, `${name}.${field} rendered "undefined"`);
      assert.equal(value.includes('[object Object]'), false, `${name}.${field} rendered an object`);
    }
  }
});

test('user-controlled values are HTML-escaped in every template', () => {
  for (const payload of [XSS_PAYLOAD, ATTR_PAYLOAD]) {
    const rendered = renderAll(args => replaceStringsDeep(args, () => payload));

    for (const { name, result } of rendered) {
      assert.equal(
        result.html.includes(payload),
        false,
        `${name} rendered unescaped user input into HTML`
      );
      assert.equal(/<script\b/i.test(result.html), false, `${name} emitted a raw <script> tag`);

      if (payload === XSS_PAYLOAD) {
        assert.ok(
          result.html.includes(ESCAPED_SCRIPT),
          `${name} did not escape the injected script payload`
        );
        assert.ok(
          result.text.includes(XSS_PAYLOAD),
          `${name} plaintext body should carry the raw text unchanged`
        );
        assert.equal(
          /[\r\n]/.test(result.subject),
          false,
          `${name} subject must stay single-line with hostile input`
        );
      }
    }
  }
});

test('hostile input cannot break out of href attributes', () => {
  const rendered = renderAll(args => replaceStringsDeep(args, () => ATTR_PAYLOAD));
  for (const { name, result } of rendered) {
    const anchors = result.html.match(/<a\b[^>]*>/gi) || [];
    assert.ok(anchors.length > 0, `${name} should render at least one link`);
    for (const anchor of anchors) {
      // Replacing quoted values with empty strings must leave only the tag and
      // its original attribute names. An injected attribute would survive.
      const skeleton = anchor.replace(/"[^"]*"/g, '""');
      assert.match(
        skeleton,
        /^<a(\s+[a-z-]+="")*\s*\/?>$/i,
        `${name} allowed user input to add attributes to an anchor: ${anchor}`
      );
      for (const value of anchor.match(/"[^"]*"/g) || []) {
        assert.equal(value.includes('<'), false, `${name} left a raw < inside an attribute value`);
        assert.equal(value.includes('>'), false, `${name} left a raw > inside an attribute value`);
      }
    }
  }
});

test('emails render with only required fields when optional values are omitted', () => {
  const mod = require('./kycRejected');
  const result = mod.build({ name: 'Amina Bello', retryUrl: 'https://crowdpay.io/kyc/retry' });
  assert.equal(result.text.includes('Reason:'), false);
  assert.equal(result.html.includes('Reason:'), false);
  assert.ok(result.html.includes('https://crowdpay.io/kyc/retry'));

  const disputeResolved = require('./disputeResolved');
  const creator = disputeResolved.buildForCreator({
    creatorName: 'Amina Bello',
    campaignTitle: 'Clean water for Kano',
    outcome: 'Resolved',
    campaignUrl: CAMPAIGN_URL,
  });
  assert.equal(creator.text.includes('Note:'), false);

  const milestoneEvidence = require('./milestoneEvidenceSubmitted');
  const admin = milestoneEvidence.buildForAdmin({
    campaignTitle: 'Clean water for Kano',
    milestoneTitle: 'Well #1 completed',
    adminUrl: 'https://crowdpay.io/admin/milestones/1',
  });
  assert.ok(admin.text.includes('Well #1 completed'));
});

test('layout helpers escape values inserted into HTML attributes', () => {
  const { escapeHtml, link, renderLayout } = require('./layout');
  assert.equal(escapeHtml(`" onmouseover="alert(1)`), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(
    link('click', 'https://crowdpay.io/x?a=1&b=2'),
    '<a href="https://crowdpay.io/x?a=1&amp;b=2" target="_blank" style="color:#0f62fe;word-break:break-all;">click</a>'
  );
  const html = renderLayout({
    bodyHtml: '<p>hi</p>',
    unsubscribeUrl: 'https://crowdpay.io/u?a=1&b=2',
  });
  assert.ok(html.includes('https://crowdpay.io/u?a=1&amp;b=2'));
});
