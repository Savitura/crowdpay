const { renderLayout, heading, paragraph, table } = require("./layout");

function build({ name, walletPublicKey, unsubscribeUrl }) {
  const recipientName = name || "there";
  const subject = "Wallet funding action required for your CrowdPay account";

  const text = [
    `Hi ${recipientName},`,
    "",
    "Automatic wallet funding for your CrowdPay account could not be completed automatically during registration.",
    "",
    `Wallet public key: ${walletPublicKey}`,
    "",
    "You may retry wallet funding from your dashboard or add funds manually before submitting your first contribution.",
    "",
    "Thanks,",
    "The CrowdPay Team",
  ].join("\n");

  const html = renderLayout({
    previewText: "Wallet funding action required for your CrowdPay account.",
    bodyHtml: [
      heading(`Wallet Funding Action Required`),
      paragraph(
        `Hi ${recipientName}, automatic wallet funding for your CrowdPay account could not be completed during registration.`
      ),
      table([["Wallet public key", walletPublicKey]]),
      paragraph(
        "You can retry wallet funding directly from your CrowdPay dashboard or add funds manually before submitting contributions."
      ),
    ].join(""),
    unsubscribeUrl
  });

  return { subject, text, html };
}

module.exports = { build };
