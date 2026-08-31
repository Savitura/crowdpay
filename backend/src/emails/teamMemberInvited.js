const { renderLayout, heading, paragraph, buttonRow } = require("./layout");

function build({ campaignTitle, role, inviteUrl, unsubscribeUrl }) {
  const subject = `You've been invited to ${campaignTitle ? `"${campaignTitle}"` : "join a CrowdPay campaign"}`;

  const text = [
    `You have been invited to join ${campaignTitle ? `"${campaignTitle}"` : "a campaign"} as a ${role}.`,
    "",
    `Click here to accept: ${inviteUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `You've been invited to join ${campaignTitle || "a campaign"}.`,
    bodyHtml: [
      heading("You're invited"),
      paragraph(`You have been invited to join ${campaignTitle ? `"${campaignTitle}"` : "a campaign"} as a ${role}.`),
      buttonRow("Accept invite", inviteUrl),
    ].join(""),
    unsubscribeUrl
  });

  return { subject, text, html };
}

module.exports = { build };
