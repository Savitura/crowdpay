const nodemailer = require("nodemailer");
const db = require("../config/database");
const { getStellarExpertTxUrl } = require("../utils/stellarExplorer");
const { buildUnsubscribeUrl } = require("../utils/unsubscribeToken");

const welcomeEmail = require("../emails/welcome");
const contributionReceiptEmail = require("../emails/contributionReceipt");
const campaignFundedEmail = require("../emails/campaignFunded");
const campaignFailedEmail = require("../emails/campaignFailed");
const withdrawalApprovedEmail = require("../emails/withdrawalApproved");
const withdrawalRejectedEmail = require("../emails/withdrawalRejected");
const milestoneReleasedEmail = require("../emails/milestoneReleased");
const milestoneEvidenceSubmittedEmail = require("../emails/milestoneEvidenceSubmitted");
const kycApprovedEmail = require("../emails/kycApproved");
const kycRejectedEmail = require("../emails/kycRejected");
const disputeOpenedEmail = require("../emails/disputeOpened");
const disputeResolvedEmail = require("../emails/disputeResolved");
const campaignUpdatePostedEmail = require("../emails/campaignUpdatePosted");
const teamMemberInvitedEmail = require("../emails/teamMemberInvited");

let transporter;

const emailsDisabled =
  String(process.env.DISABLE_EMAILS || "").toLowerCase() === "true";

if (
  !emailsDisabled &&
  (process.env.SMTP_HOST || process.env.EMAIL_SERVICE_API_KEY)
) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.sendgrid.net",
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER || "apikey",
      pass: process.env.SMTP_PASS || process.env.EMAIL_SERVICE_API_KEY,
    },
  });
}

/**
 * Sends an email asynchronously.
 */
async function sendEmail({ to, subject, text, html }) {
  if (emailsDisabled) {
    console.log(`[Email Service Disabled] to: ${to} | subject: ${subject}`);
    return;
  }

  if (!transporter) {
    console.log(`[Email Service Mock] to: ${to} | subject: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"CrowdPay" <noreply@crowdpay.local>',
      to,
      subject,
      text: text || "",
      html: html || "",
    });
  } catch (error) {
    console.error(
      `[Email Service Error] Failed to send email to ${to}:`,
      error.message,
    );
    throw error;
  }
}

/**
 * Sends an email at most once per dedupeKey. Used to guard against duplicate
 * sends when a triggering event (webhook retry, route retry, etc) fires more
 * than once for the same logical occurrence.
 */
async function sendIdempotent({ dedupeKey, to, subject, text, html }) {
  if (!to) return;

  const { rows } = await db.query(
    `INSERT INTO sent_emails (dedupe_key, recipient_email)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [dedupeKey, to],
  );

  if (!rows.length) {
    console.log(`[Email Service] Skipped duplicate send for key: ${dedupeKey}`);
    return;
  }

  await sendEmail({ to, subject, text, html });
}

async function isUnsubscribed(email, category) {
  const { rows } = await db.query(
    "SELECT 1 FROM email_unsubscribes WHERE email = $1 AND category = $2",
    [email.toLowerCase(), category],
  );
  return rows.length > 0;
}

async function isCampaignUpdateUnsubscribed(email, campaignId) {
  const { rows } = await db.query(
    "SELECT 1 FROM campaign_update_unsubscribes WHERE email = $1 AND campaign_id = $2",
    [email.toLowerCase(), campaignId],
  );
  return rows.length > 0;
}

async function sendWelcomeEmail({ to, name, walletPublicKey }) {
  if (!to) return;
  const { subject, text, html } = welcomeEmail.build({ name, walletPublicKey });
  await sendIdempotent({ dedupeKey: `welcome:${to}`, to, subject, text, html });
}

async function sendContributionReceipt({
  campaignId,
  txHash,
  amount,
  asset,
  senderPublicKey,
}) {
  if (emailsDisabled) {
    console.log("[receipt] Email sending disabled via DISABLE_EMAILS=true");
    return;
  }

  const { rows: users } = await db.query(
    "SELECT email, name FROM users WHERE wallet_public_key = $1",
    [senderPublicKey],
  );

  if (!users.length || !users[0].email) {
    return;
  }

  const { rows: campaigns } = await db.query(
    "SELECT title FROM campaigns WHERE id = $1",
    [campaignId],
  );

  if (!campaigns.length) {
    return;
  }

  const { subject, text, html } = contributionReceiptEmail.build({
    name: users[0].name,
    campaignTitle: campaigns[0].title,
    amount,
    asset,
    txHash,
    date: new Date().toISOString(),
  });

  await sendIdempotent({
    dedupeKey: `contribution_receipt:${txHash}`,
    to: users[0].email,
    subject,
    text,
    html,
  });
}

async function sendCampaignFundedCreatorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  const { subject, text, html } = campaignFundedEmail.buildForCreator(params);
  await sendIdempotent({ dedupeKey: `campaign_funded_creator:${campaignId}`, to, subject, text, html });
}

async function sendCampaignFundedContributorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  const { subject, text, html } = campaignFundedEmail.buildForContributor(params);
  await sendIdempotent({ dedupeKey: `campaign_funded_contributor:${campaignId}:${to}`, to, subject, text, html });
}

async function sendCampaignFailedCreatorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  const { subject, text, html } = campaignFailedEmail.buildForCreator(params);
  await sendIdempotent({ dedupeKey: `campaign_failed_creator:${campaignId}`, to, subject, text, html });
}

async function sendCampaignFailedContributorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  const { subject, text, html } = campaignFailedEmail.buildForContributor(params);
  await sendIdempotent({ dedupeKey: `campaign_failed_contributor:${campaignId}:${to}`, to, subject, text, html });
}

async function sendWithdrawalApprovedEmail({ to, withdrawalId, ...params }) {
  if (!to) return;
  const { subject, text, html } = withdrawalApprovedEmail.build(params);
  await sendIdempotent({ dedupeKey: `withdrawal_approved:${withdrawalId}`, to, subject, text, html });
}

async function sendWithdrawalRejectedEmail({ to, withdrawalId, ...params }) {
  if (!to) return;
  const { subject, text, html } = withdrawalRejectedEmail.build(params);
  await sendIdempotent({ dedupeKey: `withdrawal_rejected:${withdrawalId}`, to, subject, text, html });
}

async function sendMilestoneReleasedCreatorEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  const { subject, text, html } = milestoneReleasedEmail.buildForCreator(params);
  await sendIdempotent({ dedupeKey: `milestone_released_creator:${milestoneId}`, to, subject, text, html });
}

async function sendMilestoneReleasedContributorEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  const { subject, text, html } = milestoneReleasedEmail.buildForContributor(params);
  await sendIdempotent({ dedupeKey: `milestone_released_contributor:${milestoneId}:${to}`, to, subject, text, html });
}

async function sendMilestoneEvidenceSubmittedAdminEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  const { subject, text, html } = milestoneEvidenceSubmittedEmail.buildForAdmin(params);
  await sendIdempotent({ dedupeKey: `milestone_evidence_submitted:${milestoneId}:${to}`, to, subject, text, html });
}

async function sendKycApprovedEmail({ to, userId, ...params }) {
  if (!to) return;
  const { subject, text, html } = kycApprovedEmail.build(params);
  await sendIdempotent({ dedupeKey: `kyc_approved:${userId}:${Date.now()}`, to, subject, text, html });
}

async function sendKycRejectedEmail({ to, userId, ...params }) {
  if (!to) return;
  const { subject, text, html } = kycRejectedEmail.build(params);
  await sendIdempotent({ dedupeKey: `kyc_rejected:${userId}:${Date.now()}`, to, subject, text, html });
}

async function sendDisputeOpenedCreatorEmail({ to, disputeId, ...params }) {
  if (!to) return;
  const { subject, text, html } = disputeOpenedEmail.buildForCreator(params);
  await sendIdempotent({ dedupeKey: `dispute_opened_creator:${disputeId}`, to, subject, text, html });
}

async function sendDisputeOpenedAdminEmail({ to, disputeId, ...params }) {
  if (!to) return;
  const { subject, text, html } = disputeOpenedEmail.buildForAdmin(params);
  await sendIdempotent({ dedupeKey: `dispute_opened_admin:${disputeId}:${to}`, to, subject, text, html });
}

async function sendDisputeResolvedCreatorEmail({ to, disputeId, outcome, ...params }) {
  if (!to) return;
  const { subject, text, html } = disputeResolvedEmail.buildForCreator({ outcome, ...params });
  await sendIdempotent({ dedupeKey: `dispute_resolved_creator:${disputeId}:${outcome}`, to, subject, text, html });
}

async function sendDisputeResolvedContributorEmail({ to, disputeId, outcome, ...params }) {
  if (!to) return;
  const { subject, text, html } = disputeResolvedEmail.buildForContributor({ outcome, ...params });
  await sendIdempotent({ dedupeKey: `dispute_resolved_contributor:${disputeId}:${outcome}`, to, subject, text, html });
}

async function sendCampaignUpdatePostedEmail({ to, updateId, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, "campaign_update")) return;
  if (campaignId && (await isCampaignUpdateUnsubscribed(to, campaignId))) return;

  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: "campaign_update", campaignId });
  const { subject, text, html } = campaignUpdatePostedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({ dedupeKey: `campaign_update_posted:${updateId}:${to}`, to, subject, text, html });
}

async function sendTeamMemberInvitedEmail({ to, memberId, ...params }) {
  if (!to) return;
  const { subject, text, html } = teamMemberInvitedEmail.build(params);
  await sendIdempotent({ dedupeKey: `team_member_invited:${memberId}`, to, subject, text, html });
}

module.exports = {
  sendEmail,
  sendIdempotent,
  isUnsubscribed,
  isCampaignUpdateUnsubscribed,
  getStellarExpertTxUrl,
  sendContributionReceipt,
  sendWelcomeEmail,
  sendCampaignFundedCreatorEmail,
  sendCampaignFundedContributorEmail,
  sendCampaignFailedCreatorEmail,
  sendCampaignFailedContributorEmail,
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
  sendMilestoneReleasedCreatorEmail,
  sendMilestoneReleasedContributorEmail,
  sendMilestoneEvidenceSubmittedAdminEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendDisputeOpenedCreatorEmail,
  sendDisputeOpenedAdminEmail,
  sendDisputeResolvedCreatorEmail,
  sendDisputeResolvedContributorEmail,
  sendCampaignUpdatePostedEmail,
  sendTeamMemberInvitedEmail,
};
