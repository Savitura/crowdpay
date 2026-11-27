const { escapeHtml, renderLayout, heading, paragraphHtml, buttonRow } = require('./layout');

function buildForCreator({
  creatorName,
  commenterName,
  campaignTitle,
  campaignUrl,
  commentBody,
  unsubscribeUrl,
}) {
  const name = creatorName || 'Creator';
  const commenter = commenterName || 'A backer';
  const subject = `New question on "${campaignTitle}"`;
  const previewText = `${commenter} asked a question on your campaign.`;

  const text = [
    `Hi ${name},`,
    '',
    `${commenter} posted a question or comment on your campaign "${campaignTitle}":`,
    '',
    `"${commentBody}"`,
    '',
    `Reply to this question: ${campaignUrl}`,
  ].join('\n');

  const html = renderLayout({
    previewText,
    bodyHtml: [
      heading(`New question on "${campaignTitle}"`),
      paragraphHtml(`<strong>${escapeHtml(commenter)}</strong> left a comment or question:`),
      paragraphHtml(`<em>"${escapeHtml(commentBody)}"</em>`),
      buttonRow('View & Reply', campaignUrl),
    ].join(''),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

function buildForCommenter({
  commenterName,
  replierName,
  campaignTitle,
  campaignUrl,
  replyBody,
  isCreatorReply,
  unsubscribeUrl,
}) {
  const name = commenterName || 'there';
  const replier = replierName || (isCreatorReply ? 'The creator' : 'Someone');
  const subject = `New reply on "${campaignTitle}"`;
  const previewText = `${replier} replied to your comment on "${campaignTitle}".`;

  const text = [
    `Hi ${name},`,
    '',
    `${replier} replied to your comment on "${campaignTitle}":`,
    '',
    `"${replyBody}"`,
    '',
    `View full conversation: ${campaignUrl}`,
  ].join('\n');

  const html = renderLayout({
    previewText,
    bodyHtml: [
      heading(`New reply on "${campaignTitle}"`),
      paragraphHtml(
        `<strong>${escapeHtml(replier)}</strong> ${isCreatorReply ? '(Campaign Creator) ' : ''}replied to your comment:`
      ),
      paragraphHtml(`<em>"${escapeHtml(replyBody)}"</em>`),
      buttonRow('View Conversation', campaignUrl),
    ].join(''),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = {
  buildForCreator,
  buildForCommenter,
};
