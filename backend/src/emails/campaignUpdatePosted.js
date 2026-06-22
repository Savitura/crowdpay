const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function build({ name, campaignTitle, campaignUrl, updateTitle, updateBody, unsubscribeUrl }) {
  const recipientName = name || "there";
  const subject = `${campaignTitle} posted an update: ${updateTitle}`;

  const text = [
    `Hi ${recipientName},`,
    "",
    `"${campaignTitle}" posted a new update: "${updateTitle}"`,
    "",
    updateBody,
    "",
    `View on CrowdPay: ${campaignUrl}`,
    "",
    `Unsubscribe from campaign updates: ${unsubscribeUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `${campaignTitle} posted: ${updateTitle}`,
    bodyHtml: [
      heading(updateTitle),
      paragraph(`"${campaignTitle}" posted a new update.`),
      paragraph(updateBody),
      buttonRow("View on CrowdPay", campaignUrl),
    ].join(""),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
