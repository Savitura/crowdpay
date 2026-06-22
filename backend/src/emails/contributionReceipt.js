const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");
const { getStellarExpertTxUrl } = require("../utils/stellarExplorer");

function build({ name, campaignTitle, amount, asset, txHash, date }) {
  const recipientName = name || "there";
  const explorerUrl = getStellarExpertTxUrl(txHash);
  const subject = `Your contribution to "${campaignTitle}" is confirmed`;

  const text = [
    `Hi ${recipientName},`,
    "",
    `Your contribution of ${amount} ${asset} to "${campaignTitle}" has been confirmed on the Stellar network.`,
    "",
    `Date: ${date}`,
    `Transaction: ${explorerUrl}`,
    "",
    "Thank you for contributing on CrowdPay.",
  ].join("\n");

  const html = renderLayout({
    previewText: `Your contribution of ${amount} ${asset} is confirmed.`,
    bodyHtml: [
      heading("Contribution confirmed"),
      paragraph(`Hi ${recipientName}, your contribution to "${campaignTitle}" has been confirmed on the Stellar network.`),
      table([
        ["Campaign", campaignTitle],
        ["Amount", `${amount} ${asset}`],
        ["Date", date],
      ]),
      buttonRow("View transaction", explorerUrl),
      paragraph("Thank you for contributing on CrowdPay."),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
