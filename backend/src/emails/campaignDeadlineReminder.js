const { renderLayout, heading, paragraph, buttonRow } = require('./layout');

function build({
  contributorName,
  campaignTitle,
  campaignUrl,
  hoursLeft,
  targetAmount,
  raisedAmount,
  unsubscribeUrl,
}) {
  const name = contributorName || 'there';
  const subject = `Ending soon: "${campaignTitle}" has ${hoursLeft} hours left!`;

  const text = [
    `Hi ${name},`,
    '',
    `A campaign you backed, "${campaignTitle}", is ending in ${hoursLeft} hours.`,
    '',
    `It has raised ${raisedAmount} of its ${targetAmount} goal.`,
    '',
    "If it doesn't reach its goal, your contribution will be refunded.",
    '',
    `Campaign page: ${campaignUrl}`,
  ].join('\n');

  const html = renderLayout({
    previewText: `"${campaignTitle}" is ending in ${hoursLeft} hours.`,
    bodyHtml: [
      heading(`Only ${hoursLeft} hours left`),
      paragraph(`A campaign you backed, "${campaignTitle}", is ending soon.`),
      paragraph(
        `It has raised ${raisedAmount} of its ${targetAmount} goal. If it doesn't reach its goal by the deadline, your contribution will be refunded.`
      ),
      buttonRow('View campaign', campaignUrl),
    ].join(''),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
