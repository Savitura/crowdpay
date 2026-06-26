const path = require('path');
const crypto = require('crypto');
const fileType = require('file-type');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];

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
    credentials:
      process.env.STORAGE_ACCESS_KEY && process.env.STORAGE_SECRET_KEY
        ? {
            accessKeyId: process.env.STORAGE_ACCESS_KEY,
            secretAccessKey: process.env.STORAGE_SECRET_KEY,
          }
        : undefined,
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

async function validateAndProcessFile(file) {
  if (!file || !file.buffer) {
    throw new Error('Missing file buffer for upload');
  }

  if (file.buffer.length > MAX_FILE_SIZE) {
    const error = new Error('File exceeds maximum allowed size');
    error.status = 413;
    throw error;
  }

  const type = await fileType.fromBuffer(file.buffer);
  if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) {
    const error = new Error('Unsupported Media Type');
    error.status = 415;
    throw error;
  }

  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const sanitizedExtension = `.${type.ext}`;

  return {
    mime: type.mime,
    hash,
    extension: sanitizedExtension,
  };
}

async function uploadCampaignCoverImage(campaignId, file) {
  const { mime, hash, extension } = await validateAndProcessFile(file);
  const key = `campaigns/${campaignId}/${hash}${extension}`;

  const client = createStorageClient();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return buildPublicUrl(key);
}

async function uploadMilestoneEvidence(milestoneId, file) {
  const { mime, hash, extension } = await validateAndProcessFile(file);
  const key = `milestones/${milestoneId}/${hash}${extension}`;

  const client = createStorageClient();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return buildPublicUrl(key);
}

module.exports = { uploadCampaignCoverImage, uploadMilestoneEvidence };
