const { renderLayout, heading, paragraph } = require("./layout");

function build({ name, campaignTitle, message, campaignUrl, unsubscribeUrl }) {
  const recipientName = name || "there";
  const subject = `${campaignTitle} — Thank you from the creator!`;

  const text = [
    `Hi ${recipientName},`,
    "",
    `The creator of "${campaignTitle}" sent you a thank-you message:`,
    "",
    message,
    "",
    `View campaign: ${campaignUrl}`,
    "",
    `Unsubscribe from thank-you messages: ${unsubscribeUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `A personal thank-you from the creator of "${campaignTitle}"`,
    bodyHtml: [
      heading("You've received a thank-you message!"),
      paragraph(`The creator of "${campaignTitle}" wants to thank you for your support:`),
      paragraph(`"${message}"`),
      paragraph(`— ${campaignTitle} Creator`),
    ].join(""),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
