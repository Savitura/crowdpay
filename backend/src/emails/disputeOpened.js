const { renderLayout, heading, paragraph, table, buttonRow } = require("./layout");

function buildForCreator({ creatorName, campaignTitle, reason }) {
  const name = creatorName || "there";
  const subject = `A dispute has been raised on "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `A contributor has raised a dispute on your campaign "${campaignTitle}".`,
    `Reason: ${reason}`,
    "",
    "The platform team will review and contact you shortly.",
  ].join("\n");

  const html = renderLayout({
    previewText: `A dispute has been raised on "${campaignTitle}".`,
    bodyHtml: [
      heading("Dispute raised"),
      paragraph(`A contributor has raised a dispute on your campaign "${campaignTitle}".`),
      table([["Reason", reason]]),
      paragraph("The platform team will review and contact you shortly."),
    ].join(""),
  });

  return { subject, text, html };
}

function buildForAdmin({ campaignTitle, campaignId, raisedByName, reason, description, adminUrl }) {
  const subject = `A dispute has been raised on "${campaignTitle}"`;

  const text = [
    `A dispute has been raised on campaign "${campaignTitle}" (${campaignId}).`,
    `Raised by: ${raisedByName}`,
    `Reason: ${reason}`,
    `Description: ${description}`,
    "",
    `Review: ${adminUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `A dispute has been raised on "${campaignTitle}".`,
    bodyHtml: [
      heading("New dispute requires review"),
      table([
        ["Campaign", campaignTitle],
        ["Raised by", raisedByName],
        ["Reason", reason],
        ["Description", description],
      ]),
      buttonRow("Review dispute", adminUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildForCreator, buildForAdmin };
