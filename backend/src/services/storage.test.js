'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { MAX_UPLOAD_SIZE, ALLOWED_UPLOAD_MIME_TYPES } = require('../config/constants');
const { uploadCampaignCoverImage, uploadMilestoneEvidence, validateAndProcessFile } = require('./storage');

// Minimal valid file signatures for file-type detection
const JPEG_SIGNATURE = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const WEBP_SIGNATURE = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

const mockFile = (size, signature = JPEG_SIGNATURE) => {
  const padding = Buffer.alloc(Math.max(0, size - signature.length));
  return { buffer: Buffer.concat([signature, padding]), mimetype: 'image/jpeg', originalname: 'test.jpg' };
};

const mockPngFile = (size) => mockFile(size, PNG_SIGNATURE);
const mockWebpFile = (size) => mockFile(size, WEBP_SIGNATURE);

describe('storage service', () => {
  describe('validateAndProcessFile', () => {
    it('accepts a JPEG file exactly at the size limit', async () => {
      const file = mockFile(MAX_UPLOAD_SIZE);
      const result = await validateAndProcessFile(file);
      assert.strictEqual(result.mime, 'image/jpeg');
    });

    it('accepts a PNG file exactly at the size limit', async () => {
      const file = mockPngFile(MAX_UPLOAD_SIZE);
      const result = await validateAndProcessFile(file);
      assert.strictEqual(result.mime, 'image/png');
    });

    it('accepts a WEBP file exactly at the size limit', async () => {
      const file = mockWebpFile(MAX_UPLOAD_SIZE);
      const result = await validateAndProcessFile(file);
      assert.strictEqual(result.mime, 'image/webp');
    });

    it('rejects a file one byte over the limit', async () => {
      const file = mockFile(MAX_UPLOAD_SIZE + 1);
      await assert.rejects(
        validateAndProcessFile(file),
        { status: 413, message: 'File exceeds maximum allowed size' }
      );
    });

    it('rejects a file significantly over the limit', async () => {
      const file = mockFile(MAX_UPLOAD_SIZE * 2);
      await assert.rejects(
        validateAndProcessFile(file),
        { status: 413, message: 'File exceeds maximum allowed size' }
      );
    });

    it('accepts allowed MIME types', async () => {
      const file = mockFile(1024);
      const result = await validateAndProcessFile(file);
      assert.strictEqual(result.mime, 'image/jpeg');
    });

    it('rejects disallowed MIME types', async () => {
      // Create a GIF signature
      const gifSignature = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const file = { buffer: Buffer.concat([gifSignature, Buffer.alloc(1024 - gifSignature.length)]), mimetype: 'image/gif' };
      await assert.rejects(
        validateAndProcessFile(file),
        { status: 415, message: 'Unsupported Media Type' }
      );
    });

    it('rejects video/mp4 even though it was previously in allowed list', async () => {
      const mp4Signature = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const file = { buffer: Buffer.concat([mp4Signature, Buffer.alloc(1024 - mp4Signature.length)]), mimetype: 'video/mp4' };
      await assert.rejects(
        validateAndProcessFile(file),
        { status: 415, message: 'Unsupported Media Type' }
      );
    });

    it('rejects missing file buffer', async () => {
      await assert.rejects(
        validateAndProcessFile(null),
        { message: 'Missing file buffer for upload' }
      );
      await assert.rejects(
        validateAndProcessFile({}),
        { message: 'Missing file buffer for upload' }
      );
      await assert.rejects(
        validateAndProcessFile({ buffer: null }),
        { message: 'Missing file buffer for upload' }
      );
    });

    it('rejects empty buffer', async () => {
      const file = { buffer: Buffer.alloc(0), mimetype: 'image/jpeg' };
      await assert.rejects(
        validateAndProcessFile(file),
        { status: 415, message: 'Unsupported Media Type' }
      );
    });

    it('computes SHA256 hash correctly', async () => {
      const content = 'test content';
      const file = mockFile(Buffer.byteLength(content) + JPEG_SIGNATURE.length);
      file.buffer = Buffer.concat([JPEG_SIGNATURE, Buffer.from(content)]);
      const result = await validateAndProcessFile(file);
      const expectedHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      assert.strictEqual(result.hash, expectedHash);
    });
  });

  describe('uploadCampaignCoverImage', () => {
    it('rejects oversized file before S3 upload', async () => {
      const file = mockFile(MAX_UPLOAD_SIZE + 1);
      await assert.rejects(
        uploadCampaignCoverImage('campaign-1', file),
        { status: 413, message: 'File exceeds maximum allowed size' }
      );
    });
  });

  describe('uploadMilestoneEvidence', () => {
    it('rejects oversized file before S3 upload', async () => {
      const file = mockFile(MAX_UPLOAD_SIZE + 1);
      await assert.rejects(
        uploadMilestoneEvidence('milestone-1', file),
        { status: 413, message: 'File exceeds maximum allowed size' }
      );
    });
  });
});