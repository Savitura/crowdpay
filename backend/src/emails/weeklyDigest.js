const {
  escapeHtml,
  renderLayout,
  heading,
  paragraph,
  buttonRow,
} = require("./layout");

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function progressBar(percent) {
  const safePercent = clampPercent(percent);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 16px;">
      <tr>
        <td style="font-size:12px;color:#5c6066;padding-bottom:6px;">Funding progress: ${safePercent}%</td>
      </tr>
      <tr>
        <td style="background-color:#e7ebf0;border-radius:999px;height:10px;overflow:hidden;">
          <div style="width:${safePercent}%;height:10px;background-color:#0f62fe;"></div>
        </td>
      </tr>
    </table>`;
}

function list(items) {
  if (!items.length) return "";
  return `
    <ul style="margin:0 0 16px;padding-left:20px;color:#1a1a1a;">
      ${items.map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`).join("")}
    </ul>`;
}

function campaignSection(campaign) {
  const sections = [];

  if (campaign.updates.length) {
    sections.push(`<p style="margin:0 0 8px;font-weight:bold;color:#0f1f3d;">Updates</p>${list(campaign.updates)}`);
  }
  if (campaign.milestones.length) {
    sections.push(`<p style="margin:0 0 8px;font-weight:bold;color:#0f1f3d;">Milestones</p>${list(campaign.milestones)}`);
  }
  if (campaign.statusChanges.length) {
    sections.push(`<p style="margin:0 0 8px;font-weight:bold;color:#0f1f3d;">Campaign status</p>${list(campaign.statusChanges)}`);
  }
  if (campaign.upcomingDeadlines.length) {
    sections.push(`<p style="margin:0 0 8px;font-weight:bold;color:#0f1f3d;">Upcoming deadlines</p>${list(campaign.upcomingDeadlines)}`);
  }

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #eceef1;border-radius:8px;">
      <tr>
        <td style="padding:20px;">
          <h2 style="margin:0 0 6px;font-size:18px;color:#0f1f3d;">${escapeHtml(campaign.title)}</h2>
          <p style="margin:0 0 8px;color:#5c6066;font-size:14px;">${escapeHtml(campaign.raisedLabel)} raised of ${escapeHtml(campaign.targetLabel)} goal</p>
          ${progressBar(campaign.progressPercent)}
          ${sections.join("")}
          <p style="margin:0;">
            <a href="${escapeHtml(campaign.campaignUrl)}" target="_blank" style="color:#0f62fe;text-decoration:underline;">View campaign</a>
          </p>
        </td>
      </tr>
    </table>`;
}

function build({ name, campaigns, unsubscribeUrl, digestUrl, windowLabel }) {
  const recipientName = name || "there";
  const campaignCount = campaigns.length;
  const subject = `Your weekly CrowdPay digest: ${campaignCount} backed campaign${campaignCount === 1 ? "" : "s"}`;

  const text = [
    `Hi ${recipientName},`,
    "",
    `Here is your CrowdPay weekly digest for ${windowLabel}.`,
    "",
    ...campaigns.flatMap((campaign) => {
      const lines = [
        `${campaign.title} (${campaign.raisedLabel} of ${campaign.targetLabel}, ${clampPercent(campaign.progressPercent)}%)`,
      ];
      if (campaign.updates.length) lines.push(`Updates: ${campaign.updates.join(" | ")}`);
      if (campaign.milestones.length) lines.push(`Milestones: ${campaign.milestones.join(" | ")}`);
      if (campaign.statusChanges.length) lines.push(`Campaign status: ${campaign.statusChanges.join(" | ")}`);
      if (campaign.upcomingDeadlines.length) lines.push(`Upcoming deadlines: ${campaign.upcomingDeadlines.join(" | ")}`);
      lines.push(`View campaign: ${campaign.campaignUrl}`);
      lines.push("");
      return lines;
    }),
    digestUrl ? `View your contributions: ${digestUrl}` : null,
    "",
    `Unsubscribe from weekly digests: ${unsubscribeUrl}`,
  ].filter(Boolean).join("\n");

  const html = renderLayout({
    previewText: `Your CrowdPay weekly digest for ${windowLabel}`,
    bodyHtml: [
      heading("Your weekly backing summary"),
      paragraph(`Hi ${recipientName}, here is your CrowdPay digest for ${windowLabel}.`),
      ...campaigns.map(campaignSection),
      digestUrl ? buttonRow("View my contributions", digestUrl) : "",
    ].join(""),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
