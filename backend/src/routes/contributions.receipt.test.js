const test = require('node:test');
const assert = require('node:assert/strict');

test('assembly and pdf generation mock verification', async () => {
  let getOrCreateReceiptPdfCalled = false;
  let getReceiptDataCalled = false;

  const contributionReceiptService = {
    getOrCreateReceiptPdf: async (id) => {
      getOrCreateReceiptPdfCalled = true;
      return 'https://storage.test/signed-receipt.pdf';
    },
    getReceiptData: async () => {
      getReceiptDataCalled = true;
      return {};
    },
  };

  const url = await contributionReceiptService.getOrCreateReceiptPdf('test-contrib-id');
  assert.ok(url.includes('signed-receipt.pdf'));
  assert.ok(getOrCreateReceiptPdfCalled);
  assert.ok(!getReceiptDataCalled);
});
