const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const PDFDocument = require('pdfkit');

function render(receiptData) {
  const seen = [];
  class RecordingPDFDocument extends PDFDocument {
    text(value, ...rest) {
      if (typeof value === 'string') seen.push(value);
      return super.text(value, ...rest);
    }
  }
  const { generateContributionReceiptPdf } = proxyquire('./taxReceiptPdf', {
    pdfkit: RecordingPDFDocument,
  });

  return new Promise((resolve, reject) => {
    generateContributionReceiptPdf(receiptData, (err, buffer) => {
      if (err) reject(err);
      else resolve({ buffer, seen });
    });
  });
}

const fullReceipt = {
  campaignTitle: 'Solar Garden',
  contributorName: 'Ada Lovelace',
  contributorEmail: 'ada@example.com',
  amount: '25.00',
  asset: 'USDC',
  date: '2026-06-01T12:00:00.000Z',
  txHash: 'abc123hash',
  memo: 'thanks',
  networkFee: '0.01',
  platformFee: '0.50',
  totalCharged: '25.51',
};

describe('contribution receipt PDF', { concurrency: 1 }, () => {
  test('generateContributionReceiptPdf returns a PDF buffer with receipt metadata', async () => {
    const { buffer, seen } = await render(fullReceipt);
    const text = seen.join('\n');

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.length > 500);
    assert.ok(text.includes('CrowdPay Contribution Receipt'));
    assert.ok(text.includes('Solar Garden'));
    assert.ok(text.includes('Ada Lovelace'));
    assert.ok(text.includes('ada@example.com'));
    assert.ok(text.includes('25.00 USDC'));
    assert.ok(text.includes('abc123hash'));
    assert.ok(text.includes('thanks'));
    assert.ok(text.includes('0.01 USDC'));
    assert.ok(text.includes('0.50 USDC'));
    assert.ok(text.includes('25.51 USDC'));
  });

  test('generateContributionReceiptPdf fills missing fields and still returns a PDF', async () => {
    const { buffer, seen } = await render({});
    const text = seen.join('\n');

    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(text.includes('Campaign Name'));
    assert.ok(text.includes('N/A'));
    assert.ok(text.includes('None'));
    assert.ok(text.includes('0 undefined') || text.includes('undefined'));
  });

  test('generateContributionReceiptPdf uses fee fallbacks when only an amount is present', async () => {
    const { seen } = await render({ amount: '10', asset: 'XLM' });
    const text = seen.join('\n');

    assert.ok(text.includes('10 XLM'));
    assert.ok(text.includes('Network Fee'));
    assert.ok(text.includes('0 XLM'));
    assert.ok(text.includes('Total Charged'));
  });
});
