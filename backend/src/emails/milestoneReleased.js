const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");
const { getStellarExpertTxUrl } = require("../utils/stellarExplorer");

function buildForCreator({ creatorName, campaignTitle, campaignUrl, milestoneTitle, amount, asset, txHash }) {
  const name = creatorName || "there";
  const explorerUrl = getStellarExpertTxUrl(txHash);
  const subject = `Milestone reached on "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `The milestone "${milestoneTitle}" on your campaign "${campaignTitle}" was approved and ${amount} ${asset} has been released to you.`,
    "",
    `Transaction: ${explorerUrl}`,
    "",
    `Campaign page: ${campaignUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `Milestone "${milestoneTitle}" released.`,
    bodyHtml: [
      heading("Milestone released"),
      paragraph(`Hi ${name}, the milestone "${milestoneTitle}" on "${campaignTitle}" was approved and the funds have been released to you.`),
      table([["Released", `${amount} ${asset}`]]),
      buttonRow("View transaction", explorerUrl),
    ].join(""),
  });

  return { subject, text, html };
}

function buildForContributor({ contributorName, campaignTitle, campaignUrl, milestoneTitle }) {
  const name = contributorName || "there";
  const subject = `Milestone reached on "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `The milestone "${milestoneTitle}" on "${campaignTitle}" has been reached and funds have been released to the creator.`,
    "",
    `Campaign page: ${campaignUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `Milestone "${milestoneTitle}" reached on "${campaignTitle}".`,
    bodyHtml: [
      heading("Milestone reached"),
      paragraph(`The milestone "${milestoneTitle}" on "${campaignTitle}" has been reached and funds have been released to the creator.`),
      buttonRow("View campaign", campaignUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildForCreator, buildForContributor };
