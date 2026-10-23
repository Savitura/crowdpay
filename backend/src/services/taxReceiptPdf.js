const {
  getStellarNetwork,
  getStellarNetworkPassphrase,
  getStellarExpertTxUrl,
  getHorizonTxUrl,
} = require('../utils/stellarExplorer');

let PDFDocument = null;
try {
  PDFDocument = require('pdfkit');
} catch {
  PDFDocument = null;
}

function asciiText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfText(value) {
  return asciiText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function normalizeReceiptInput(receipt) {
  const txHash = receipt.txHash || receipt.tx_hash || null;
  const verification = receipt.verification || {};
  const network =
    receipt.stellarNetwork || receipt.stellar_network || verification.network || getStellarNetwork();
  const networkPassphrase =
    receipt.networkPassphrase ||
    receipt.network_passphrase ||
    verification.network_passphrase ||
    getStellarNetworkPassphrase();
  const explorerUrl =
    receipt.explorerUrl ||
    receipt.explorer_url ||
    verification.explorer_url ||
    (txHash ? getStellarExpertTxUrl(txHash) : null);
  const horizonTxUrl =
    receipt.horizonTxUrl ||
    receipt.horizon_tx_url ||
    verification.horizon_tx_url ||
    (txHash ? getHorizonTxUrl(txHash) : null);
  const dateRaw = receipt.date || receipt.created_at || null;
  const parsedDate = dateRaw ? new Date(dateRaw) : null;
  const formattedDate =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toUTCString() : 'N/A';

  return {
    id: receipt.id || receipt.receiptId || receipt.receipt_id || 'N/A',
    campaignId: receipt.campaignId || receipt.campaign_id || 'N/A',
    campaignTitle: receipt.campaignTitle || receipt.campaign_title || 'N/A',
    campaignStatus: receipt.campaignStatus || receipt.campaign_status || 'N/A',
    campaignCreatorName:
      receipt.campaignCreatorName || receipt.campaign_creator_name || 'Not provided',
    contributorName:
      receipt.contributorName || receipt.contributor_name || receipt.display_name || 'Contributor',
    contributorEmail: receipt.contributorEmail || receipt.contributor_email || 'N/A',
    senderPublicKey:
      receipt.senderPublicKey ||
      receipt.sender_public_key ||
      verification.sender_public_key ||
      'N/A',
    destinationPublicKey:
      receipt.destinationPublicKey ||
      receipt.destination_public_key ||
      receipt.campaign_wallet_public_key ||
      verification.destination_public_key ||
      'N/A',
    amount: receipt.amount ?? '0',
    asset: receipt.asset || '',
    paymentType: receipt.paymentType || receipt.payment_type || 'payment',
    sourceAmount: receipt.sourceAmount || receipt.source_amount || null,
    sourceAsset: receipt.sourceAsset || receipt.source_asset || null,
    date: formattedDate,
    txHash: txHash || 'N/A',
    memo: receipt.memo || verification.memo || 'None',
    ledgerSequence:
      receipt.ledgerSequence ?? receipt.ledger_sequence ?? verification.ledger_sequence ?? null,
    network,
    networkPassphrase,
    explorerUrl: explorerUrl || 'N/A',
    horizonTxUrl: horizonTxUrl || 'N/A',
    networkFee: receipt.networkFee ?? receipt.network_fee ?? '0',
    platformFee:
      receipt.platformFee ?? receipt.platform_fee ?? receipt.platform_fee_amount ?? '0',
    totalCharged: receipt.totalCharged ?? receipt.total_charged ?? receipt.amount ?? '0',
  };
}

function receiptLines(rawReceipt, index, total) {
  const r = normalizeReceiptInput(rawReceipt);
  const lines = [
    'CrowdPay Contribution Receipt',
    `Generated on ${new Date().toUTCString()}`,
    `Receipt ID: ${r.id}`,
    total > 1 ? `Receipt ${index + 1} of ${total}` : '',
    'CONTRIBUTION CERTIFICATE',
    'This document certifies that the contributor named below has made a financial contribution',
    'recorded immutably on the Stellar network. Retain this receipt for accounting and tax records.',
    'Transaction Details',
    `Campaign Name: ${r.campaignTitle}`,
    `Campaign ID: ${r.campaignId}`,
    `Campaign Status: ${r.campaignStatus}`,
    `Contributor Name: ${r.contributorName}`,
    `Contributor Email: ${r.contributorEmail}`,
    `Contributor Wallet: ${r.senderPublicKey}`,
    `Destination Wallet: ${r.destinationPublicKey}`,
    `Contribution Amount: ${r.amount} ${r.asset}`.trim(),
    `Payment Type: ${r.paymentType}`,
    r.sourceAmount && r.sourceAsset ? `Source Amount: ${r.sourceAmount} ${r.sourceAsset}` : '',
    `Date: ${r.date}`,
    'Verifiable Stellar Transaction Reference',
    `Stellar Network: ${r.network}`,
    `Network Passphrase: ${r.networkPassphrase}`,
    `Stellar Transaction Hash: ${r.txHash}`,
    `Stellar Memo: ${r.memo}`,
    r.ledgerSequence !== null ? `Ledger Sequence: ${r.ledgerSequence}` : '',
    `Stellar Expert URL: ${r.explorerUrl}`,
    `Horizon API URL: ${r.horizonTxUrl}`,
    'Fee Breakdown',
    `Network Fee: ${r.networkFee} ${r.asset}`.trim(),
    `Platform Fee: ${r.platformFee} ${r.asset}`.trim(),
    `Total Charged: ${r.totalCharged} ${r.asset}`.trim(),
    'CrowdPay is a blockchain-powered crowdfunding platform. Verify this transaction on Stellar.',
  ];
  return lines.filter(line => line !== '');
}

function buildPageContent(lines) {
  const commands = [
    'BT',
    '/F1 16 Tf',
    '50 755 Td',
    `(${escapePdfText(lines[0])}) Tj`,
    '/F1 9 Tf',
  ];
  for (const line of lines.slice(1)) {
    commands.push('0 -15 Td');
    commands.push(`(${escapePdfText(line)}) Tj`);
  }
  commands.push('ET');
  return commands.join('\n');
}

function buildTaxReceiptPdf(receipts) {
  const rows = Array.isArray(receipts) ? receipts : [receipts];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];

  const pageObjectNumbers = [];
  const contentObjectNumbers = [];

  rows.forEach((receipt, index) => {
    const pageObjectNumber = objects.length + 1;
    const contentObjectNumber = pageObjectNumber + 1;
    pageObjectNumbers.push(pageObjectNumber);
    contentObjectNumbers.push(contentObjectNumber);
    objects.push('');

    const content = buildPageContent(receiptLines(receipt, index, rows.length));
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map(num => `${num} 0 R`).join(' ')}] /Count ${pageObjectNumbers.length} >>`;

  pageObjectNumbers.forEach((pageObjectNumber, index) => {
    objects[pageObjectNumber - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${objects.length + 1} 0 R >> >> /Contents ${contentObjectNumbers[index]} 0 R >>`;
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push('0000000000 65535 f \n');
  offsets.slice(1).forEach(offset => {
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  });
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return Buffer.from(chunks.join(''), 'ascii');
}

function renderReceiptPageOnDoc(doc, rawReceipt, index, total) {
  if (index > 0) {
    doc.addPage();
  }
  const r = normalizeReceiptInput(rawReceipt);

  // Header / Brand
  doc.fontSize(22).fillColor('#0f1f3d').text('CrowdPay Contribution Receipt', { align: 'left' });
  doc
    .fontSize(10)
    .fillColor('#666666')
    .text(`Generated on ${new Date().toUTCString()}`, { align: 'left' });
  if (total > 1) {
    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(`Receipt ${index + 1} of ${total}`, { align: 'left' });
  }
  doc.moveDown(1.2);

  // Certificate / Tax notice
  doc.fontSize(12).fillColor('#1a1a1a').text('CONTRIBUTION CERTIFICATE', { bold: true });
  doc
    .fontSize(10)
    .fillColor('#444444')
    .text(
      'This document certifies that the individual or entity named below has made a financial contribution to the crowdfunding campaign detailed herein. Please retain this receipt for your accounting and tax reporting records.',
      { lineGap: 4 }
    );
  doc.moveDown(1);

  // Details table / section
  doc.fontSize(12).fillColor('#0f1f3d').text('Transaction Details', { bold: true });
  doc.moveDown(0.5);

  const details = [
    ['Receipt ID', r.id],
    ['Campaign Name', r.campaignTitle],
    ['Campaign ID', r.campaignId],
    ['Campaign Status', r.campaignStatus],
    ['Contributor Name', r.contributorName],
    ['Contributor Email', r.contributorEmail],
    ['Contributor Wallet', r.senderPublicKey],
    ['Destination Wallet', r.destinationPublicKey],
    ['Contribution Amount', `${r.amount} ${r.asset}`.trim()],
    ['Payment Type', r.paymentType],
    ['Date', r.date],
  ];
  if (r.sourceAmount && r.sourceAsset) {
    details.push(['Converted From', `${r.sourceAmount} ${r.sourceAsset}`]);
  }

  details.forEach(([label, value]) => {
    doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true, bold: true });
    doc.fillColor('#1a1a1a').text(String(value));
    doc.moveDown(0.25);
  });

  doc.moveDown(0.8);
  doc
    .fontSize(12)
    .fillColor('#0f1f3d')
    .text('Verifiable Stellar Transaction Reference', { bold: true });
  doc.moveDown(0.5);

  const stellarRefs = [
    ['Stellar Network', r.network],
    ['Network Passphrase', r.networkPassphrase],
    ['Stellar Transaction Hash', r.txHash],
    ['Stellar Memo', r.memo],
    ...(r.ledgerSequence !== null ? [['Ledger Sequence', String(r.ledgerSequence)]] : []),
    ['Stellar Expert URL', r.explorerUrl],
    ['Horizon API URL', r.horizonTxUrl],
  ];

  stellarRefs.forEach(([label, value]) => {
    doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true, bold: true });
    doc.fillColor('#1a1a1a').text(String(value));
    doc.moveDown(0.25);
  });

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor('#0f1f3d').text('Fee Breakdown', { bold: true });
  doc.moveDown(0.5);

  const fees = [
    ['Network Fee', `${r.networkFee} ${r.asset}`.trim()],
    ['Platform Fee', `${r.platformFee} ${r.asset}`.trim()],
    ['Total Charged', `${r.totalCharged} ${r.asset}`.trim()],
  ];

  fees.forEach(([label, value]) => {
    doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true, bold: true });
    doc.fillColor('#1a1a1a').text(String(value));
    doc.moveDown(0.25);
  });

  doc.moveDown(1.5);
  doc
    .fontSize(9)
    .fillColor('#888888')
    .text(
      'CrowdPay is a blockchain-powered crowdfunding platform. Contributions are recorded immutably on the Stellar network and can be independently verified using the transaction hash and explorer URLs above.',
      { align: 'center' }
    );
}

function generateContributionReceiptPdf(receiptData, streamOrBufferCallback) {
  const rows = Array.isArray(receiptData) ? receiptData : [receiptData];

  const run = callback => {
    if (!PDFDocument) {
      try {
        const buffer = buildTaxReceiptPdf(rows);
        callback(null, buffer);
      } catch (err) {
        callback(err);
      }
      return;
    }

    const first = normalizeReceiptInput(rows[0] || {});
    const doc = new PDFDocument({
      margin: 50,
      compress: false,
      info: {
        Title: `CrowdPay Contribution Receipt ${first.id}`,
        Subject: `Stellar Tx ${first.txHash} | Memo ${first.memo} | Ledger ${first.ledgerSequence ?? 'N/A'}`,
        Keywords: `${first.txHash} ${first.memo} ${first.explorerUrl} ${first.horizonTxUrl}`,
      },
    });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const result = Buffer.concat(chunks);
      callback(null, result);
    });
    doc.on('error', err => {
      callback(err);
    });

    rows.forEach((row, idx) => renderReceiptPageOnDoc(doc, row, idx, rows.length));
    doc.end();
  };

  if (typeof streamOrBufferCallback === 'function') {
    run(streamOrBufferCallback);
    return undefined;
  }

  return new Promise((resolve, reject) => {
    run((err, buffer) => {
      if (err) reject(err);
      else resolve(buffer);
    });
  });
}

function generateTaxReceiptsPdfBuffer(receipts) {
  return generateContributionReceiptPdf(receipts);
}

module.exports = {
  buildTaxReceiptPdf,
  generateContributionReceiptPdf,
  generateTaxReceiptsPdfBuffer,
};
