const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");
const { getStellarExpertTxUrl } = require("../utils/stellarExplorer");

function build({ creatorName, amount, asset, campaignTitle, campaignUrl, txHash }) {
  const name = creatorName || "there";
  const explorerUrl = getStellarExpertTxUrl(txHash);
  const subject = `Your withdrawal of ${amount} ${asset} is on its way`;

  const text = [
    `Hi ${name},`,
    "",
    `Your withdrawal of ${amount} ${asset} from "${campaignTitle}" has been approved by the platform and submitted to the Stellar network.`,
    "",
    `Transaction: ${explorerUrl}`,
    "",
    `Campaign page: ${campaignUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `Your withdrawal of ${amount} ${asset} is on its way.`,
    bodyHtml: [
      heading("Withdrawal approved"),
      paragraph(`Hi ${name}, your withdrawal from "${campaignTitle}" has been approved and submitted to the Stellar network.`),
      table([["Amount", `${amount} ${asset}`]]),
      buttonRow("View transaction", explorerUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
