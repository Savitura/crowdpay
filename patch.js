const fs = require('fs');
let content = fs.readFileSync('backend/src/services/emailService.js', 'utf8');

const mappings = {
  sendWelcomeEmail: 'marketing',
  sendRecurringContributionNoticeEmail: 'campaign_update',
  sendCampaignFundedCreatorEmail: 'campaign_update',
  sendCampaignFundedContributorEmail: 'campaign_update',
  sendCampaignFailedCreatorEmail: 'campaign_update',
  sendCampaignFailedContributorEmail: 'campaign_update',
  sendWithdrawalApprovedEmail: 'milestone',
  sendWithdrawalRejectedEmail: 'milestone',
  sendMilestoneReleasedCreatorEmail: 'milestone',
  sendMilestoneReleasedContributorEmail: 'milestone',
  sendContributorFundsReleasedEmail: 'milestone',
  sendMilestoneEvidenceSubmittedAdminEmail: 'milestone',
  sendKycApprovedEmail: 'campaign_update',
  sendKycRejectedEmail: 'campaign_update',
  sendDisputeOpenedCreatorEmail: 'dispute',
  sendDisputeOpenedAdminEmail: 'dispute',
  sendDisputeResolvedCreatorEmail: 'dispute',
  sendDisputeResolvedContributorEmail: 'dispute',
  sendTeamMemberInvitedEmail: 'campaign_update',
  sendCampaignFraudFlaggedEmail: 'dispute',
  sendWalletFundingFailedEmail: 'campaign_update',
  sendCampaignCommentEmail: 'campaign_update',
  sendCommentReplyEmail: 'campaign_update',
};

content = content.replace(
  'async function isUnsubscribed(email, category) {\n  const { rows } = await db.query(\n    "SELECT 1 FROM email_unsubscribes WHERE email = $1 AND category = $2",\n    [email.toLowerCase(), category],\n  );\n  return rows.length > 0;\n}',
  `async function isCategoryEnabled(email, category) {
  let mappedCategory = category;
  if (category === 'campaign_update') mappedCategory = 'campaign_updates';
  else if (category === 'weekly_digest') mappedCategory = 'marketing';
  else if (category === 'refund') mappedCategory = 'refunds';
  else if (category === 'dispute') mappedCategory = 'disputes';
  else if (category === 'milestone') mappedCategory = 'milestones';
  
  const { rows: users } = await db.query(
    "SELECT id FROM users WHERE email = $1",
    [email.toLowerCase()]
  );
  if (!users.length) return true;

  const { rows } = await db.query(
    \`SELECT \${mappedCategory} as enabled FROM notification_preferences WHERE user_id = $1\`,
    [users[0].id]
  );
  
  if (!rows.length) {
    if (mappedCategory === 'marketing') return false;
    return true;
  }
  
  return rows[0].enabled;
}

async function isUnsubscribed(email, category) {
  return !(await isCategoryEnabled(email, category));
}`
);

for (const [method, cat] of Object.entries(mappings)) {
  const methodRegex = new RegExp('(async function ' + method + '\\(\\{[^}]+\\}\\) \\{\\s*)(if \\(\\!to\\) return;\\s*)?');
  content = content.replace(methodRegex, (match, p1, p2) => {
    return p1 + (p2 || '') + `  if (await isUnsubscribed(to, '${cat}')) return;\n  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: '${cat}' });\n`;
  });
}

// Replace params with { ...params, unsubscribeUrl } for each builder
content = content.replace(/\.build(ForCreator|ForContributor|ForAdmin|ForCommenter)?\(params\)/g, '.build$1({ ...params, unsubscribeUrl })');
content = content.replace(/\.build(ForCreator|ForContributor)?\(\{ outcome, \.\.\.params \}\)/g, '.build$1({ outcome, ...params, unsubscribeUrl })');
content = content.replace(/\.build(ForCreator|ForCommenter)?\(\{ \.\.\.params, campaignUrl \}\)/g, '.build$1({ ...params, campaignUrl, unsubscribeUrl })');
content = content.replace(/\.build\(\{ campaignId, \.\.\.params \}\)/g, '.build({ campaignId, ...params, unsubscribeUrl })');
content = content.replace(/\.build\(\{ name, walletPublicKey \}\)/g, '.build({ name, walletPublicKey, unsubscribeUrl })');

// Manual patch for sendContributionReceipt
content = content.replace(
  'const { subject, text, html } = contributionReceiptEmail.build({',
  `if (await isUnsubscribed(users[0].email, 'refund')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: users[0].email, category: 'refund' });
  const { subject, text, html } = contributionReceiptEmail.build({`
);
content = content.replace(
  'date: new Date().toISOString(),',
  'date: new Date().toISOString(),\n    unsubscribeUrl,'
);

// Add buildUnsubscribeUrl import at the top
if (!content.includes('buildUnsubscribeUrl')) {
  content = content.replace(
    'const { db } = require("../db");',
    'const { db } = require("../db");\nconst { buildUnsubscribeUrl } = require("../utils/unsubscribeToken");'
  );
}

// Special case for sendRecurringContributionNoticeEmail
content = content.replace(
  /if \(kind === 'upcoming'\) built = recurringContributionNoticeEmail\.buildUpcoming\(params\);\s+else if \(kind === 'charged'\) built = recurringContributionNoticeEmail\.buildCharged\(params\);\s+else built = recurringContributionNoticeEmail\.buildFailed\(params\);/,
  `if (kind === 'upcoming') built = recurringContributionNoticeEmail.buildUpcoming({ ...params, unsubscribeUrl });
  else if (kind === 'charged') built = recurringContributionNoticeEmail.buildCharged({ ...params, unsubscribeUrl });
  else built = recurringContributionNoticeEmail.buildFailed({ ...params, unsubscribeUrl });`
);

fs.writeFileSync('backend/src/services/emailService.js', content);
console.log('Patched emailService.js correctly!');
