const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function build({ name, dashboardUrl }) {
  const recipientName = name || "there";
  const subject = "Your identity is verified";

  const text = [
    `Hi ${recipientName},`,
    "",
    "Your identity verification is complete. You can now create campaigns and contribute without restriction.",
    "",
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: "Your identity is verified.",
    bodyHtml: [
      heading("Identity verified"),
      paragraph(`Hi ${recipientName}, your identity verification is complete. You can now create campaigns and contribute without restriction.`),
      buttonRow("Go to dashboard", dashboardUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
