const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const zlib = require('zlib');

const { generateCampaignOgImage } = require('./ogImageService');

function pngPayload(buffer) {
  const parts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return zlib.inflateSync(Buffer.concat(parts));
}

function assertPng(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const decoded = pngPayload(buffer);
  assert.ok(decoded.length > 1000);
  return decoded;
}

test('generateCampaignOgImage returns a PNG for a funded campaign', async () => {
  const buffer = await generateCampaignOgImage({
    title: 'Solar Garden',
    creatorName: 'Ada Lovelace',
    raisedAmount: 50,
    targetAmount: 100,
    assetType: 'USDC',
    campaignUrl: 'https://crowdpay.test/campaigns/solar',
  });
  const pixels = assertPng(buffer);
  assert.ok(pixels.some(byte => byte !== 255));
});

test('generateCampaignOgImage still returns a PNG when amounts, title, and URL are missing', async () => {
  const buffer = await generateCampaignOgImage({});
  assertPng(buffer);
});

test('generateCampaignOgImage does not divide by a zero target', async () => {
  const buffer = await generateCampaignOgImage({
    title: 'Zero Goal',
    raisedAmount: 10,
    targetAmount: 0,
    assetType: 'XLM',
  });
  assertPng(buffer);
});

test('generateCampaignOgImage falls back to a PNG without a QR code when QR generation throws', async () => {
  const { generateCampaignOgImage: generate } = proxyquire('./ogImageService', {
    qrcode: {
      create() {
        throw new Error('qr timeout');
      },
    },
  });

  const buffer = await generate({
    title: 'Solar Garden',
    creatorName: 'Ada',
    raisedAmount: 1,
    targetAmount: 2,
    campaignUrl: 'https://crowdpay.test/campaigns/solar',
  });
  assertPng(buffer);
});
