const { renderLayout, heading, paragraph, table } = require("./layout");

function build({ adminName, campaignTitle, campaignId, score, breakdown, autoSuspended }) {
  const recipientName = adminName || "Admin";
  const subject = `[Fraud Alert] Campaign Flagged: ${campaignTitle}`;

  const breakdownText = Object.entries(breakdown || {})
    .map(([name, data]) => `- ${name}: score ${data.score} (${data.detail})`)
    .join("\n");

  const text = [
    `Hi ${recipientName},`,
    "",
    `A campaign on CrowdPay has been flagged for suspicious activity.`,
    "",
    `Campaign: ${campaignTitle} (ID: ${campaignId})`,
    `Fraud Score: ${score}`,
    `Auto-Suspended: ${autoSuspended ? "Yes" : "No"}`,
    "",
    "Breakdown:",
    breakdownText,
    "",
    "Please log in to the Admin Dashboard to review this campaign.",
  ].join("\n");

  const breakdownRows = Object.entries(breakdown || {}).map(([name, data]) => [
    name,
    `Score: ${data.score} - ${data.detail}`
  ]);

  const html = renderLayout({
    previewText: `Fraud alert for campaign: ${campaignTitle}`,
    bodyHtml: [
      heading(`Suspicious Activity Flagged`),
      paragraph(`A campaign has been flagged with a fraud score of <strong>${score}</strong>.`),
      table([
        ["Campaign Title", campaignTitle],
        ["Campaign ID", campaignId],
        ["Fraud Score", String(score)],
        ["Auto-Suspended", autoSuspended ? "Yes" : "No"],
      ]),
      heading("Signal Breakdown", 3),
      table(breakdownRows),
      paragraph("Please review this campaign immediately from the Admin Dashboard."),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { build };
