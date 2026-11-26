'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { DATA_ROOM_MAX_FILE_SIZE, DATA_ROOM_ALLOWED_MIME_TYPES } = require('../config/constants');
const storage = require('../services/storage');
const dataRoomService = require('../services/campaignDataRoomService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DATA_ROOM_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!DATA_ROOM_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      const err = new Error(`Unsupported Media Type: ${file.mimetype}`);
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  if (req.is('multipart/form-data')) {
    upload.single('file')(req, res, err => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File exceeds maximum allowed size of 25MB' });
        }
        return res.status(err.status || 400).json({ error: err.message });
      }
      next();
    });
  } else {
    next();
  }
}

/**
 * GET /api/campaigns/:id/data-room/files
 * List data room documents accessible to caller based on their role.
 */
router.get(
  '/:id/data-room/files',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const userId = req.user?.userId || req.user?.id || null;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const result = await dataRoomService.listDataRoomFiles(campaignId, userId, {
      category: req.query.category,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
      isAdmin,
    });

    res.json(result);
  })
);

/**
 * POST /api/campaigns/:id/data-room/files
 * Upload or register a new data room document.
 */
router.post(
  '/:id/data-room/files',
  requireAuth,
  handleUpload,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const userId = req.user?.userId || req.user?.id;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    let fileUrl = req.body.file_url;
    let mimeType = req.body.mime_type;
    let originalFilename = req.body.original_filename;
    let fileSize = req.body.file_size;
    const fileHash = req.body.file_hash;

    if (req.file) {
      fileUrl = await storage.uploadDataRoomAttachment(campaignId, req.file);
      mimeType = req.file.mimetype;
      originalFilename = req.file.originalname;
      fileSize = req.file.size;
    }

    const payload = {
      name: req.body.name || originalFilename,
      original_filename: originalFilename || req.body.name,
      file_url: fileUrl,
      file_size: fileSize,
      mime_type: mimeType,
      file_hash: fileHash,
      category: req.body.category,
      access_level: req.body.access_level,
      description: req.body.description,
    };

    const created = await dataRoomService.createDataRoomFile(campaignId, userId, payload, {
      isAdmin,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(created);
  })
);

/**
 * GET /api/campaigns/:id/data-room/files/:fileId
 * Retrieve details for a single data room document.
 */
router.get(
  '/:id/data-room/files/:fileId',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { id: campaignId, fileId } = req.params;
    const userId = req.user?.userId || req.user?.id || null;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const file = await dataRoomService.getDataRoomFile(campaignId, fileId, userId, {
      isAdmin,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    });

    res.json(file);
  })
);

/**
 * GET /api/campaigns/:id/data-room/files/:fileId/download
 * Download a data room document. Verifies permissions and logs the download action.
 */
router.get(
  '/:id/data-room/files/:fileId/download',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { id: campaignId, fileId } = req.params;
    const userId = req.user?.userId || req.user?.id || null;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const downloadInfo = await dataRoomService.downloadDataRoomFile(campaignId, fileId, userId, {
      isAdmin,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    });

    res.json(downloadInfo);
  })
);

/**
 * PATCH /api/campaigns/:id/data-room/files/:fileId
 * Update document metadata or access level.
 */
router.patch(
  '/:id/data-room/files/:fileId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id: campaignId, fileId } = req.params;
    const userId = req.user?.userId || req.user?.id;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const updated = await dataRoomService.updateDataRoomFile(campaignId, fileId, userId, req.body, {
      isAdmin,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    });

    res.json(updated);
  })
);

/**
 * DELETE /api/campaigns/:id/data-room/files/:fileId
 * Delete (soft-delete) a data room document.
 */
router.delete(
  '/:id/data-room/files/:fileId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id: campaignId, fileId } = req.params;
    const userId = req.user?.userId || req.user?.id;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const result = await dataRoomService.deleteDataRoomFile(campaignId, fileId, userId, {
      isAdmin,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    });

    res.json(result);
  })
);

/**
 * GET /api/campaigns/:id/data-room/access-logs
 * Retrieve audit access logs for the data room.
 */
router.get(
  '/:id/data-room/access-logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const userId = req.user?.userId || req.user?.id;
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');

    const logs = await dataRoomService.getDataRoomAccessLogs(campaignId, userId, {
      limit: req.query.limit,
      offset: req.query.offset,
      isAdmin,
    });

    res.json(logs);
  })
);

module.exports = router;
