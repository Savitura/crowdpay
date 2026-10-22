'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const MODULE_PATH = './campaignDataRoomService';

function buildService({ queryImpl } = {}) {
  const queryFn = queryImpl || (async () => ({ rows: [] }));
  return proxyquire(MODULE_PATH, {
    '../config/database': { query: queryFn },
    '../config/logger': { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
  });
}

test.describe('campaignDataRoomService - role resolution & permissions', () => {
  test('resolveUserCampaignRole returns admin for admin users', async () => {
    const svc = buildService();
    const role = await svc.resolveUserCampaignRole('camp-1', 'user-1', true);
    assert.strictEqual(role, 'admin');
  });

  test('resolveUserCampaignRole returns public for unauthenticated callers', async () => {
    const svc = buildService();
    const role = await svc.resolveUserCampaignRole('camp-1', null, false);
    assert.strictEqual(role, 'public');
  });

  test('resolveUserCampaignRole returns null if campaign does not exist', async () => {
    const svc = buildService({
      queryImpl: async () => ({ rows: [] }),
    });
    const role = await svc.resolveUserCampaignRole('nonexistent', 'user-1', false);
    assert.strictEqual(role, null);
  });

  test('resolveUserCampaignRole returns owner for campaign creator', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'user-creator' }] };
        }
        return { rows: [] };
      },
    });
    const role = await svc.resolveUserCampaignRole('camp-1', 'user-creator', false);
    assert.strictEqual(role, 'owner');
  });

  test('resolveUserCampaignRole returns team role for accepted campaign member', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'other-user' }] };
        }
        if (sql.includes('FROM campaign_members')) {
          return { rows: [{ role: 'editor', accepted_at: '2026-01-01' }] };
        }
        return { rows: [] };
      },
    });
    const role = await svc.resolveUserCampaignRole('camp-1', 'user-editor', false);
    assert.strictEqual(role, 'editor');
  });

  test('resolveUserCampaignRole returns backer for active contributor', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        if (sql.includes('FROM campaign_members')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT wallet_public_key FROM users')) {
          return { rows: [{ wallet_public_key: 'G_BACKER_WALLET' }] };
        }
        if (sql.includes('FROM contributions')) {
          return { rows: [{ 1: 1 }] };
        }
        return { rows: [] };
      },
    });
    const role = await svc.resolveUserCampaignRole('camp-1', 'user-backer', false);
    assert.strictEqual(role, 'backer');
  });

  test('resolveUserCampaignRole returns public for non-contributor authenticated user', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        if (sql.includes('FROM campaign_members')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT wallet_public_key FROM users')) {
          return { rows: [{ wallet_public_key: 'G_STRANGER_WALLET' }] };
        }
        if (sql.includes('FROM contributions')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const role = await svc.resolveUserCampaignRole('camp-1', 'user-stranger', false);
    assert.strictEqual(role, 'public');
  });
});

test.describe('campaignDataRoomService - access rules', () => {
  const svc = buildService();

  test('canAccessFile adheres to hierarchy', () => {
    // public role can only access public files
    assert.strictEqual(svc.canAccessFile('public', 'public'), true);
    assert.strictEqual(svc.canAccessFile('public', 'backer'), false);
    assert.strictEqual(svc.canAccessFile('public', 'viewer'), false);

    // backer can access public and backer
    assert.strictEqual(svc.canAccessFile('backer', 'public'), true);
    assert.strictEqual(svc.canAccessFile('backer', 'backer'), true);
    assert.strictEqual(svc.canAccessFile('backer', 'viewer'), false);
    assert.strictEqual(svc.canAccessFile('backer', 'owner'), false);

    // viewer can access public, backer, viewer
    assert.strictEqual(svc.canAccessFile('viewer', 'viewer'), true);
    assert.strictEqual(svc.canAccessFile('viewer', 'editor'), false);

    // editor can access up to editor
    assert.strictEqual(svc.canAccessFile('editor', 'editor'), true);
    assert.strictEqual(svc.canAccessFile('editor', 'manager'), false);

    // owner and admin can access everything
    assert.strictEqual(svc.canAccessFile('owner', 'owner'), true);
    assert.strictEqual(svc.canAccessFile('admin', 'owner'), true);
  });

  test('canUploadFile requires at least editor and cannot exceed own role level', () => {
    assert.strictEqual(svc.canUploadFile('public', 'public'), false);
    assert.strictEqual(svc.canUploadFile('backer', 'backer'), false);
    assert.strictEqual(svc.canUploadFile('viewer', 'viewer'), false);

    // editor can upload public, backer, viewer, editor
    assert.strictEqual(svc.canUploadFile('editor', 'public'), true);
    assert.strictEqual(svc.canUploadFile('editor', 'backer'), true);
    assert.strictEqual(svc.canUploadFile('editor', 'viewer'), true);
    assert.strictEqual(svc.canUploadFile('editor', 'editor'), true);
    assert.strictEqual(svc.canUploadFile('editor', 'manager'), false);
    assert.strictEqual(svc.canUploadFile('editor', 'owner'), false);

    // manager can upload up to manager
    assert.strictEqual(svc.canUploadFile('manager', 'manager'), true);
    assert.strictEqual(svc.canUploadFile('manager', 'owner'), false);

    // owner can upload anything
    assert.strictEqual(svc.canUploadFile('owner', 'owner'), true);
  });

  test('canManageFile rules for owner, manager, and editor', () => {
    const ownerFile = { access_level: 'owner', uploaded_by: 'u-other' };
    const editorFile = { access_level: 'editor', uploaded_by: 'u-editor' };

    // Owner can manage all
    assert.strictEqual(svc.canManageFile('owner', 'u-owner', ownerFile), true);
    // Manager can manage editor file but not owner file
    assert.strictEqual(svc.canManageFile('manager', 'u-mgr', editorFile), true);
    assert.strictEqual(svc.canManageFile('manager', 'u-mgr', ownerFile), false);
    // Editor can only manage their own file
    assert.strictEqual(svc.canManageFile('editor', 'u-editor', editorFile), true);
    assert.strictEqual(svc.canManageFile('editor', 'u-diff-editor', editorFile), false);
  });

  test('canViewAuditLogs restricted to manager, owner, admin', () => {
    assert.strictEqual(svc.canViewAuditLogs('public'), false);
    assert.strictEqual(svc.canViewAuditLogs('backer'), false);
    assert.strictEqual(svc.canViewAuditLogs('viewer'), false);
    assert.strictEqual(svc.canViewAuditLogs('editor'), false);
    assert.strictEqual(svc.canViewAuditLogs('manager'), true);
    assert.strictEqual(svc.canViewAuditLogs('owner'), true);
    assert.strictEqual(svc.canViewAuditLogs('admin'), true);
  });
});

test.describe('campaignDataRoomService - file operations', () => {
  test('listDataRoomFiles filters files by accessible levels and category', async () => {
    const executedQueries = [];
    const svc = buildService({
      queryImpl: async (sql, params) => {
        executedQueries.push({ sql, params });
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        if (sql.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 2 }] };
        }
        if (sql.includes('SELECT category, COUNT(*)::int')) {
          return { rows: [{ category: 'financials', count: 2 }] };
        }
        if (sql.includes('SELECT f.id, f.campaign_id')) {
          return {
            rows: [
              {
                id: 'file-1',
                campaign_id: 'camp-1',
                uploaded_by: 'creator-1',
                name: 'Financials Q1',
                original_filename: 'q1.pdf',
                file_url: 'https://storage/q1.pdf',
                file_size: 1024,
                mime_type: 'application/pdf',
                category: 'financials',
                access_level: 'owner',
                status: 'active',
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
          };
        }
        return { rows: [] };
      },
    });

    const res = await svc.listDataRoomFiles('camp-1', 'creator-1', {
      category: 'financials',
    });

    assert.strictEqual(res.total, 2);
    assert.strictEqual(res.files.length, 1);
    assert.strictEqual(res.user_role, 'owner');
    assert.strictEqual(res.can_upload, true);
    assert.strictEqual(res.can_view_logs, true);
    assert.strictEqual(res.files[0].can_manage, true);
    assert.strictEqual(res.categories_summary.financials, 2);
  });

  test('createDataRoomFile rejects unauthorized user with 403', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        return { rows: [] }; // viewer or stranger
      },
    });

    await assert.rejects(
      svc.createDataRoomFile('camp-1', 'user-viewer', {
        name: 'Secret',
        file_url: 'https://storage/secret.pdf',
        access_level: 'owner',
      }),
      err => err.status === 403
    );
  });

  test('createDataRoomFile saves valid file and logs access', async () => {
    const inserts = [];
    const svc = buildService({
      queryImpl: async (sql, params) => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        if (sql.includes('INSERT INTO campaign_data_room_files')) {
          inserts.push({ sql, params });
          return {
            rows: [
              {
                id: 'f-100',
                campaign_id: 'camp-1',
                name: 'Investor Deck',
                original_filename: 'deck.pdf',
                file_url: 'https://cdn/deck.pdf',
                file_size: 2048,
                mime_type: 'application/pdf',
                category: 'pitch_deck',
                access_level: 'backer',
                status: 'active',
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO campaign_data_room_access_logs')) {
          inserts.push({ sql, params });
          return { rows: [] };
        }
        return { rows: [] };
      },
    });

    const created = await svc.createDataRoomFile(
      'camp-1',
      'creator-1',
      {
        name: 'Investor Deck',
        original_filename: 'deck.pdf',
        file_url: 'https://cdn/deck.pdf',
        file_size: 2048,
        mime_type: 'application/pdf',
        category: 'pitch_deck',
        access_level: 'backer',
      },
      { ipAddress: '127.0.0.1' }
    );

    assert.strictEqual(created.id, 'f-100');
    assert.strictEqual(created.can_manage, true);
    assert.strictEqual(inserts.length, 2);
  });

  test('getDataRoomFile rejects unauthorized view with 403', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT f.*')) {
          return {
            rows: [
              {
                id: 'f-secret',
                campaign_id: 'camp-1',
                access_level: 'owner',
                name: 'Cap Table',
              },
            ],
          };
        }
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        // user is stranger/public
        return { rows: [] };
      },
    });

    await assert.rejects(
      svc.getDataRoomFile('camp-1', 'f-secret', 'user-stranger'),
      err => err.status === 403
    );
  });

  test('updateDataRoomFile updates metadata and prevents escalating access_level', async () => {
    const updates = [];
    const svc = buildService({
      queryImpl: async (sql, params) => {
        if (sql.includes('SELECT * FROM campaign_data_room_files')) {
          return {
            rows: [
              {
                id: 'f-1',
                campaign_id: 'camp-1',
                uploaded_by: 'editor-1',
                access_level: 'editor',
                name: 'Specs',
                category: 'technical',
              },
            ],
          };
        }
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'other-user' }] };
        }
        if (sql.includes('FROM campaign_members')) {
          return { rows: [{ role: 'editor', accepted_at: '2026-01-01' }] };
        }
        if (sql.includes('UPDATE campaign_data_room_files')) {
          updates.push({ sql, params });
          return {
            rows: [
              {
                id: 'f-1',
                name: 'Updated Specs',
                category: 'technical',
                access_level: 'editor',
              },
            ],
          };
        }
        return { rows: [] };
      },
    });

    // Valid update by editor
    const result = await svc.updateDataRoomFile('camp-1', 'f-1', 'editor-1', {
      name: 'Updated Specs',
    });
    assert.strictEqual(result.name, 'Updated Specs');

    // Editor trying to set access_level to owner -> rejects with 403
    await assert.rejects(
      svc.updateDataRoomFile('camp-1', 'f-1', 'editor-1', {
        access_level: 'owner',
      }),
      err => err.status === 403
    );
  });

  test('deleteDataRoomFile marks file as deleted', async () => {
    const queries = [];
    const svc = buildService({
      queryImpl: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT * FROM campaign_data_room_files')) {
          return {
            rows: [
              {
                id: 'f-1',
                campaign_id: 'camp-1',
                uploaded_by: 'creator-1',
                access_level: 'owner',
              },
            ],
          };
        }
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        return { rows: [] };
      },
    });

    const del = await svc.deleteDataRoomFile('camp-1', 'f-1', 'creator-1');
    assert.strictEqual(del.success, true);
    assert.ok(queries.some(q => q.sql.includes("status = 'deleted'")));
  });

  test('getDataRoomAccessLogs allows managers and owners, rejects viewers', async () => {
    const svc = buildService({
      queryImpl: async sql => {
        if (sql.includes('SELECT creator_id FROM campaigns')) {
          return { rows: [{ creator_id: 'creator-1' }] };
        }
        if (sql.includes('FROM campaign_members')) {
          return { rows: [{ role: 'viewer', accepted_at: '2026-01-01' }] };
        }
        if (sql.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (sql.includes('SELECT l.id, l.file_id')) {
          return {
            rows: [
              {
                id: 'log-1',
                file_id: 'f-1',
                action: 'download',
                file_name: 'Audit.pdf',
              },
            ],
          };
        }
        return { rows: [] };
      },
    });

    // Viewer is rejected
    await assert.rejects(
      svc.getDataRoomAccessLogs('camp-1', 'viewer-user'),
      err => err.status === 403
    );

    // Creator / owner succeeds
    const logs = await svc.getDataRoomAccessLogs('camp-1', 'creator-1');
    assert.strictEqual(logs.total, 1);
    assert.strictEqual(logs.logs.length, 1);
  });
});
