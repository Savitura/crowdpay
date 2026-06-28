const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function build({ name, campaignTitle, campaignUrl, updateTitle, updateExcerpt, updateBody, unsubscribeUrl }) {
  const recipientName = name || "there";
  const excerpt = updateExcerpt || updateBody || "";
  const subject = `${campaignTitle} posted an update: ${updateTitle}`;

  const text = [
    `Hi ${recipientName},`,
    "",
    `"${campaignTitle}" posted a new update: "${updateTitle}"`,
    "",
    excerpt,
    "",
    `Read the full update: ${campaignUrl}`,
    "",
    `Unsubscribe from updates for this campaign: ${unsubscribeUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `${campaignTitle} posted: ${updateTitle}`,
    bodyHtml: [
      heading(updateTitle),
      paragraph(`"${campaignTitle}" posted a new update.`),
      paragraph(excerpt),
      buttonRow("Read full update", campaignUrl),
    ].join(""),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
