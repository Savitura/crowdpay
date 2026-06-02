require('dotenv').config();
require('./config/env').validateEnv();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const logger = require('./config/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const { normalizeErrorResponse, errorHandler } = require('./middleware/errorHandler');
const { startLedgerMonitor, getLedgerStreamHealth } = require('./services/ledgerMonitor');
const { refreshActiveCampaignStatuses } = require('./services/campaignStatusService');
const { sendAlert } = require('./services/alerting');
const { assertNoLegacyPlaintextUserWalletSecrets } = require('./services/walletSecrets');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(normalizeErrorResponse);

const isTest = process.env.NODE_ENV === 'test';
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => {
    if (isTest) return true;
    const isPost = req.method === 'POST';
    const p = req.path || '';
    if (!isPost) return false;
    return (
      p === '/auth/register' ||
      p === '/users/register' ||
      p === '/auth/login' ||
      p === '/users/login' ||
      p === '/contributions'
    );
  },
});
app.use('/api', globalApiLimiter);

const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CrowdPay API',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
});
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

app.use('/api/auth', require('./routes/auth'));
// Backwards/alternate compatibility for docs + clients expecting /api/users/register|login.
app.use('/api/users', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use("/api/campaigns", require("./routes/campaignUpdates"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use('/api/anchor', require('./routes/anchor'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/api-keys', require('./routes/apiKeys'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api', require('./routes/disputes'));
app.use('/api/notifications', require('./routes/notifications'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('/api/config', (_, res) =>
  res.json({ platform_fee_bps: parseInt(process.env.PLATFORM_FEE_BPS || '0', 10) })
);

app.get('/health/ledger', async (_req, res) => {
  try {
    const body = await getLedgerStreamHealth();
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || 'ledger health failed' });
  }
});

if (process.env.SERVE_FRONTEND === 'true') {
  const dist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use(errorHandler);

const { startWebhookRetryPoller } = require('./services/webhookDispatcher');

const PORT = process.env.PORT || 3001;

function startCampaignStatusCron() {
  if (process.env.ENABLE_CAMPAIGN_STATUS_CRON === 'false') return;
  const cron = require('node-cron');
  cron.schedule('0 * * * *', () => {
    refreshActiveCampaignStatuses().catch((err) => {
      logger.error('Campaign status cron failed', { error: err.message });
    });
  });
  logger.info('Campaign status cron scheduled (hourly)');
}

function startReconciliationCron() {
  if (process.env.ENABLE_RECONCILIATION_CRON === 'false') return;
  const cron = require('node-cron');
  const { reconcileCampaignBalances } = require('./services/reconciliation');
  cron.schedule('*/15 * * * *', () => {
    reconcileCampaignBalances().catch((err) => {
      logger.error('Reconciliation cron failed', { error: err.message });
    });
  });
  logger.info('Reconciliation cron scheduled (every 15 minutes)');
}

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    await assertNoLegacyPlaintextUserWalletSecrets();
  }

  app.listen(PORT, () => {
    logger.info('CrowdPay backend running', { port: PORT, stellar_network: process.env.STELLAR_NETWORK });
    startLedgerMonitor();
    startWebhookRetryPoller();
    startCampaignStatusCron();
    startReconciliationCron();
  });
}

bootstrap().catch((err) => {
  logger.error('Backend bootstrap failed', { error: err.message });
  sendAlert('Backend bootstrap failed', { error: err.message });
  process.exit(1);
});
