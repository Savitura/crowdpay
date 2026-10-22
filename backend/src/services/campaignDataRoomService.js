'use strict';

const db = require('../config/database');
const logger = require('../config/logger');
const { DATA_ROOM_CATEGORIES, DATA_ROOM_ACCESS_LEVELS } = require('../config/constants');

const ROLE_HIERARCHY = {
  public: 0,
  backer: 1,
  viewer: 2,
  editor: 3,
  manager: 4,
  owner: 5,
  admin: 5,
};

/**
 * Returns the access levels that a user with the given role can view.
 * @param {string} role
 * @returns {string[]}
 */
function getAccessibleLevels(role) {
  const level = ROLE_HIERARCHY[role] ?? 0;
  const levels = ['public'];
  if (level >= 1) levels.push('backer');
  if (level >= 2) levels.push('viewer');
  if (level >= 3) levels.push('editor');
  if (level >= 4) levels.push('manager');
  if (level >= 5) levels.push('owner');
  return levels;
}

/**
 * Check if a role has read access to a specific file access level.
 */
function canAccessFile(userRole, fileAccessLevel) {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
  const fileLevel = ROLE_HIERARCHY[fileAccessLevel] ?? 1;
  return userLevel >= fileLevel;
}

/**
 * Check if a user role is permitted to upload with a target access level.
 * Requires at least 'editor' role. Cannot set access level higher than own role.
 */
function canUploadFile(userRole, desiredAccessLevel) {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
  if (userLevel < ROLE_HIERARCHY.editor) return false;
  const targetLevel = ROLE_HIERARCHY[desiredAccessLevel] ?? 1;
  return userLevel >= targetLevel;
}

/**
 * Check if a user can manage (update metadata or delete) a file.
 * - Admin and Owner can manage any file.
 * - Manager can manage any file with access_level <= manager.
 * - Editor can manage only files they personally uploaded.
 */
function canManageFile(userRole, userId, file) {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
  if (userLevel >= ROLE_HIERARCHY.owner) return true;
  if (userLevel >= ROLE_HIERARCHY.manager) {
    const fileLevel = ROLE_HIERARCHY[file.access_level] ?? 1;
    return userLevel >= fileLevel;
  }
  if (userLevel >= ROLE_HIERARCHY.editor) {
    return Boolean(userId && file.uploaded_by && String(file.uploaded_by) === String(userId));
  }
  return false;
}

/**
 * Check if a user role is permitted to view the data room audit access logs.
 * Restricted to Manager, Owner, and Admin.
 */
function canViewAuditLogs(userRole) {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
  return userLevel >= ROLE_HIERARCHY.manager;
}

/**
 * Resolves the effective role of a user for a given campaign.
 * Precedence:
 * 1. Global Admin -> 'admin'
 * 2. Unauthenticated -> 'public'
 * 3. Campaign Creator -> 'owner'
 * 4. Campaign Member (accepted) -> 'owner' | 'manager' | 'editor' | 'viewer'
 * 5. Backer / Contributor (has active contribution) -> 'backer'
 * 6. Authenticated Non-Backer -> 'public'
 */
async function resolveUserCampaignRole(campaignId, userId, isAdmin = false) {
  if (isAdmin) return 'admin';
  if (!userId) return 'public';

  // 1. Check campaign creator
  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  if (!campaignRows.length) return null; // campaign not found

  if (String(campaignRows[0].creator_id) === String(userId)) {
    return 'owner';
  }

  // 2. Check campaign member team role
  const { rows: memberRows } = await db.query(
    'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId]
  );
  if (memberRows.length && memberRows[0].accepted_at) {
    return memberRows[0].role;
  }

  // 3. Check if user is a backer/contributor
  const { rows: userRows } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
    userId,
  ]);
  if (userRows.length && userRows[0].wallet_public_key) {
    const { rows: contribRows } = await db.query(
      `SELECT 1 FROM contributions
       WHERE campaign_id = $1
         AND LOWER(sender_public_key) = LOWER($2)
       LIMIT 1`,
      [campaignId, userRows[0].wallet_public_key]
    );
    if (contribRows.length) {
      return 'backer';
    }
  }

  return 'public';
}

/**
 * Helper to record an access log entry.
 */
async function logAccess({
  fileId,
  campaignId,
  userId = null,
  action,
  ipAddress = null,
  userAgent = null,
}) {
  try {
    await db.query(
      `INSERT INTO campaign_data_room_access_logs
         (file_id, campaign_id, user_id, action, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fileId, campaignId, userId || null, action, ipAddress || null, userAgent || null]
    );
  } catch (err) {
    logger.warn('Failed to record data room access log', { error: err.message, fileId, action });
  }
}

/**
 * List active data room files visible to the caller based on their resolved role.
 */
async function listDataRoomFiles(
  campaignId,
  userId,
  { category, search, limit = 50, offset = 0, isAdmin = false } = {}
) {
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);
  if (userRole === null) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  const accessibleLevels = getAccessibleLevels(userRole);

  const queryParams = [campaignId, accessibleLevels];
  let filterClause = '';

  if (category && DATA_ROOM_CATEGORIES.includes(category)) {
    queryParams.push(category);
    filterClause += ` AND f.category = $${queryParams.length}`;
  }

  if (search && typeof search === 'string' && search.trim()) {
    queryParams.push(`%${search.trim().toLowerCase()}%`);
    filterClause += ` AND (LOWER(f.name) LIKE $${queryParams.length} OR LOWER(f.original_filename) LIKE $${queryParams.length} OR LOWER(COALESCE(f.description, '')) LIKE $${queryParams.length})`;
  }

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM campaign_data_room_files f
    WHERE f.campaign_id = $1
      AND f.status = 'active'
      AND f.access_level = ANY($2::text[])
      ${filterClause}
  `;
  const { rows: countRows } = await db.query(countQuery, queryParams);
  const total = countRows[0]?.total || 0;

  queryParams.push(Math.max(1, Math.min(100, Number(limit) || 50)));
  const limitIdx = queryParams.length;
  queryParams.push(Math.max(0, Number(offset) || 0));
  const offsetIdx = queryParams.length;

  const dataQuery = `
    SELECT f.id, f.campaign_id, f.uploaded_by, f.name, f.original_filename,
           f.file_url, f.file_size, f.mime_type, f.file_hash, f.category,
           f.access_level, f.description, f.status, f.created_at, f.updated_at,
           u.name AS uploader_name, u.email AS uploader_email
    FROM campaign_data_room_files f
    LEFT JOIN users u ON u.id = f.uploaded_by
    WHERE f.campaign_id = $1
      AND f.status = 'active'
      AND f.access_level = ANY($2::text[])
      ${filterClause}
    ORDER BY f.created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const { rows: files } = await db.query(dataQuery, queryParams);

  // Category counts across accessible files
  const { rows: catRows } = await db.query(
    `SELECT category, COUNT(*)::int AS count
     FROM campaign_data_room_files
     WHERE campaign_id = $1
       AND status = 'active'
       AND access_level = ANY($2::text[])
     GROUP BY category`,
    [campaignId, accessibleLevels]
  );
  const categoriesSummary = {};
  for (const cat of DATA_ROOM_CATEGORIES) {
    categoriesSummary[cat] = 0;
  }
  for (const row of catRows) {
    categoriesSummary[row.category] = row.count;
  }

  const enrichedFiles = files.map(file => ({
    ...file,
    can_manage: canManageFile(userRole, userId, file),
  }));

  return {
    files: enrichedFiles,
    total,
    user_role: userRole,
    can_upload: ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY.editor,
    can_view_logs: canViewAuditLogs(userRole),
    categories_summary: categoriesSummary,
  };
}

/**
 * Create a new data room file attachment.
 */
async function createDataRoomFile(
  campaignId,
  userId,
  payload,
  { isAdmin = false, ipAddress = null, userAgent = null } = {}
) {
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);
  if (userRole === null) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) {
    const err = new Error('Document name is required');
    err.status = 422;
    throw err;
  }

  const category = payload.category || 'other';
  if (!DATA_ROOM_CATEGORIES.includes(category)) {
    const err = new Error(`Invalid category. Allowed: ${DATA_ROOM_CATEGORIES.join(', ')}`);
    err.status = 422;
    throw err;
  }

  const accessLevel = payload.access_level || 'backer';
  if (!DATA_ROOM_ACCESS_LEVELS.includes(accessLevel)) {
    const err = new Error(`Invalid access level. Allowed: ${DATA_ROOM_ACCESS_LEVELS.join(', ')}`);
    err.status = 422;
    throw err;
  }

  if (!canUploadFile(userRole, accessLevel)) {
    const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
    const err = new Error(
      userLevel < ROLE_HIERARCHY.editor
        ? 'Insufficient role to upload documents to the data room. Requires editor, manager, owner, or admin role.'
        : `Cannot assign access level "${accessLevel}" higher than your role permission "${userRole}".`
    );
    err.status = 403;
    throw err;
  }

  const fileUrl = typeof payload.file_url === 'string' ? payload.file_url.trim() : '';
  if (!fileUrl) {
    const err = new Error('file_url is required');
    err.status = 422;
    throw err;
  }

  const originalFilename = payload.original_filename || name;
  const mimeType = payload.mime_type || 'application/octet-stream';
  const fileSize = Number(payload.file_size) || 0;
  const fileHash = payload.file_hash || null;
  const description = payload.description ? String(payload.description).trim() : null;

  const { rows } = await db.query(
    `INSERT INTO campaign_data_room_files
       (campaign_id, uploaded_by, name, original_filename, file_url,
        file_size, mime_type, file_hash, category, access_level, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
     RETURNING *`,
    [
      campaignId,
      userId || null,
      name,
      originalFilename,
      fileUrl,
      fileSize,
      mimeType,
      fileHash,
      category,
      accessLevel,
      description,
    ]
  );

  const created = rows[0];

  await logAccess({
    fileId: created.id,
    campaignId,
    userId,
    action: 'upload',
    ipAddress,
    userAgent,
  });

  return {
    ...created,
    can_manage: canManageFile(userRole, userId, created),
  };
}

/**
 * Retrieve details for a single data room document.
 */
async function getDataRoomFile(
  campaignId,
  fileId,
  userId,
  { isAdmin = false, ipAddress = null, userAgent = null } = {}
) {
  const { rows } = await db.query(
    `SELECT f.*, u.name AS uploader_name, u.email AS uploader_email
     FROM campaign_data_room_files f
     LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.id = $1 AND f.campaign_id = $2 AND f.status != 'deleted'`,
    [fileId, campaignId]
  );

  if (!rows.length) {
    const err = new Error('Data room file not found');
    err.status = 404;
    throw err;
  }

  const file = rows[0];
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);

  if (!canAccessFile(userRole, file.access_level)) {
    if (!userId) {
      const err = new Error('Authentication required to access this data room document');
      err.status = 401;
      throw err;
    }
    const err = new Error(
      `Insufficient role to access this document (requires ${file.access_level} access)`
    );
    err.status = 403;
    throw err;
  }

  await logAccess({
    fileId: file.id,
    campaignId,
    userId,
    action: 'view',
    ipAddress,
    userAgent,
  });

  return {
    ...file,
    can_manage: canManageFile(userRole, userId, file),
  };
}

/**
 * Download a data room document. Verifies access permissions and logs download.
 */
async function downloadDataRoomFile(
  campaignId,
  fileId,
  userId,
  { isAdmin = false, ipAddress = null, userAgent = null } = {}
) {
  const file = await getDataRoomFile(campaignId, fileId, userId, { isAdmin, ipAddress, userAgent });

  await logAccess({
    fileId: file.id,
    campaignId,
    userId,
    action: 'download',
    ipAddress,
    userAgent,
  });

  return {
    file,
    download_url: file.file_url,
    original_filename: file.original_filename,
    mime_type: file.mime_type,
    file_size: file.file_size,
  };
}

/**
 * Update a data room document's metadata or access level.
 */
async function updateDataRoomFile(
  campaignId,
  fileId,
  userId,
  updates,
  { isAdmin = false, ipAddress = null, userAgent = null } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM campaign_data_room_files
     WHERE id = $1 AND campaign_id = $2 AND status != 'deleted'`,
    [fileId, campaignId]
  );

  if (!rows.length) {
    const err = new Error('Data room file not found');
    err.status = 404;
    throw err;
  }

  const file = rows[0];
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);

  if (!canManageFile(userRole, userId, file)) {
    const err = new Error('Insufficient permissions to modify this data room document');
    err.status = 403;
    throw err;
  }

  let newName = file.name;
  if (updates.name !== undefined) {
    newName = String(updates.name).trim();
    if (!newName) {
      const err = new Error('Document name cannot be empty');
      err.status = 422;
      throw err;
    }
  }

  let newCategory = file.category;
  if (updates.category !== undefined) {
    if (!DATA_ROOM_CATEGORIES.includes(updates.category)) {
      const err = new Error(`Invalid category. Allowed: ${DATA_ROOM_CATEGORIES.join(', ')}`);
      err.status = 422;
      throw err;
    }
    newCategory = updates.category;
  }

  let newAccessLevel = file.access_level;
  if (updates.access_level !== undefined) {
    if (!DATA_ROOM_ACCESS_LEVELS.includes(updates.access_level)) {
      const err = new Error(`Invalid access level. Allowed: ${DATA_ROOM_ACCESS_LEVELS.join(', ')}`);
      err.status = 422;
      throw err;
    }
    const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
    const targetLevel = ROLE_HIERARCHY[updates.access_level] ?? 1;
    if (userLevel < targetLevel) {
      const err = new Error(
        `Cannot assign access level "${updates.access_level}" higher than your role "${userRole}"`
      );
      err.status = 403;
      throw err;
    }
    newAccessLevel = updates.access_level;
  }

  let newDescription = file.description;
  if (updates.description !== undefined) {
    newDescription = updates.description ? String(updates.description).trim() : null;
  }

  const { rows: updatedRows } = await db.query(
    `UPDATE campaign_data_room_files
     SET name = $1, category = $2, access_level = $3, description = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [newName, newCategory, newAccessLevel, newDescription, fileId]
  );

  await logAccess({
    fileId,
    campaignId,
    userId,
    action: 'update',
    ipAddress,
    userAgent,
  });

  return {
    ...updatedRows[0],
    can_manage: canManageFile(userRole, userId, updatedRows[0]),
  };
}

/**
 * Delete (soft-delete) a data room document.
 */
async function deleteDataRoomFile(
  campaignId,
  fileId,
  userId,
  { isAdmin = false, ipAddress = null, userAgent = null } = {}
) {
  const { rows } = await db.query(
    `SELECT * FROM campaign_data_room_files
     WHERE id = $1 AND campaign_id = $2 AND status != 'deleted'`,
    [fileId, campaignId]
  );

  if (!rows.length) {
    const err = new Error('Data room file not found');
    err.status = 404;
    throw err;
  }

  const file = rows[0];
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);

  if (!canManageFile(userRole, userId, file)) {
    const err = new Error('Insufficient permissions to delete this data room document');
    err.status = 403;
    throw err;
  }

  await db.query(
    `UPDATE campaign_data_room_files
     SET status = 'deleted', updated_at = NOW()
     WHERE id = $1`,
    [fileId]
  );

  await logAccess({
    fileId,
    campaignId,
    userId,
    action: 'delete',
    ipAddress,
    userAgent,
  });

  return { success: true, id: fileId };
}

/**
 * Retrieve audit access logs for the campaign data room.
 */
async function getDataRoomAccessLogs(
  campaignId,
  userId,
  { limit = 50, offset = 0, isAdmin = false } = {}
) {
  const userRole = await resolveUserCampaignRole(campaignId, userId, isAdmin);
  if (userRole === null) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  if (!canViewAuditLogs(userRole)) {
    const err = new Error(
      'Insufficient permissions to view data room audit logs. Requires manager, owner, or admin role.'
    );
    err.status = 403;
    throw err;
  }

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM campaign_data_room_access_logs
     WHERE campaign_id = $1`,
    [campaignId]
  );

  const { rows: logs } = await db.query(
    `SELECT l.id, l.file_id, l.campaign_id, l.user_id, l.action,
            l.ip_address, l.user_agent, l.created_at,
            f.name AS file_name, f.category AS file_category, f.access_level AS file_access_level,
            u.name AS user_name, u.email AS user_email
     FROM campaign_data_room_access_logs l
     JOIN campaign_data_room_files f ON f.id = l.file_id
     LEFT JOIN users u ON u.id = l.user_id
     WHERE l.campaign_id = $1
     ORDER BY l.created_at DESC
     LIMIT $2 OFFSET $3`,
    [campaignId, safeLimit, safeOffset]
  );

  return {
    logs,
    total: countRows[0]?.total || 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

module.exports = {
  ROLE_HIERARCHY,
  DATA_ROOM_CATEGORIES,
  DATA_ROOM_ACCESS_LEVELS,
  getAccessibleLevels,
  canAccessFile,
  canUploadFile,
  canManageFile,
  canViewAuditLogs,
  resolveUserCampaignRole,
  listDataRoomFiles,
  createDataRoomFile,
  getDataRoomFile,
  downloadDataRoomFile,
  updateDataRoomFile,
  deleteDataRoomFile,
  getDataRoomAccessLogs,
};
