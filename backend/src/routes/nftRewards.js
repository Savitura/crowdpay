const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  getUserNftRewards,
  getCampaignNftRewards,
  listNftRewardsForContribution,
  ensureNftRewardRecord,
  markNftRewardMinted,
  markNftRewardFailed,
} = require('../services/nftRewardService');

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const rewards = await getUserNftRewards(req.user.userId);
  res.json({ rewards });
}));

router.get('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const rewards = await getCampaignNftRewards(req.params.campaignId);
  res.json({ rewards });
}));

router.get('/contributions/:contributionId', requireAuth, asyncHandler(async (req, res) => {
  const { rows: contributionRows } = await db.query(
    `SELECT id FROM contributions WHERE id = $1`,
    [req.params.contributionId],
  );
  if (!contributionRows.length) return res.status(404).json({ error: 'Contribution not found' });
  const rewards = await listNftRewardsForContribution(req.params.contributionId);
  res.json({ rewards });
}));

router.post('/claim', requireAuth, asyncHandler(async (req, res) => {
  const { campaign_id, reward_tier_id, contribution_id } = req.body;

  if (!campaign_id || !reward_tier_id || !contribution_id) {
    return res.status(400).json({ error: 'campaign_id, reward_tier_id, and contribution_id are required' });
  }

  const { rows: contribRows } = await db.query(
    `SELECT id, campaign_id FROM contributions WHERE id = $1`,
    [contribution_id]
  );
  if (!contribRows.length) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const { rows: existingRows } = await db.query(
    `SELECT id, status, token_id, tx_hash, serial_number FROM nft_rewards WHERE reward_tier_id = $1 AND contribution_id = $2`,
    [reward_tier_id, contribution_id]
  );

  if (existingRows.length > 0) {
    const reward = existingRows[0];
    if (reward.status === 'minted') {
      return res.status(400).json({ error: 'NFT reward already claimed and minted', reward });
    }
    if (reward.status === 'minting') {
      return res.status(409).json({ error: 'NFT minting is already in progress', reward });
    }
    if (reward.status === 'failed') {
      const pendingRecord = await ensureNftRewardRecord({
        campaignId: campaign_id,
        rewardTierId: reward_tier_id,
        contributionId: contribution_id,
      });

      try {
        const mockTokenId = 'tok_' + Date.now();
        const mockTxHash = 'hash_' + Date.now();
        const mockSerialNumber = Math.floor(Math.random() * 1000) + 1;

        await markNftRewardMinted({
          rewardTierId: reward_tier_id,
          contributionId: contribution_id,
          tokenId: mockTokenId,
          txHash: mockTxHash,
          serialNumber: mockSerialNumber,
        });

        return res.json({
          success: true,
          status: 'minted',
          token_id: mockTokenId,
          tx_hash: mockTxHash,
          serial_number: mockSerialNumber,
        });
      } catch (err) {
        await markNftRewardFailed({
          rewardTierId: reward_tier_id,
          contributionId: contribution_id,
          errorMessage: err.message,
        });
        return res.status(500).json({ error: 'Retry mint failed', details: err.message });
      }
    }
  }

  const record = await ensureNftRewardRecord({
    campaignId: campaign_id,
    rewardTierId: reward_tier_id,
    contributionId: contribution_id,
  });

  if (!record) {
    const { rows: conflictRows } = await db.query(
      `SELECT id, status FROM nft_rewards WHERE reward_tier_id = $1 AND contribution_id = $2`,
      [reward_tier_id, contribution_id]
    );
    return res.status(409).json({ error: 'NFT reward claim already initiated', reward: conflictRows[0] });
  }

  try {
    const mockTokenId = 'tok_' + Date.now();
    const mockTxHash = 'hash_' + Date.now();
    const mockSerialNumber = Math.floor(Math.random() * 1000) + 1;

    await markNftRewardMinted({
      rewardTierId: reward_tier_id,
      contributionId: contribution_id,
      tokenId: mockTokenId,
      txHash: mockTxHash,
      serialNumber: mockSerialNumber,
    });

    res.status(201).json({
      success: true,
      status: 'minted',
      token_id: mockTokenId,
      tx_hash: mockTxHash,
      serial_number: mockSerialNumber,
    });
  } catch (err) {
    await markNftRewardFailed({
      rewardTierId: reward_tier_id,
      contributionId: contribution_id,
      errorMessage: err.message,
    });
    res.status(500).json({ error: 'Mint failed', details: err.message });
  }
}));

module.exports = router;
