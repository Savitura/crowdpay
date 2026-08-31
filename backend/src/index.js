const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const requestContext = require('./config/requestContext');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const compression = require('./middleware/compression');

const authRoutes = require('./routes/auth');
const campaignRoutes = require('./routes/campaigns');
const contributionRoutes = require('./routes/contributions');
const embedRoutes = require('./routes/embed');
const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health.test') || express.Router();

const app = express();

app.use(requestContext);
app.use(requestLogger);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(compression);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contributions', contributionRoutes);
app.use('/api/embed', embedRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

app.use('/api/v1', require('routes/v1'));
app.use('/api', require('routes/admin'));
app.use('/api/anchor', require('routes/anchor'));
app.use('/api/announcements', require('routes/announcement'));
app.use('/api/auth', require('routes/auth'));
app.use('/api/campaigns', require('routes/campaignComments'));
app.use('/api/campaigns', require('routes/campaignFollowers'));
app.use('/api/campaigns', require('routes/campaignUpdates'));
app.use('/api/campaigns', require('routes/campaigns'));
app.use('/api/campaign-pools', require('routes/contributionPools'));
app.use('/api/contributions', require('routes/contributions'));
app.use('/api/contributor-identity', require('routes/contributorIdentity'));
app.use('/api/creator', require('routes/creatorAnalytics'));
app.use('/api/disputes', require('routes/disputes'));
app.use('/api/emails', require('routes/emails'));
app.use('/api/embed', require('routes/embed'));
app.use('/api/governance', require('routes/governance'));
app.use('/api/impact-reports', require('routes/impactReports'));
app.use('/api/invites', require('routes/invites'));
app.use('/api/kyc-webhook', require('routes/kycWebhook'));
app.use('/api/milestones', require('routes/milestones'));
app.use('/api/nft-rewards', require('routes/nftRewards'));
app.use('/api/notifications', require('routes/notifications'));
app.use('/api/ops', require('routes/ops'));
app.use('/api/referrals', require('routes/referrals'));
app.use('/api/sessions', require('routes/sessions'));
app.use('/api/sponsor-matching', require('routes/sponsorMatching'));
app.use('/api/stellar-transactions', require('routes/stellarTransactions'));
app.use('/api/subscriptions', require('routes/subscriptions'));
app.use('/api/thank-you', require('routes/thankYou'));
app.use('/api/translations', require('routes/translations'));
app.use('/api/treasury', require('routes/treasury'));
app.use('/api/users', require('routes/users'));
app.use('/api/wallets', require('routes/wallets'));
app.use('/api/webhooks', require('routes/webhooks'));
app.use('/api/withdrawals', require('routes/withdrawals'));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

module.exports = app;