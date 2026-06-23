const { renderLayout, heading, paragraph, table, buttonRow } = require('./layout');

function buildForAdmin({
  adminName,
  campaignTitle,
  milestoneTitle,
  evidenceUrl,
  evidenceDescription,
  creatorName,
  adminUrl,
}) {
  const subject = `Milestone evidence submitted for "${campaignTitle}"`;

  const text = [
    `Hi ${adminName || 'there'},`,
    '',
    `${creatorName || 'A creator'} submitted evidence for milestone "${milestoneTitle}" on "${campaignTitle}".`,
    evidenceDescription ? `Description: ${evidenceDescription}` : '',
    evidenceUrl ? `Evidence: ${evidenceUrl}` : '',
    '',
    `Review: ${adminUrl}`,
  ].filter(Boolean).join('\n');

  const html = renderLayout({
    previewText: `Milestone evidence submitted for "${campaignTitle}".`,
    bodyHtml: [
      heading('Milestone evidence ready for review'),
      paragraph(`${creatorName || 'A creator'} submitted proof for milestone "${milestoneTitle}" on "${campaignTitle}".`),
      table([
        ['Campaign', campaignTitle],
        ['Milestone', milestoneTitle],
        ...(evidenceDescription ? [['Description', evidenceDescription]] : []),
        ...(evidenceUrl ? [['Evidence', evidenceUrl]] : []),
      ]),
      buttonRow('Review milestone', adminUrl),
    ].join(''),
  });

  return { subject, text, html };
}

module.exports = { buildForAdmin };
