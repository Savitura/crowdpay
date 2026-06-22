const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");

function buildForCreator({ creatorName, campaignTitle, campaignUrl, targetAmount, raisedAmount }) {
  const name = creatorName || "there";
  const subject = `Your campaign "${campaignTitle}" has reached its goal`;

  const text = [
    `Hi ${name},`,
    "",
    `Congratulations! Your campaign "${campaignTitle}" has reached its funding goal of ${targetAmount}.`,
    "",
    `Total raised: ${raisedAmount}`,
    "",
    `View your campaign: ${campaignUrl}`,
    "",
    "You can now request a withdrawal from your creator dashboard.",
  ].join("\n");

  const html = renderLayout({
    previewText: `"${campaignTitle}" has reached its funding goal.`,
    bodyHtml: [
      heading("Your campaign hit its goal!"),
      paragraph(`Congratulations! "${campaignTitle}" has reached its funding goal.`),
      table([
        ["Goal", targetAmount],
        ["Raised", raisedAmount],
      ]),
      buttonRow("View campaign", campaignUrl),
      paragraph("You can now request a withdrawal from your creator dashboard."),
    ].join(""),
  });

  return { subject, text, html };
}

function buildForContributor({ contributorName, campaignTitle, campaignUrl }) {
  const name = contributorName || "there";
  const subject = `Campaign you backed has been fully funded: "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `Great news — "${campaignTitle}" has reached its funding goal.`,
    "",
    `View the campaign: ${campaignUrl}`,
    "",
    "Thank you for backing this campaign on CrowdPay.",
  ].join("\n");

  const html = renderLayout({
    previewText: `A campaign you backed is now fully funded.`,
    bodyHtml: [
      heading("A campaign you backed is funded"),
      paragraph(`Great news — "${campaignTitle}" has reached its funding goal.`),
      buttonRow("View campaign", campaignUrl),
      paragraph("Thank you for backing this campaign on CrowdPay."),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildForCreator, buildForContributor };
