const { renderLayout, heading, paragraph, table } = require("./layout");

function build({ creatorName, amount, asset, campaignTitle, reason }) {
  const name = creatorName || "there";
  const subject = "Your withdrawal request was rejected";

  const text = [
    `Hi ${name},`,
    "",
    `Your withdrawal request of ${amount} ${asset} from "${campaignTitle}" has been rejected by the platform.`,
    "",
    `Reason: ${reason}`,
  ].join("\n");

  const html = renderLayout({
    previewText: "Your withdrawal request was rejected.",
    bodyHtml: [
      heading("Withdrawal rejected"),
      paragraph(`Hi ${name}, your withdrawal request from "${campaignTitle}" has been rejected by the platform.`),
      table([
        ["Amount", `${amount} ${asset}`],
        ["Reason", reason],
      ]),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
