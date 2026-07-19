const db = require('../config/database');
const logger = require('../config/logger');
const { sendAlert } = require('./alerting');
const Sentry = require('@sentry/node');

// Default tunable weights and thresholds
const getTunable = (envVar, defaultValue) => {
  const val = process.env[envVar];
  if (val === undefined) return defaultValue;
  return typeof defaultValue === 'number' ? Number(val) : val;
};

async function evaluateCampaign(campaignId, dbClient = db) {
  // Config parameters loaded dynamically for tunability
  const FRAUD_WEIGHT_SAME_IP = getTunable('FRAUD_WEIGHT_SAME_IP', 20);
  const FRAUD_THRESHOLD_SAME_IP = getTunable('FRAUD_THRESHOLD_SAME_IP', 3);
  const FRAUD_WINDOW_SAME_IP_MS = getTunable('FRAUD_WINDOW_SAME_IP_MS', 24 * 60 * 60 * 1000); // 24h

  const FRAUD_WEIGHT_WALLET_AGE = getTunable('FRAUD_WEIGHT_WALLET_AGE', 30);
  const FRAUD_THRESHOLD_WALLET_AGE_MS = getTunable('FRAUD_THRESHOLD_WALLET_AGE_MS', 60 * 60 * 1000); // 1h

  const FRAUD_WEIGHT_VELOCITY = getTunable('FRAUD_WEIGHT_VELOCITY', 40);
  const FRAUD_VELOCITY_MULTIPLIER = getTunable('FRAUD_VELOCITY_MULTIPLIER', 3);
  const FRAUD_VELOCITY_WINDOW_MS = getTunable('FRAUD_VELOCITY_WINDOW_MS', 60 * 60 * 1000); // 1h
  const FRAUD_VELOCITY_MIN_AMOUNT = getTunable('FRAUD_VELOCITY_MIN_AMOUNT', 10);

  const FRAUD_WEIGHT_SINGLE_WALLET = getTunable('FRAUD_WEIGHT_SINGLE_WALLET', 35);
  const FRAUD_THRESHOLD_SINGLE_WALLET_PCT = getTunable('FRAUD_THRESHOLD_SINGLE_WALLET_PCT', 0.50); // 50%

  const FRAUD_THRESHOLD = getTunable('FRAUD_THRESHOLD', 50);
  const FRAUD_AUTO_PAUSE_THRESHOLD = getTunable('FRAUD_AUTO_PAUSE_THRESHOLD', 80);
  const FRAUD_AUTO_PAUSE_ENABLED = getTunable('FRAUD_AUTO_PAUSE_ENABLED', 'true') === 'true';

  try {
    // 1. Load campaign details
    const { rows: campaigns } = await dbClient.query(
      'SELECT id, title, target_amount, raised_amount, created_at, status, is_flagged_fraud FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaigns.length) {
      logger.warn('Fraud assessment failed: campaign not found', { campaignId });
      return null;
    }
    const campaign = campaigns[0];

    let sameIpScore = 0;
    let sameIpDetails = 'No suspicious IP patterns detected.';
    let walletAgeScore = 0;
    let walletAgeDetails = 'No young wallets detected.';
    let velocityScore = 0;
    let velocityDetails = 'Velocity within normal bounds or insufficient history.';
    let singleWalletScore = 0;
    let singleWalletDetails = 'No single wallet exceeds the limit.';

    // Signal 1: Multiple contributions from the same IP
    const { rows: sameIpRows } = await dbClient.query(
      `SELECT ip_address, COUNT(*)::int AS count
       FROM contributions
       WHERE campaign_id = $1 AND ip_address IS NOT NULL AND created_at >= NOW() - CAST($2 || ' milliseconds' AS INTERVAL)
       GROUP BY ip_address
       HAVING COUNT(*) > $3`,
      [campaignId, FRAUD_WINDOW_SAME_IP_MS, FRAUD_THRESHOLD_SAME_IP]
    );
    if (sameIpRows.length > 0) {
      let totalOver = 0;
      const detailsArray = [];
      for (const row of sameIpRows) {
        const overLimit = row.count - FRAUD_THRESHOLD_SAME_IP;
        totalOver += overLimit;
        detailsArray.push(`IP ${row.ip_address} sent ${row.count} contributions`);
      }
      sameIpScore = totalOver * FRAUD_WEIGHT_SAME_IP;
      sameIpDetails = detailsArray.join(', ');
    }

    // Signal 2: Wallets created < 1 hour ago
    const { rows: youngWalletRows } = await dbClient.query(
      `SELECT COUNT(*)::int AS count
       FROM contributions c
       JOIN users u ON u.wallet_public_key = c.sender_public_key
       WHERE c.campaign_id = $1 AND c.created_at - u.created_at < CAST($2 || ' milliseconds' AS INTERVAL)`,
      [campaignId, FRAUD_THRESHOLD_WALLET_AGE_MS]
    );
    const youngWalletCount = youngWalletRows[0]?.count || 0;
    if (youngWalletCount > 0) {
      walletAgeScore = youngWalletCount * FRAUD_WEIGHT_WALLET_AGE;
      walletAgeDetails = `${youngWalletCount} contributions from wallets created less than 1 hour ago.`;
    }

    // Signal 3: Funding velocity
    const { rows: windowVelocityRows } = await dbClient.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS window_amount
       FROM contributions
       WHERE campaign_id = $1 AND refunded = FALSE AND created_at >= NOW() - CAST($2 || ' milliseconds' AS INTERVAL)`,
      [campaignId, FRAUD_VELOCITY_WINDOW_MS]
    );
    const windowAmount = parseFloat(windowVelocityRows[0]?.window_amount || 0);

    const campaignAgeMs = Date.now() - new Date(campaign.created_at).getTime();
    const campaignAgeHours = campaignAgeMs / (60 * 60 * 1000);
    const windowHours = FRAUD_VELOCITY_WINDOW_MS / (60 * 60 * 1000);

    if (campaignAgeHours >= 2 * windowHours) {
      const historicalRaised = parseFloat(campaign.raised_amount) - windowAmount;
      const historicalHours = campaignAgeHours - windowHours;
      const historicalAvgVelocity = historicalHours > 0 ? historicalRaised / historicalHours : 0;
      const currentVelocity = windowAmount / windowHours;

      if (historicalAvgVelocity > 0 && windowAmount >= FRAUD_VELOCITY_MIN_AMOUNT) {
        const ratio = currentVelocity / historicalAvgVelocity;
        if (ratio > FRAUD_VELOCITY_MULTIPLIER) {
          velocityScore = FRAUD_WEIGHT_VELOCITY;
          velocityDetails = `Current velocity (${currentVelocity.toFixed(2)}/hr) is ${ratio.toFixed(1)}x historical average (${historicalAvgVelocity.toFixed(2)}/hr).`;
        }
      }
    }

    // Signal 4: Single wallet contributing > 50% of campaign total (target_amount)
    const { rows: singleWalletRows } = await dbClient.query(
      `SELECT sender_public_key, SUM(amount)::numeric AS total_amount
       FROM contributions
       WHERE campaign_id = $1 AND refunded = FALSE
       GROUP BY sender_public_key`,
      [campaignId]
    );
    const targetAmount = parseFloat(campaign.target_amount);
    if (targetAmount > 0) {
      for (const row of singleWalletRows) {
        const amount = parseFloat(row.total_amount);
        const pct = amount / targetAmount;
        if (pct > FRAUD_THRESHOLD_SINGLE_WALLET_PCT) {
          singleWalletScore = FRAUD_WEIGHT_SINGLE_WALLET;
          singleWalletDetails = `Wallet ${row.sender_public_key.slice(0, 8)}... contributed ${Math.round(pct * 100)}% of target.`;
          break;
        }
      }
    }

    const totalScore = sameIpScore + walletAgeScore + velocityScore + singleWalletScore;
    const signals = {
      same_ip: { score: sameIpScore, detail: sameIpDetails },
      wallet_age: { score: walletAgeScore, detail: walletAgeDetails },
      velocity: { score: velocityScore, detail: velocityDetails },
      single_wallet: { score: singleWalletScore, detail: singleWalletDetails },
    };

    const isHighRisk = totalScore >= FRAUD_THRESHOLD;
    const shouldPause = FRAUD_AUTO_PAUSE_ENABLED && totalScore >= FRAUD_AUTO_PAUSE_THRESHOLD;

    // Update database
    let nextStatus = campaign.status;
    if (shouldPause && campaign.status === 'active') {
      nextStatus = 'suspended';
    }

    await dbClient.query(
      `UPDATE campaigns
       SET is_flagged_fraud = $1,
           fraud_score = $2,
           fraud_signals = $3::jsonb,
           status = $4
       WHERE id = $5`,
      [isHighRisk, totalScore, JSON.stringify(signals), nextStatus, campaignId]
    );

    // Trigger alerts if newly flagged or paused
    const wasAlreadyFlagged = campaign.is_flagged_fraud;
    if (isHighRisk && !wasAlreadyFlagged) {
      logger.warn('Campaign flagged for fraud', { campaignId, title: campaign.title, totalScore, signals });

      // Alerting webhook / Sentry alert
      await sendAlert(`Campaign flagged for fraud: "${campaign.title}" with score ${totalScore}`, {
        campaign_id: campaignId,
        score: totalScore,
        breakdown: signals,
        auto_suspended: shouldPause && campaign.status === 'active',
      });

      // Email Admins
      try {
        const { rows: admins } = await dbClient.query(
          "SELECT email, name FROM users WHERE role = 'admin' OR is_admin = TRUE"
        );
        const { sendCampaignFraudFlaggedEmail } = require('./emailService');
        for (const admin of admins) {
          if (admin.email) {
            await sendCampaignFraudFlaggedEmail({
              to: admin.email,
              adminName: admin.name,
              campaignTitle: campaign.title,
              campaignId,
              score: totalScore,
              breakdown: signals,
              autoSuspended: shouldPause && campaign.status === 'active',
            });
          }
        }
      } catch (err) {
        logger.error('Failed to notify admins of fraud flag', { campaignId, error: err.message });
      }
    }

    return {
      campaign_id: campaignId,
      score: totalScore,
      is_flagged_fraud: isHighRisk,
      auto_suspended: shouldPause && campaign.status === 'active',
      signals,
    };
  } catch (err) {
    logger.error('Error during campaign fraud evaluation', { campaignId, error: err.message });
    Sentry.captureException(err);
    throw err;
  }
}

module.exports = {
  evaluateCampaign,
};
