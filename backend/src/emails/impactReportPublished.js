const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function buildForContributor({ 
  contributorName, 
  campaignTitle, 
  reportTitle, 
  reportSummary, 
  campaignUrl, unsubscribeUrl 
}) {
  const name = contributorName || "there";
  const subject = `${campaignTitle} published an impact report`;

  const text = [
    `Hi ${name},`,
    "",
    `Exciting news! "${campaignTitle}" has published an impact report.`,
    "",
    reportSummary ? `Summary: ${reportSummary}` : "",
    "",
    `Report title: "${reportTitle}"`,
    "",
    `View the full report and impact details: ${campaignUrl}#impact-report`,
    "",
    "Thank you for supporting this campaign on CrowdPay.",
  ].filter(Boolean).join("\n");

  const html = renderLayout({
    previewText: `Impact report published for "${campaignTitle}"`,
    bodyHtml: [
      heading("📊 Impact report published"),
      paragraph(`"${campaignTitle}" has published an impact report: <strong>"${reportTitle}"</strong>`),
      reportSummary ? paragraph(`<em>${reportSummary}</em>`) : "",
      buttonRow("View impact report", `${campaignUrl}#impact-report`),
      paragraph("See how your contribution made a difference and the impact created by this campaign."),
    ].filter(Boolean).join(""),
    unsubscribeUrl
  });

  return { subject, text, html };
}

module.exports = { buildForContributor };
