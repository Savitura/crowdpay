const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");
const { getStellarExpertTxUrl } = require("../utils/stellarExplorer");

function buildContributorRelease({
  contributorName,
  campaignTitle,
  campaignUrl,
  amount,
  asset,
  txHash,
  usage,
  recipient,
    unsubscribeUrl
}) {
  const name = contributorName || "there";
  const explorerUrl = getStellarExpertTxUrl(txHash);
  const subject = `Funds released from "${campaignTitle}"`;
  const usageText = usage || "Campaign funds were released to the creator.";

  const text = [
    `Hi ${name},`,
    "",
    `${amount} ${asset} was released from "${campaignTitle}".`,
    `Usage: ${usageText}`,
    recipient ? `Recipient: ${recipient}` : null,
    txHash ? `Transaction: ${explorerUrl}` : null,
    "",
    `Campaign page: ${campaignUrl}`,
  ].filter(Boolean).join("\n");

  const rows = [
    ["Released", `${amount} ${asset}`],
    ["Usage", usageText],
  ];
  if (recipient) rows.push(["Recipient", recipient]);

  const html = renderLayout({
    previewText: `${amount} ${asset} released from "${campaignTitle}".`,
    bodyHtml: [
      heading("Funds released"),
      paragraph(`Hi ${name}, funds from "${campaignTitle}" were released.`),
      table(rows),
      txHash ? buttonRow("View transaction", explorerUrl) : "",
      buttonRow("View campaign", campaignUrl),
    ].join(""),
    unsubscribeUrl
  });

  return { subject, text, html };
}

module.exports = { buildContributorRelease };
