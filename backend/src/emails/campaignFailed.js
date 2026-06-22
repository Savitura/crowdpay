const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");

function buildForCreator({ creatorName, campaignTitle, campaignUrl, targetAmount, raisedAmount, deadlineText }) {
  const name = creatorName || "there";
  const subject = `Your campaign "${campaignTitle}" ended below its goal`;

  const text = [
    `Hi ${name},`,
    "",
    `Your campaign "${campaignTitle}" ended on ${deadlineText} without reaching its goal of ${targetAmount}.`,
    "",
    `Amount raised: ${raisedAmount}`,
    "",
    "Contributors will receive refund instructions automatically.",
    "",
    `Campaign page: ${campaignUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `"${campaignTitle}" ended without reaching its goal.`,
    bodyHtml: [
      heading("Campaign ended"),
      paragraph(`"${campaignTitle}" ended on ${deadlineText} without reaching its goal.`),
      table([
        ["Goal", targetAmount],
        ["Raised", raisedAmount],
      ]),
      paragraph("Contributors will receive refund instructions automatically."),
      buttonRow("View campaign", campaignUrl),
    ].join(""),
  });

  return { subject, text, html };
}

function buildForContributor({ contributorName, campaignTitle, campaignUrl, refundsUrl }) {
  const name = contributorName || "there";
  const subject = `Campaign ended — your refund is available: "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `"${campaignTitle}" did not reach its funding goal and has ended.`,
    "",
    "Your contribution is eligible for a refund. Sign in to CrowdPay to claim your refund:",
    refundsUrl,
    "",
    "Refunds are processed via the Stellar network back to the wallet you contributed from.",
    "",
    `Campaign page: ${campaignUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `Your refund for "${campaignTitle}" is available.`,
    bodyHtml: [
      heading("Your refund is available"),
      paragraph(`"${campaignTitle}" did not reach its funding goal and has ended. Your contribution is eligible for a refund.`),
      buttonRow("Claim your refund", refundsUrl),
      paragraph("Refunds are processed via the Stellar network back to the wallet you contributed from."),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildForCreator, buildForContributor };
