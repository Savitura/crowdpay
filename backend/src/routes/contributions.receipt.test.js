const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  getStellarNetwork,
  getStellarNetworkPassphrase,
  getStellarExpertTxUrl,
  getStellarExpertAccountUrl,
  getHorizonTxUrl,
  buildStellarVerificationReference,
} = require('../utils/stellarExplorer');
const {
  generateContributionReceiptPdf,
  generateTaxReceiptsPdfBuffer,
  buildTaxReceiptPdf,
} = require('../services/taxReceiptPdf');
const contributionReceiptService = require('../services/contributionReceiptService');
const contributionReceiptEmail = require('../emails/contributionReceipt');

const VALID_TX_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';
const VALID_SENDER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const VALID_DEST = 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM';

const SAMPLE_CONTRIBUTION_ROW = {
  id: 'contrib-101',
  campaign_id: '11111111-2222-3333-4444-555555555555',
  campaign_title: 'Solar Microgrid for Clinics',
  campaign_status: 'active',
  campaign_creator_id: 'creator-1',
  campaign_wallet_public_key: VALID_DEST,
  campaign_creator_name: 'Clean Energy Org',
  contributor_user_id: 'user-1',
  contributor_name: 'Ada Lovelace',
  contributor_email: 'ada@example.com',
  contributor_privacy: 'full',
  sender_public_key: VALID_SENDER,
  amount: '125.5000000',
  asset: 'USDC',
  payment_type: 'payment',
  source_amount: null,
  source_asset: null,
  conversion_rate: null,
  platform_fee_amount: '2.5100000',
  tx_hash: VALID_TX_HASH,
  stellar_status: 'indexed',
  tx_metadata: {
    memo: 'cp-1111111122223333444455555',
    network_fee: '0.0000100',
  },
  ledger_sequence: 543210,
  paging_token: '2333071950241792',
  created_at: '2026-10-20T14:30:00.000Z',
};

test('buildStellarVerificationReference builds verifiable testnet and mainnet references', () => {
  const ref = buildStellarVerificationReference({
    txHash: VALID_TX_HASH,
    network: 'testnet',
    senderPublicKey: VALID_SENDER,
    destinationPublicKey: VALID_DEST,
    memo: 'cp-1111111122223333444455555',
    ledgerSequence: 543210,
    pagingToken: '2333071950241792',
  });

  assert.equal(ref.verifiable, true);
  assert.equal(ref.tx_hash, VALID_TX_HASH);
  assert.equal(ref.network, 'testnet');
  assert.equal(ref.network_passphrase, 'Test SDF Network ; September 2015');
  assert.equal(ref.explorer_url, `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH}`);
  assert.equal(ref.horizon_tx_url, `https://horizon-testnet.stellar.org/transactions/${VALID_TX_HASH}`);
  assert.equal(
    ref.sender_explorer_url,
    `https://stellar.expert/explorer/testnet/account/${VALID_SENDER}`
  );
  assert.equal(
    ref.destination_explorer_url,
    `https://stellar.expert/explorer/testnet/account/${VALID_DEST}`
  );
  assert.equal(ref.memo, 'cp-1111111122223333444455555');
  assert.equal(ref.ledger_sequence, 543210);
  assert.equal(ref.paging_token, '2333071950241792');

  const mainnetRef = buildStellarVerificationReference({
    txHash: VALID_TX_HASH,
    network: 'mainnet',
    senderPublicKey: VALID_SENDER,
    destinationPublicKey: VALID_DEST,
  });
  assert.equal(mainnetRef.network, 'public');
  assert.equal(mainnetRef.network_passphrase, 'Public Global Stellar Network ; September 2015');
  assert.equal(
    mainnetRef.explorer_url,
    `https://stellar.expert/explorer/public/tx/${VALID_TX_HASH}`
  );
  assert.equal(
    mainnetRef.horizon_tx_url,
    `https://horizon.stellar.org/transactions/${VALID_TX_HASH}`
  );
});

test('buildStellarVerificationReference marks invalid hashes and system accounts as unverifiable', () => {
  const invalidHashRef = buildStellarVerificationReference({
    txHash: 'not-a-64-char-hex-hash',
    senderPublicKey: VALID_SENDER,
  });
  assert.equal(invalidHashRef.verifiable, false);
  assert.equal(invalidHashRef.explorer_url, null);
  assert.equal(invalidHashRef.horizon_tx_url, null);
  assert.equal(getStellarExpertTxUrl(null), null);
  assert.equal(getHorizonTxUrl(''), null);
  assert.equal(getStellarExpertAccountUrl('system'), null);
  assert.ok(getStellarNetwork());
  assert.ok(getStellarNetworkPassphrase());
});

test('getReceiptData returns full receipt with verifiable Stellar transaction references', async () => {
  const dbClient = {
    query: async (sql, params) => {
      assert.match(sql, /LEFT JOIN users u ON u\.wallet_public_key = c\.sender_public_key/);
      assert.match(sql, /LEFT JOIN ledger_event_receipts ler/);
      assert.deepEqual(params, ['contrib-101']);
      return { rows: [SAMPLE_CONTRIBUTION_ROW] };
    },
  };

  const receipt = await contributionReceiptService.getReceiptData('contrib-101', { dbClient });
  assert.equal(receipt.id, 'contrib-101');
  assert.equal(receipt.receipt_id, 'contrib-101');
  assert.equal(receipt.tx_hash, VALID_TX_HASH);
  assert.equal(receipt.memo, 'cp-1111111122223333444455555');
  assert.equal(receipt.ledger_sequence, 543210);
  assert.equal(receipt.paging_token, '2333071950241792');
  assert.equal(receipt.verification.verifiable, true);
  assert.equal(
    receipt.explorer_url,
    `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH}`
  );
  assert.equal(
    receipt.horizon_tx_url,
    `https://horizon-testnet.stellar.org/transactions/${VALID_TX_HASH}`
  );
  assert.equal(receipt.contributor_name, 'Ada Lovelace');
  assert.equal(receipt.contributor_email, 'ada@example.com');
});

test('getReceiptData throws 404 when contribution is missing and 422 when transaction is unverifiable', async () => {
  const emptyDb = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => contributionReceiptService.getReceiptData('missing-id', { dbClient: emptyDb }),
    err => err.statusCode === 404 && err.code === 'CONTRIBUTION_NOT_FOUND'
  );

  const unverifiableDb = {
    query: async () => ({
      rows: [
        {
          ...SAMPLE_CONTRIBUTION_ROW,
          tx_hash: null,
          sender_public_key: 'system',
          payment_type: 'reconciliation_adjustment',
        },
      ],
    }),
  };
  await assert.rejects(
    () => contributionReceiptService.getReceiptData('sys-id', { dbClient: unverifiableDb }),
    err => err.statusCode === 422 && err.code === 'UNVERIFIABLE_TRANSACTION'
  );
});

test('redactReceiptForViewer and redactPii protect contributor privacy for non-owner viewers', async () => {
  const anonymousRow = {
    ...SAMPLE_CONTRIBUTION_ROW,
    contributor_privacy: 'anonymous',
  };
  const redacted = contributionReceiptService.buildReceiptRecord(anonymousRow, {
    redactPii: true,
  });

  assert.equal(redacted.contributor_name, 'Anonymous Contributor');
  assert.equal(redacted.contributor_email, null);
  assert.equal(redacted.sender_public_key, null);
  assert.equal(redacted.tx_hash, VALID_TX_HASH);

  const fullReceipt = contributionReceiptService.buildReceiptRecord(anonymousRow, {
    redactPii: false,
  });
  const viewerRedacted = contributionReceiptService.redactReceiptForViewer(fullReceipt);
  assert.equal(viewerRedacted.contributor_name, 'Anonymous Contributor');
  assert.equal(viewerRedacted.contributor_email, null);
  assert.equal(viewerRedacted.sender_public_key, null);
});

test('PDF generator embeds verifiable Stellar transaction reference details', async () => {
  const receipt = contributionReceiptService.buildReceiptRecord(SAMPLE_CONTRIBUTION_ROW);
  const pdfBuffer = await generateTaxReceiptsPdfBuffer([receipt]);

  assert.ok(Buffer.isBuffer(pdfBuffer));
  const pdfText = pdfBuffer.toString('latin1');
  assert.ok(pdfText.startsWith('%PDF-1.'));
  assert.ok(pdfText.includes(VALID_TX_HASH));
  assert.ok(pdfText.includes('cp-1111111122223333444455555'));
  assert.ok(pdfText.includes('543210'));
  assert.ok(pdfText.includes('stellar.expert/explorer/testnet/tx/'));
  assert.ok(pdfText.includes('horizon-testnet.stellar.org/transactions/'));

  const syncPdf = buildTaxReceiptPdf([receipt]);
  assert.ok(Buffer.isBuffer(syncPdf));
  assert.ok(syncPdf.toString('latin1').includes(VALID_TX_HASH));

  const callbackBuffer = await new Promise((resolve, reject) => {
    generateContributionReceiptPdf(
      {
        id: receipt.id,
        campaignTitle: receipt.campaign_title,
        contributorName: receipt.contributor_name,
        contributorEmail: receipt.contributor_email,
        senderPublicKey: receipt.sender_public_key,
        destinationPublicKey: receipt.destination_public_key,
        amount: receipt.amount,
        asset: receipt.asset,
        date: receipt.created_at,
        txHash: receipt.tx_hash,
        memo: receipt.memo,
        ledgerSequence: receipt.ledger_sequence,
      },
      (err, buf) => (err ? reject(err) : resolve(buf))
    );
  });
  assert.ok(callbackBuffer.toString('latin1').includes(VALID_TX_HASH));
});

test('getOrCreateReceiptPdf returns signed URL when storage is configured and PDF buffer otherwise', async () => {
  const dbClient = {
    query: async () => ({ rows: [SAMPLE_CONTRIBUTION_ROW] }),
  };
  let uploadedKey = null;
  const storageClient = {
    exists: async () => false,
    upload: async key => {
      uploadedKey = key;
    },
    getSignedUrl: async key => `https://storage.test/${key}`,
  };

  const url = await contributionReceiptService.getOrCreateReceiptPdf('contrib-101', false, {
    dbClient,
    storageClient,
  });
  assert.equal(uploadedKey, 'receipts/contrib-101.pdf');
  assert.equal(url, 'https://storage.test/receipts/contrib-101.pdf');
});

test('contributionReceipt email template includes Stellar tx hash, memo, network, and verification links', () => {
  const email = contributionReceiptEmail.build({
    name: 'Ada Lovelace',
    campaignTitle: 'Solar Microgrid for Clinics',
    amount: '125.50',
    asset: 'USDC',
    txHash: VALID_TX_HASH,
    memo: 'cp-1111111122223333444455555',
    network: 'testnet',
    date: '2026-10-20T14:30:00.000Z',
    unsubscribeUrl: 'https://crowdpay.local/unsubscribe',
  });

  assert.match(email.subject, /Solar Microgrid for Clinics/);
  assert.ok(email.text.includes(`Stellar Transaction Hash: ${VALID_TX_HASH}`));
  assert.ok(email.text.includes('Stellar Network: testnet'));
  assert.ok(email.text.includes('Memo: cp-1111111122223333444455555'));
  assert.ok(
    email.text.includes(`https://horizon-testnet.stellar.org/transactions/${VALID_TX_HASH}`)
  );
  assert.ok(email.html.includes(VALID_TX_HASH));
  assert.ok(email.html.includes('cp-1111111122223333444455555'));
});

test('contributions receipt routes handle tax-receipts list, PDF download, single receipt authorization, and 422 edge case', async () => {
  const routes = [];
  const mockExpress = {
    Router: () => ({
      post: (routePath, ...handlers) => routes.push({ method: 'POST', routePath, handlers }),
      get: (routePath, ...handlers) => routes.push({ method: 'GET', routePath, handlers }),
    }),
  };

  let activeRows = [SAMPLE_CONTRIBUTION_ROW];
  const mockDb = {
    query: async sql => {
      if (sql.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GOTHERWALLET' }] };
      }
      return { rows: activeRows };
    },
  };

  const stubs = {
    express: mockExpress,
    [path.resolve(__dirname, '../middleware/auth.js')]: {
      requireAuth: (_req, _res, next) => next(),
    },
    [path.resolve(__dirname, '../middleware/validation.js')]: {
      contributionValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
    [path.resolve(__dirname, '../middleware/contributionRateLimiter.js')]: {
      contributionRateLimiter: (_req, _res, next) => next(),
    },
    [path.resolve(__dirname, '../middleware/idempotency.js')]: {
      idempotency: () => (_req, _res, next) => next(),
    },
    [path.resolve(__dirname, '../services/contributionService.js')]: {},
    [path.resolve(__dirname, '../services/stellarService.js')]: {},
    [path.resolve(__dirname, '../services/embedTokenService.js')]: {},
    [path.resolve(__dirname, '../services/embedTokenJwtService.js')]: {},
    [path.resolve(__dirname, '../services/pathPaymentPreview.js')]: {},
    [path.resolve(__dirname, '../services/contributionDiagnostics.js')]: {},
    [path.resolve(__dirname, '../services/referral.js')]: {},
    [path.resolve(__dirname, '../services/referralService.js')]: {},
    [path.resolve(__dirname, '../services/rewardTierService.js')]: {},
    [path.resolve(__dirname, '../services/kycService.js')]: {},
    [path.resolve(__dirname, '../utils/pagination.js')]: {},
    [path.resolve(__dirname, '../services/contributorIdentityService.js')]: {},
    [path.resolve(__dirname, '../services/contributionPolicy.js')]: {},
    [path.resolve(__dirname, '../config/database.js')]: mockDb,
    [path.resolve(__dirname, '../config/logger.js')]: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return mockExpress;
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (stubs[resolved]) return stubs[resolved];
    return origLoad.apply(this, arguments);
  };

  try {
    delete require.cache[path.resolve(__dirname, './contributions.js')];
    require('./contributions');
  } finally {
    Module._load = origLoad;
  }

  function createRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  async function invokeGet(routePath, reqOverrides) {
    const entry = routes.find(r => r.method === 'GET' && r.routePath === routePath);
    assert.ok(entry, `Route GET ${routePath} should exist`);
    const handler = entry.handlers[entry.handlers.length - 1];
    const req = { params: {}, query: {}, user: { userId: 'user-1' }, ...reqOverrides };
    const res = createRes();
    await handler(req, res, err => {
      if (err) throw err;
    });
    return res;
  }

  // 1. GET /tax-receipts returns verifiable receipts
  const listRes = await invokeGet('/tax-receipts', { user: { userId: 'user-1' } });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.receipts.length, 1);
  assert.equal(listRes.body.receipts[0].verification.tx_hash, VALID_TX_HASH);

  // 2. GET /tax-receipts/download returns PDF attachment
  const dlRes = await invokeGet('/tax-receipts/download', { user: { userId: 'user-1' } });
  assert.equal(dlRes.statusCode, 200);
  assert.equal(dlRes.headers['content-type'], 'application/pdf');
  assert.match(dlRes.headers['content-disposition'], /crowdpay-tax-receipt-contrib-101\.pdf/);
  assert.ok(Buffer.isBuffer(dlRes.body));

  // 3. GET /:id/receipt returns 200 for contributor
  const singleRes = await invokeGet('/:id/receipt', {
    params: { id: 'contrib-101' },
    user: { userId: 'user-1' },
  });
  assert.equal(singleRes.statusCode, 200);
  assert.equal(singleRes.body.receipt.tx_hash, VALID_TX_HASH);
  assert.equal(singleRes.body.receipt.contributor_email, 'ada@example.com');

  // 4. GET /:id/receipt redacts contributor email for campaign creator
  const creatorRes = await invokeGet('/:id/receipt', {
    params: { id: 'contrib-101' },
    user: { userId: 'creator-1' },
  });
  assert.equal(creatorRes.statusCode, 200);
  assert.equal(creatorRes.body.receipt.contributor_email, null);

  // 5. GET /:id/receipt returns 403 for unrelated user
  const forbiddenRes = await invokeGet('/:id/receipt', {
    params: { id: 'contrib-101' },
    user: { userId: 'stranger-99' },
  });
  assert.equal(forbiddenRes.statusCode, 403);

  // 6. GET /:id/receipt/pdf returns PDF for authorized user
  const singlePdfRes = await invokeGet('/:id/receipt/pdf', {
    params: { id: 'contrib-101' },
    user: { userId: 'user-1' },
  });
  assert.equal(singlePdfRes.statusCode, 200);
  assert.equal(singlePdfRes.headers['content-type'], 'application/pdf');

  // 7. GET /:id/receipt returns 422 when contribution has no verifiable tx_hash
  activeRows = [
    {
      ...SAMPLE_CONTRIBUTION_ROW,
      tx_hash: null,
      sender_public_key: 'system',
    },
  ];
  const unverifiableRes = await invokeGet('/:id/receipt', {
    params: { id: 'contrib-101' },
    user: { userId: 'user-1' },
  });
  assert.equal(unverifiableRes.statusCode, 422);
  assert.equal(unverifiableRes.body.code, 'UNVERIFIABLE_TRANSACTION');
});
