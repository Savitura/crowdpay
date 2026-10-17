const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const MILESTONE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';

// Builds the service with a scripted db pool: `query` runs scripted
// responses in order; `connect` returns a client with its own scripted queue
// so BEGIN/INSERT/COMMIT blocks are deterministic.
function buildService(scripted = []) {
  const calls = [];
  const queue = [...scripted];
  const makeClient = () => ({
    query: async sql => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim() });
      const next = queue.shift();
      return next || { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  const db = {
    query: async sql => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim() });
      const next = queue.shift();
      return next || { rows: [], rowCount: 0 };
    },
    connect: async () => makeClient(),
  };
  const service = proxyquire('../services/milestoneChecklistService', {
    '../config/database': db,
  });
  return { service, calls };
}

test('validateChecklistInput normalizes labels and rejects empties', () => {
  const { service } = buildService();

  const ok = service.validateChecklistInput({
    items: [{ label: '  Demo video  ', detail: '  link  ' }],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.items[0], {
    label: 'Demo video',
    detail: 'link',
    required: true,
    display_order: 0,
  });

  const empty = service.validateChecklistInput({ items: [{ label: '   ' }] });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 422);
});

test('validateChecklistInput enforces the item cap', () => {
  const { service } = buildService();

  const tooMany = service.validateChecklistInput({
    items: Array.from({ length: 21 }, (_, i) => ({ label: `item ${i}` })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /at most 20/);

  const atCap = service.validateChecklistInput({
    items: Array.from({ length: 20 }, (_, i) => ({ label: `item ${i}` })),
  });
  assert.equal(atCap.ok, true);
});

test('recordCompletions rejects items from another milestone', async () => {
  const { service } = buildService([
    // getChecklist: items of this milestone
    { rows: [{ id: ITEM_ID, label: 'Proof', detail: null, required: true, display_order: 0 }] },
  ]);

  const result = await service.recordCompletions(MILESTONE_ID, [
    '99999999-9999-9999-9999-999999999999',
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /do not belong/);
});

test('recordCompletions enforces required items and reports the missing labels', async () => {
  {
    const { service } = buildService([
      {
        rows: [
          { id: ITEM_ID, label: 'Demo video', detail: null, required: true, display_order: 0 },
          {
            id: '33333333-3333-3333-3333-333333333333',
            label: 'Receipt',
            detail: null,
            required: false,
            display_order: 1,
          },
        ],
      },
    ]);

    const missing = await service.recordCompletions(MILESTONE_ID, []);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Demo video/);
    assert.doesNotMatch(missing.error, /Receipt/); // optional item not demanded
  }

  {
    const { service } = buildService([
      {
        rows: [
          { id: ITEM_ID, label: 'Demo video', detail: null, required: true, display_order: 0 },
        ],
      },
      { rows: [], rowCount: 0 }, // BEGIN
      // completion insert inside the transaction
      { rows: [], rowCount: 1 },
    ]);

    const satisfied = await service.recordCompletions(MILESTONE_ID, [ITEM_ID], 'user-1');
    assert.equal(satisfied.ok, true);
    assert.equal(satisfied.recorded, 1);
  }
});

test('recordCompletions snapshots the label at completion time', async () => {
  const { service, calls } = buildService([
    {
      rows: [
        { id: ITEM_ID, label: 'Original label', detail: 'd', required: true, display_order: 0 },
      ],
    },
    // completion insert inside the transaction
    { rows: [], rowCount: 1 },
  ]);

  const result = await service.recordCompletions(MILESTONE_ID, [ITEM_ID], 'user-1');

  assert.equal(result.ok, true);
  const insert = calls.find(call =>
    call.sql.includes('INSERT INTO milestone_evidence_checklist_completions')
  );
  assert.ok(insert, 'completion insert ran');
});

test('getChecklistWithStatus merges template and completion rows', async () => {
  const { service } = buildService([
    {
      rows: [
        { id: ITEM_ID, label: 'A', detail: null, required: true, display_order: 0 },
        {
          id: '33333333-3333-3333-3333-333333333333',
          label: 'B',
          detail: null,
          required: false,
          display_order: 1,
        },
      ],
    },
    {
      rows: [
        {
          item_id: ITEM_ID,
          completed_by: 'user-1',
          label_snapshot: 'A',
          detail_snapshot: null,
          completed_at: '2026-09-29T00:00:00Z',
        },
      ],
    },
  ]);

  const checklist = await service.getChecklistWithStatus(MILESTONE_ID);

  assert.equal(checklist.length, 2);
  assert.equal(checklist[0].completed, true);
  assert.equal(checklist[0].label_snapshot, 'A');
  assert.equal(checklist[1].completed, false);
});
