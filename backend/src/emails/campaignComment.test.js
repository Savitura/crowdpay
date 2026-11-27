const test = require('node:test');
const assert = require('node:assert/strict');

const campaignComment = require('./campaignComment');
const impactReportPublished = require('./impactReportPublished');

const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';

test('escapes backer names and comment bodies in creator notifications', () => {
  const { html } = campaignComment.buildForCreator({
    creatorName: 'Ada',
    commenterName: payload,
    campaignTitle: payload,
    campaignUrl: 'https://crowdpay.example/c/1',
    commentBody: payload,
    unsubscribeUrl: 'https://crowdpay.example/unsub',
  });

  assert.ok(!html.includes('<script>'), 'raw script tag must not survive');
  assert.ok(!html.includes('<img src=x'), 'raw img tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'comment body is escaped');
  assert.ok(html.includes('<strong>&lt;script&gt;'), 'intentional markup still renders');
});

test('escapes replier names and reply bodies in commenter notifications', () => {
  const { html } = campaignComment.buildForCommenter({
    commenterName: 'Backer',
    replierName: payload,
    campaignTitle: 'Clean water',
    campaignUrl: 'https://crowdpay.example/c/1',
    replyBody: payload,
    isCreatorReply: true,
    unsubscribeUrl: 'https://crowdpay.example/unsub',
  });

  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<strong>&lt;script&gt;'));
  assert.ok(html.includes('(Campaign Creator)'));
  assert.ok(html.includes('<em>"&lt;script&gt;'));
});

test('escapes the commenter-supplied fields but keeps the subject readable', () => {
  const { subject, text } = campaignComment.buildForCreator({
    creatorName: 'Ada',
    commenterName: 'Sam',
    campaignTitle: 'Books for Kaduna',
    campaignUrl: 'https://crowdpay.example/c/1',
    commentBody: 'When do you ship?',
    unsubscribeUrl: 'https://crowdpay.example/unsub',
  });

  assert.equal(subject, 'New question on "Books for Kaduna"');
  assert.ok(text.includes('Books for Kaduna'));
});

test('escapes impact report titles and summaries', () => {
  const { html } = impactReportPublished.buildForContributor({
    contributorName: 'Ada',
    campaignTitle: payload,
    reportTitle: payload,
    reportSummary: payload,
    campaignUrl: 'https://crowdpay.example/c/1',
    unsubscribeUrl: 'https://crowdpay.example/unsub',
  });

  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<strong>"&lt;script&gt;'));
  assert.ok(html.includes('<em>&lt;script&gt;'));
});
