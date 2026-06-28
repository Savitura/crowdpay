const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function buildForCreator({ creatorName, campaignTitle, outcome, resolutionNote, campaignUrl }) {
  const name = creatorName || "there";
  const subject = `Dispute resolved on "${campaignTitle}"`;

  const text = [
    `Hi ${name},`,
    "",
    `The dispute on your campaign "${campaignTitle}" has been resolved.`,
    `Outcome: ${outcome}`,
    resolutionNote ? `Note: ${resolutionNote}` : "",
    "",
    `Campaign page: ${campaignUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderLayout({
    previewText: `Dispute resolved on "${campaignTitle}".`,
    bodyHtml: [
      heading("Dispute resolved"),
      paragraph(`The dispute on your campaign "${campaignTitle}" has been resolved.`),
      paragraph(`Outcome: ${outcome}`),
      resolutionNote ? paragraph(`Note: ${resolutionNote}`) : "",
      buttonRow("View campaign", campaignUrl),
    ].join(""),
  });

  return { subject, text, html };
}

function buildForContributor({ contributorName, campaignTitle, outcome, resolutionNote, campaignUrl }) {
  const name = contributorName || "there";
  const subject = "Your dispute has been resolved";

  const text = [
    `Hi ${name},`,
    "",
    `Your dispute on "${campaignTitle}" has been resolved.`,
    `Outcome: ${outcome}`,
    resolutionNote ? `Note: ${resolutionNote}` : "",
    "",
    `Campaign page: ${campaignUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderLayout({
    previewText: "Your dispute has been resolved.",
    bodyHtml: [
      heading("Dispute resolved"),
      paragraph(`Your dispute on "${campaignTitle}" has been resolved.`),
      paragraph(`Outcome: ${outcome}`),
      resolutionNote ? paragraph(`Note: ${resolutionNote}`) : "",
      buttonRow("View campaign", campaignUrl),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildForCreator, buildForContributor };
