const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function createStorageClient() {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;

  if (!endpoint || !bucket) {
    throw new Error('Object storage is not configured. Set STORAGE_ENDPOINT and STORAGE_BUCKET.');
  }

  return new S3Client({
    endpoint,
    region: process.env.STORAGE_REGION || 'auto',
    forcePathStyle: true,
  });
}

function buildPublicUrl(key) {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;
  const normalizedEndpoint = endpoint.replace(/\/+$/, '');

  if (normalizedEndpoint.startsWith('http')) {
    return `${normalizedEndpoint}/${bucket}/${encodeURIComponent(key)}`;
  }

  return `https://${bucket}.${normalizedEndpoint}/${encodeURIComponent(key)}`;
}

async function uploadCampaignCoverImage(campaignId, file) {
  if (!file || !file.buffer) {
    throw new Error('Missing file buffer for upload');
  }

  const extension = path.extname(file.originalname).toLowerCase();
  const key = `campaigns/${campaignId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;

  const client = createStorageClient();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return buildPublicUrl(key);
}

module.exports = { uploadCampaignCoverImage };
