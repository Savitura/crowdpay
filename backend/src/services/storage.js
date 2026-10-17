const path = require('path');
const crypto = require('crypto');
const fileType = require('file-type');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { MAX_UPLOAD_SIZE, ALLOWED_UPLOAD_MIME_TYPES } = require('../config/constants');

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

  if (file.buffer.length > MAX_UPLOAD_SIZE) {
    const error = new Error('File exceeds maximum allowed size');
    error.status = 413;
    throw error;
  }

  const type = await fileType.fromBuffer(file.buffer);
  if (!type || !ALLOWED_UPLOAD_MIME_TYPES.includes(type.mime)) {
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

const MILESTONE_EVIDENCE_KEY_PATTERN = /^milestones\/([^/]+)\/([0-9a-f]{64})(\.[a-z0-9]+)$/;

/**
 * Recognise a URL produced by uploadMilestoneEvidence for this milestone.
 * Evidence keys are content-addressed (milestones/<id>/<sha256><ext>) and only
 * the server holds write credentials, so a matching URL identifies an
 * immutable file whose SHA-256 was computed by the platform at upload time.
 *
 * @returns {{ key: string, sha256: string } | null}
 */
function parseMilestoneEvidenceUrl(milestoneId, url) {
  if (!url || !process.env.STORAGE_ENDPOINT || !process.env.STORAGE_BUCKET) return null;
  let target;
  let base;
  try {
    target = new URL(url).href;
    base = new URL(buildPublicUrl('')).href;
  } catch {
    return null;
  }
  if (!target.startsWith(base)) return null;

  let key;
  try {
    key = decodeURIComponent(target.slice(base.length));
  } catch {
    return null;
  }
  const match = MILESTONE_EVIDENCE_KEY_PATTERN.exec(key);
  if (!match || match[1] !== String(milestoneId)) return null;
  return { key, sha256: match[2] };
}

/** True when the evidence object exists in storage. Throws on storage errors other than not-found. */
async function milestoneEvidenceExists(key) {
  const client = createStorageClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

module.exports = {
  uploadCampaignCoverImage,
  uploadMilestoneEvidence,
  validateAndProcessFile,
  parseMilestoneEvidenceUrl,
  milestoneEvidenceExists,
};
