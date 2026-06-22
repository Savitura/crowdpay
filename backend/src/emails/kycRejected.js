const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function build({ name, reason, retryUrl }) {
  const recipientName = name || "there";
  const subject = "Action needed: KYC verification";

  const text = [
    `Hi ${recipientName},`,
    "",
    "We were unable to verify your identity with the information provided.",
    reason ? `Reason: ${reason}` : "",
    "",
    `You can try again here: ${retryUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderLayout({
    previewText: "We were unable to verify your identity.",
    bodyHtml: [
      heading("Verification needed"),
      paragraph(`Hi ${recipientName}, we were unable to verify your identity with the information provided.`),
      reason ? paragraph(`Reason: ${reason}`) : "",
      buttonRow("Retry verification", retryUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
