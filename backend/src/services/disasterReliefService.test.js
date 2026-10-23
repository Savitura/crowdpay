const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const DOSSIER_ID = '44444444-4444-4444-8444-444444444444';

const SAMPLE_EVIDENCE = [
  {
    id: 'nema_flood_bulletin',
    title: 'NEMA Flood Emergency Bulletin',
    type: 'government_notice',
    url: 'https://nema.gov.example/bulletins/2026-flood-alert',
    issuer: 'National Emergency Management Agency',
  },
];

function buildService(handlers = [], { notificationsThrow = false } = {}) {
  const calls = [];
  const queue = [...handlers];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      const match = queue.find(([fragment]) => String(sql).includes(fragment));
      if (!match) return { rows: [], rowCount: 0 };
      const result = match[1];
      return typeof result === 'function' ? result(sql, params) : result;
    },
    release() {},
  };
  const db = {
    query: (sql, params) => client.query(sql, params),
    connect: async () => client,
  };
  const notified = [];
  const audits = [];
  const service = proxyquire('./disasterReliefService', {
    '../config/database': db,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './notifications': {
      createNotification: async (userId, message) => {
        if (notificationsThrow) throw new Error('notification broker unavailable');
        notified.push({ userId, message });
      },
    },
    './auditService': {
      logAuditEvent: async event => {
        audits.push(event);
      },
    },
  });
  return { service, calls, notified, audits };
}

function dossierRow(overrides = {}) {
  return {
    id: DOSSIER_ID,
    campaign_id: CAMPAIGN_ID,
    created_by: CREATOR_ID,
    incident_name: 'Lower Niger Basin Flood Response',
    disaster_type: 'flood',
    severity_level: 'critical',
    affected_region: 'Kogi & Anambra States',
    affected_population: 25000,
    responder_organization: 'Red Crescent Field Unit',
    emergency_contact: 'ops-lead@redcrescent.example / +234-800-000-0000',
    verification_badge: null,
    evidence_items: SAMPLE_EVIDENCE,
    status: 'draft',
    rapid_disbursement_enabled: false,
    submitted_at: null,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    revoked_by: null,
    revoked_at: null,
    revoked_reason: null,
    created_at: '2026-10-23T08:00:00.000Z',
    updated_at: '2026-10-23T08:00:00.000Z',
    ...overrides,
  };
}

// ── validation & security checks ───────────────────────────────────────────

test('validateDossierInput normalises valid disaster-relief fields and strips HTML tags', () => {
  const { service } = buildService();
  const parsed = service.validateDossierInput({
    incident_name: '  <b>Lower Niger Basin</b> Flood Response  ',
    disaster_type: 'Flood',
    severity_level: 'CRITICAL',
    affected_region: '  Kogi & Anambra States ',
    affected_population: '25000',
    responder_organization: '  <script>alert(1)</script>Red Crescent  ',
    emergency_contact: '  ops@redcrescent.example  ',
    evidence_items: [
      {
        title: '  NEMA Flood Emergency Bulletin ',
        type: 'government_notice',
        url: 'https://nema.gov.example/bulletins/2026',
        issuer: 'NEMA',
      },
    ],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.dossier.incident_name, 'Lower Niger Basin Flood Response');
  assert.equal(parsed.dossier.disaster_type, 'flood');
  assert.equal(parsed.dossier.severity_level, 'critical');
  assert.equal(parsed.dossier.affected_region, 'Kogi & Anambra States');
  assert.equal(parsed.dossier.affected_population, 25000);
  assert.equal(parsed.dossier.responder_organization, 'alert(1)Red Crescent');
  assert.equal(parsed.dossier.emergency_contact, 'ops@redcrescent.example');
  assert.equal(parsed.dossier.evidence_items.length, 1);
  assert.equal(parsed.dossier.evidence_items[0].id, 'nema_flood_emergency_bulletin');
});

test('validateDossierInput rejects missing required fields, invalid enums, and invalid populations', () => {
  const { service } = buildService();

  assert.equal(service.validateDossierInput(null).status, 422);
  assert.equal(service.validateDossierInput({}).status, 422);
  assert.equal(
    service.validateDossierInput({
      incident_name: 'Flood',
      disaster_type: 'asteroid',
      severity_level: 'critical',
      affected_region: 'Lagos',
    }).status,
    422
  );
  assert.equal(
    service.validateDossierInput({
      incident_name: 'Flood',
      disaster_type: 'flood',
      severity_level: ' apocalyptic ',
      affected_region: 'Lagos',
    }).status,
    422
  );
  assert.equal(
    service.validateDossierInput({
      incident_name: 'Flood',
      disaster_type: 'flood',
      severity_level: 'critical',
      affected_region: '   ',
    }).status,
    422
  );
  assert.equal(
    service.validateDossierInput({
      incident_name: 'Flood',
      disaster_type: 'flood',
      severity_level: 'critical',
      affected_region: 'Lagos',
      affected_population: -10,
    }).status,
    422
  );
  assert.equal(
    service.validateDossierInput({
      incident_name: 'Flood',
      disaster_type: 'flood',
      severity_level: 'critical',
      affected_region: 'Lagos',
      affected_population: true,
    }).status,
    422
  );
});

test('validateEvidenceItems enforces HTTPS-only public URLs and caps item count', () => {
  const { service } = buildService();

  // Rejects non-HTTPS (http:, javascript:, data:)
  assert.equal(
    service.validateEvidenceItems([
      { title: 'Insecure Doc', type: 'media_report', url: 'http://example.com/doc.pdf' },
    ]).status,
    422
  );
  assert.equal(
    service.validateEvidenceItems([
      { title: 'XSS Link', type: 'media_report', url: 'javascript:alert(1)' },
    ]).status,
    422
  );
  // Rejects localhost / private loopback SSRF targets
  assert.equal(
    service.validateEvidenceItems([
      { title: 'Localhost', type: 'media_report', url: 'https://localhost/internal' },
    ]).status,
    422
  );
  assert.equal(
    service.validateEvidenceItems([
      { title: 'Loopback', type: 'media_report', url: 'https://127.0.0.1/secret' },
    ]).status,
    422
  );

  // Enforces MAX_EVIDENCE_ITEMS cap
  const tooMany = Array.from({ length: service.MAX_EVIDENCE_ITEMS + 1 }, (_, i) => ({
    title: `Doc ${i + 1}`,
    type: 'media_report',
    url: `https://news.example.org/report-${i + 1}`,
  }));
  const capRes = service.validateEvidenceItems(tooMany);
  assert.equal(capRes.ok, false);
  assert.equal(capRes.status, 422);

  // Deduplicates identical evidence titles into distinct ids
  const dedup = service.validateEvidenceItems([
    { title: 'Field Photo', type: 'field_assessment', url: 'https://cdn.example.org/1.jpg' },
    { title: 'Field Photo', type: 'field_assessment', url: 'https://cdn.example.org/2.jpg' },
  ]);
  assert.equal(dedup.ok, true);
  assert.equal(dedup.evidenceItems[0].id, 'field_photo');
  assert.equal(dedup.evidenceItems[1].id, 'field_photo_2');
});

test('computeSlaMetrics calculates 4-hour rapid verification target and overdue flag', () => {
  const { service } = buildService();
  const submittedAt = '2026-10-23T08:00:00.000Z';

  const withinSla = service.computeSlaMetrics(
    { status: 'pending_review', submitted_at: submittedAt },
    new Date('2026-10-23T10:30:00.000Z')
  );
  assert.equal(withinSla.target_hours, 4);
  assert.equal(withinSla.due_at, '2026-10-23T12:00:00.000Z');
  assert.equal(withinSla.is_overdue, false);
  assert.equal(withinSla.remaining_ms, 90 * 60 * 1000);

  const overdue = service.computeSlaMetrics(
    { status: 'pending_review', submitted_at: submittedAt },
    new Date('2026-10-23T12:15:00.000Z')
  );
  assert.equal(overdue.is_overdue, true);
  assert.equal(overdue.remaining_ms, -15 * 60 * 1000);
});

// ── public vs manager view privacy boundary ────────────────────────────────

test('getDisasterReliefView hides unverified statuses and strips internal contact/notes for public callers', async () => {
  let currentStatus = 'pending_review';
  const { service } = buildService([
    [
      'FROM campaign_disaster_relief',
      () => ({
        rows: [
          dossierRow({
            status: currentStatus,
            submitted_at: '2026-10-23T08:00:00.000Z',
            reviewed_by: ADMIN_ID,
            reviewed_at: '2026-10-23T09:10:00.000Z',
            review_note: 'Internal security note: verified via phone tree',
            verification_badge: 'Verified Rapid Response',
            rapid_disbursement_enabled: true,
          }),
        ],
        rowCount: 1,
      }),
    ],
  ]);

  // Public caller cannot see pending_review dossier
  const pendingPublic = await service.getDisasterReliefView(CAMPAIGN_ID, { isManager: false });
  assert.deepEqual(pendingPublic, { disaster_relief: null });

  // Manager can see pending_review dossier with emergency_contact and SLA
  const pendingManager = await service.getDisasterReliefView(CAMPAIGN_ID, { isManager: true });
  assert.equal(pendingManager.disaster_relief.status, 'pending_review');
  assert.equal(
    pendingManager.disaster_relief.emergency_contact,
    'ops-lead@redcrescent.example / +234-800-000-0000'
  );
  assert.ok(pendingManager.disaster_relief.sla);

  // Once verified, public caller sees badge & evidence, but emergency_contact and review_note are redacted
  currentStatus = 'verified';
  const verifiedPublic = await service.getDisasterReliefView(CAMPAIGN_ID, { isManager: false });
  assert.equal(verifiedPublic.disaster_relief.status, 'verified');
  assert.equal(verifiedPublic.disaster_relief.verification_badge, 'Verified Rapid Response');
  assert.equal(verifiedPublic.disaster_relief.rapid_disbursement_enabled, true);
  assert.equal('emergency_contact' in verifiedPublic.disaster_relief, false);
  assert.equal('review_note' in verifiedPublic.disaster_relief, false);
  assert.equal('reviewed_by' in verifiedPublic.disaster_relief, false);
});

// ── create / update / submit / review / revoke lifecycle ───────────────────

test('createDisasterReliefDossier creates a draft dossier and records an audit event', async () => {
  const { service, audits } = buildService([
    [
      'FROM campaigns',
      {
        rows: [
          { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Flood Relief', status: 'active' },
        ],
        rowCount: 1,
      },
    ],
    ['INSERT INTO campaign_disaster_relief\n', { rows: [dossierRow()], rowCount: 1 }],
    ['INSERT INTO campaign_disaster_relief_events', { rows: [], rowCount: 1 }],
  ]);

  const created = await service.createDisasterReliefDossier({
    campaignId: CAMPAIGN_ID,
    actorId: CREATOR_ID,
    incident_name: 'Lower Niger Basin Flood Response',
    disaster_type: 'flood',
    severity_level: 'critical',
    affected_region: 'Kogi & Anambra States',
    affected_population: 25000,
    emergency_contact: 'ops-lead@redcrescent.example',
    evidence_items: SAMPLE_EVIDENCE,
  });

  assert.equal(created.status, 'draft');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'disaster_relief.created');
});

test('createDisasterReliefDossier rejects cancelled/completed campaigns and duplicate dossiers', async () => {
  const { service: completedService } = buildService([
    [
      'FROM campaigns',
      {
        rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Old', status: 'completed' }],
        rowCount: 1,
      },
    ],
  ]);

  await assert.rejects(
    () =>
      completedService.createDisasterReliefDossier({
        campaignId: CAMPAIGN_ID,
        actorId: CREATOR_ID,
        incident_name: 'Flood',
        disaster_type: 'flood',
        severity_level: 'urgent',
        affected_region: 'Lagos',
      }),
    err => err.status === 409
  );

  const { service: dupService } = buildService([
    [
      'FROM campaigns',
      {
        rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Active', status: 'active' }],
        rowCount: 1,
      },
    ],
    [
      'INSERT INTO campaign_disaster_relief\n',
      () => {
        const dup = new Error('duplicate key value');
        dup.code = '23505';
        throw dup;
      },
    ],
  ]);

  await assert.rejects(
    () =>
      dupService.createDisasterReliefDossier({
        campaignId: CAMPAIGN_ID,
        actorId: CREATOR_ID,
        incident_name: 'Flood',
        disaster_type: 'flood',
        severity_level: 'urgent',
        affected_region: 'Lagos',
      }),
    err => err.status === 409 && /already exists/i.test(err.message)
  );
});

test('submitForRapidVerification requires evidence and emergency contact, then transitions to pending_review', async () => {
  // Missing evidence_items -> 422
  const { service: missingEvidenceSvc } = buildService([
    [
      'FROM campaign_disaster_relief',
      {
        rows: [dossierRow({ evidence_items: [], emergency_contact: 'ops@example.org' })],
        rowCount: 1,
      },
    ],
  ]);
  await assert.rejects(
    () =>
      missingEvidenceSvc.submitForRapidVerification({
        campaignId: CAMPAIGN_ID,
        actorId: CREATOR_ID,
      }),
    err => err.status === 422 && /evidence item/i.test(err.message)
  );

  // Missing emergency_contact -> 422
  const { service: missingContactSvc } = buildService([
    [
      'FROM campaign_disaster_relief',
      {
        rows: [dossierRow({ evidence_items: SAMPLE_EVIDENCE, emergency_contact: null })],
        rowCount: 1,
      },
    ],
  ]);
  await assert.rejects(
    () =>
      missingContactSvc.submitForRapidVerification({
        campaignId: CAMPAIGN_ID,
        actorId: CREATOR_ID,
      }),
    err => err.status === 422 && /emergency contact/i.test(err.message)
  );

  // Valid draft -> pending_review
  const { service: okSvc, audits } = buildService([
    [
      'FROM campaign_disaster_relief',
      {
        rows: [dossierRow({ status: 'draft' })],
        rowCount: 1,
      },
    ],
    [
      'UPDATE campaign_disaster_relief',
      {
        rows: [
          dossierRow({
            status: 'pending_review',
            submitted_at: '2026-10-23T08:30:00.000Z',
          }),
        ],
        rowCount: 1,
      },
    ],
    ['INSERT INTO campaign_disaster_relief_events', { rows: [], rowCount: 1 }],
  ]);

  const submitted = await okSvc.submitForRapidVerification({
    campaignId: CAMPAIGN_ID,
    actorId: CREATOR_ID,
  });
  assert.equal(submitted.status, 'pending_review');
  assert.ok(submitted.sla);
  assert.equal(audits[0].action, 'disaster_relief.submitted');
});

test('reviewDisasterReliefDossier supports verified, changes_requested, and rejected decisions and notifies the creator', async () => {
  // changes_requested without note -> 422
  const { service: noNoteSvc } = buildService([]);
  await assert.rejects(
    () =>
      noNoteSvc.reviewDisasterReliefDossier({
        campaignId: CAMPAIGN_ID,
        reviewerId: ADMIN_ID,
        decision: 'changes_requested',
        note: '   ',
      }),
    err => err.status === 422 && /reviewer note is required/i.test(err.message)
  );

  // Verified decision -> sets badge, rapid_disbursement_enabled, notifies creator
  const {
    service: verifySvc,
    notified,
    audits,
  } = buildService([
    [
      'FROM campaigns',
      {
        rows: [
          { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Flood Relief', status: 'active' },
        ],
        rowCount: 1,
      },
    ],
    [
      'FROM campaign_disaster_relief',
      {
        rows: [dossierRow({ status: 'pending_review', submitted_at: '2026-10-23T08:00:00.000Z' })],
        rowCount: 1,
      },
    ],
    [
      'UPDATE campaign_disaster_relief',
      {
        rows: [
          dossierRow({
            status: 'verified',
            verification_badge: 'Verified Rapid Response',
            rapid_disbursement_enabled: true,
            reviewed_by: ADMIN_ID,
            reviewed_at: '2026-10-23T09:00:00.000Z',
            review_note: 'Confirmed with NEMA duty officer',
          }),
        ],
        rowCount: 1,
      },
    ],
    ['INSERT INTO campaign_disaster_relief_events', { rows: [], rowCount: 1 }],
  ]);

  const verified = await verifySvc.reviewDisasterReliefDossier({
    campaignId: CAMPAIGN_ID,
    reviewerId: ADMIN_ID,
    decision: 'verified',
    note: 'Confirmed with NEMA duty officer',
    rapidDisbursementEnabled: true,
  });

  assert.equal(verified.status, 'verified');
  assert.equal(verified.rapid_disbursement_enabled, true);
  assert.equal(verified.verification_badge, 'Verified Rapid Response');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].userId, CREATOR_ID);
  assert.match(notified[0].message, /verified for disaster-relief mode/i);
  assert.equal(audits[0].action, 'disaster_relief.verified');
});

test('revokeDisasterReliefVerification revokes a verified dossier, disables rapid disbursement, and handles notification failures gracefully', async () => {
  const { service, audits } = buildService(
    [
      [
        'FROM campaigns',
        {
          rows: [
            { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Flood Relief', status: 'active' },
          ],
          rowCount: 1,
        },
      ],
      [
        'FROM campaign_disaster_relief',
        {
          rows: [
            dossierRow({
              status: 'verified',
              rapid_disbursement_enabled: true,
              verification_badge: 'Verified Rapid Response',
            }),
          ],
          rowCount: 1,
        },
      ],
      [
        'UPDATE campaign_disaster_relief',
        {
          rows: [
            dossierRow({
              status: 'revoked',
              rapid_disbursement_enabled: false,
              revoked_by: ADMIN_ID,
              revoked_at: '2026-10-23T11:00:00.000Z',
              revoked_reason: 'Field partner authorization expired',
            }),
          ],
          rowCount: 1,
        },
      ],
      ['INSERT INTO campaign_disaster_relief_events', { rows: [], rowCount: 1 }],
    ],
    { notificationsThrow: true }
  );

  const revoked = await service.revokeDisasterReliefVerification({
    campaignId: CAMPAIGN_ID,
    actorId: ADMIN_ID,
    reason: 'Field partner authorization expired',
  });

  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.rapid_disbursement_enabled, false);
  assert.equal(audits[0].action, 'disaster_relief.revoked');
});

test('concurrent state transition returns 409 when compare-and-set UPDATE affects 0 rows', async () => {
  const { service } = buildService([
    [
      'FROM campaigns',
      {
        rows: [
          { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Flood Relief', status: 'active' },
        ],
        rowCount: 1,
      },
    ],
    [
      'FROM campaign_disaster_relief',
      {
        rows: [dossierRow({ status: 'pending_review', submitted_at: '2026-10-23T08:00:00.000Z' })],
        rowCount: 1,
      },
    ],
    ['UPDATE campaign_disaster_relief', { rows: [], rowCount: 0 }],
  ]);

  await assert.rejects(
    () =>
      service.reviewDisasterReliefDossier({
        campaignId: CAMPAIGN_ID,
        reviewerId: ADMIN_ID,
        decision: 'verified',
      }),
    err => err.status === 409 && /changed concurrently/i.test(err.message)
  );
});

test('listRapidVerificationQueue validates status filter and enriches queue items with SLA metrics', async () => {
  const { service } = buildService([
    [
      'FROM campaign_disaster_relief dr',
      {
        rows: [
          {
            ...dossierRow({
              status: 'pending_review',
              submitted_at: '2026-10-23T08:00:00.000Z',
            }),
            campaign_title: 'Flood Relief',
            campaign_status: 'active',
            creator_id: CREATOR_ID,
          },
        ],
        rowCount: 1,
      },
    ],
  ]);

  await assert.rejects(
    () => service.listRapidVerificationQueue({ status: 'unknown_state' }),
    err => err.status === 422
  );

  const queue = await service.listRapidVerificationQueue({ status: 'pending_review' });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].campaign_title, 'Flood Relief');
  assert.ok(queue[0].sla);
});
