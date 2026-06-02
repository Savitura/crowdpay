const nodemailer = require("nodemailer");
const db = require("../config/database");

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

function getStellarExpertTxUrl(txHash) {
  const network = process.env.STELLAR_NETWORK || "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
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

  const contributionDate = new Date().toISOString();
  const explorerUrl = getStellarExpertTxUrl(txHash);
  const recipientName = users[0].name || "there";
  const campaignTitle = campaigns[0].title;

  await sendEmail({
    to: users[0].email,
    subject: `Your contribution to "${campaignTitle}" is confirmed`,
    text: [
      `Hi ${recipientName},`,
      "",
      `Your contribution of ${amount} ${asset} to "${campaignTitle}" has been confirmed on the Stellar network.`,
      "",
      `Date: ${contributionDate}`,
      `Transaction: ${explorerUrl}`,
      "",
      "Thank you for contributing on CrowdPay.",
    ].join("\n"),
  });
}

module.exports = {
  sendEmail,
  sendContributionReceipt,
};
