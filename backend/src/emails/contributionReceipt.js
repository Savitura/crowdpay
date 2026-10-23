const { renderLayout, heading, paragraph, table, buttonRow } = require('./layout');
const {
  getStellarNetwork,
  getStellarExpertTxUrl,
  getHorizonTxUrl,
} = require('../utils/stellarExplorer');

function build({
  name,
  campaignTitle,
  amount,
  asset,
  txHash,
  date,
  memo,
  network,
  unsubscribeUrl,
}) {
  const recipientName = name || 'there';
  const resolvedNetwork = network || getStellarNetwork();
  const explorerUrl = getStellarExpertTxUrl(txHash, resolvedNetwork);
  const horizonUrl = getHorizonTxUrl(txHash, resolvedNetwork);
  const subject = `Your contribution to "${campaignTitle}" is confirmed`;

  const textLines = [
    `Hi ${recipientName},`,
    '',
    `Your contribution of ${amount} ${asset} to "${campaignTitle}" has been confirmed on the Stellar network.`,
    '',
    `Date: ${date}`,
    ...(txHash ? [`Stellar Transaction Hash: ${txHash}`] : []),
    `Stellar Network: ${resolvedNetwork}`,
    ...(memo ? [`Memo: ${memo}`] : []),
    `Transaction: ${explorerUrl}`,
    ...(horizonUrl ? [`Horizon API Verification: ${horizonUrl}`] : []),
    '',
    'Thank you for contributing on CrowdPay.',
  ];
  const text = textLines.join('\n');

  const tableRows = [
    ['Campaign', campaignTitle],
    ['Amount', `${amount} ${asset}`],
    ['Date', date],
    ...(txHash ? [['Stellar Tx Hash', txHash]] : []),
    ['Network', resolvedNetwork],
    ...(memo ? [['Memo', memo]] : []),
  ];

  const html = renderLayout({
    previewText: `Your contribution of ${amount} ${asset} is confirmed.`,
    bodyHtml: [
      heading('Contribution confirmed'),
      paragraph(
        `Hi ${recipientName}, your contribution to "${campaignTitle}" has been confirmed on the Stellar network.`
      ),
      table(tableRows),
      buttonRow('View transaction', explorerUrl),
      paragraph('Thank you for contributing on CrowdPay.'),
    ].join(''),
    unsubscribeUrl,
  });

  return { subject, text, html };
}

module.exports = { build };
