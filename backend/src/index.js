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

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`CrowdPay server listening on port ${port}`);
  });
}

module.exports = app;