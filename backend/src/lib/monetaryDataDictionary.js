'use strict';

/**
 * monetaryDataDictionary.js
 *
 * Authoritative data dictionary and specification for monetary, currency, and
 * Stellar amount columns across CrowdPay database tables and integrations.
 *
 * Stellar assets carry 7 decimal places; 1 unit = 10^7 stroops. Monetary amounts
 * in CrowdPay are represented in PostgreSQL as NUMERIC(20, 7) (or NUMERIC(18, 7)),
 * with exact decimal-to-stroop conversion (see backend/src/utils/stroops.js).
 */

const { toStroops, isValidAmount, fromStroops } = require('../utils/stroops');

/**
 * Monetary column definition catalog.
 * Keyed by `${tableName}.${columnName}` in lowercase.
 */
const MONETARY_COLUMNS = {
  // Campaigns
  'campaigns.target_amount': {
    tableName: 'campaigns',
    columnName: 'target_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Values with >7 decimal places are rejected.',
    description: 'Target funding goal for the campaign in units of asset_type.',
  },
  'campaigns.raised_amount': {
    tableName: 'campaigns',
    columnName: 'raised_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Incremented atomically on confirmed contributions.',
    description: 'Total confirmed funds raised towards the campaign target.',
  },
  'campaigns.min_contribution': {
    tableName: 'campaigns',
    columnName: 'min_contribution',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Minimum per-contribution threshold when configured.',
    description: 'Optional minimum contribution amount allowed for the campaign.',
  },
  'campaigns.max_contribution': {
    tableName: 'campaigns',
    columnName: 'max_contribution',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Maximum single contribution cap when configured.',
    description: 'Optional maximum contribution limit per transaction.',
  },
  'campaigns.max_per_user': {
    tableName: 'campaigns',
    columnName: 'max_per_user',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Cumulative cap across contributions from one user.',
    description: 'Optional maximum cumulative contribution amount allowed per user.',
  },
  'campaigns.velocity_alert_threshold': {
    tableName: 'campaigns',
    columnName: 'velocity_alert_threshold',
    dataType: 'NUMERIC(18, 7)',
    precision: 18,
    scale: 7,
    unit: 'Stellar asset units (XLM or USDC)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: true,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Hourly/daily contribution velocity alert limit.',
    description: 'Volume threshold triggering velocity alerts for abnormal inflow.',
  },
  'campaigns.platform_fee_bps': {
    tableName: 'campaigns',
    columnName: 'platform_fee_bps',
    dataType: 'INTEGER',
    precision: null,
    scale: 0,
    unit: 'Basis points (1 bps = 0.01% = 0.0001)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: 0, max: 10000 },
    roundingRule: 'Integer basis points. Converted to ratio via bps / 10,000.',
    description: 'Campaign platform fee rate in basis points.',
  },

  // Contributions
  'contributions.amount': {
    tableName: 'contributions',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Received amount credited to the campaign wallet.',
    description: 'Net contribution amount received in the campaign target asset.',
  },
  'contributions.source_amount': {
    tableName: 'contributions',
    columnName: 'source_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (source_asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'source_asset',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Spent from sender wallet before path payment swap.',
    description: 'Source amount sent by contributor before path payment conversion.',
  },
  'contributions.anchor_amount': {
    tableName: 'contributions',
    columnName: 'anchor_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Fiat / Anchor asset units (anchor_asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'anchor_asset',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops (or 7-decimal anchor standard).',
    description: 'Fiat on-ramp deposit amount prior to anchor execution.',
  },
  'contributions.send_max': {
    tableName: 'contributions',
    columnName: 'send_max',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (source_asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'source_asset',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops. Path payment strict receive max expenditure.',
    description: 'Maximum source amount allowed for path payment execution.',
  },
  'contributions.platform_fee_amount': {
    tableName: 'contributions',
    columnName: 'platform_fee_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Split fee rounds half-up in stroops.',
    description: 'Platform fee deducted from the contribution amount.',
  },
  'contributions.refunded_amount': {
    tableName: 'contributions',
    columnName: 'refunded_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: true,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Incremented upon partial or full refunds.',
    description: 'Cumulative amount refunded back to the original contributor.',
  },
  'contributions.refund_reserved_amount': {
    tableName: 'contributions',
    columnName: 'refund_reserved_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: true,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Reserved escrow balance during dispute hold.',
    description: 'Portion of contribution locked against pending refund or dispute.',
  },
  'contributions.match_amount': {
    tableName: 'contributions',
    columnName: 'match_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: true,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Calculated from pledge match_ratio.',
    description: 'Sponsor match amount credited alongside the backer contribution.',
  },
  'contributions.pool_share_amount': {
    tableName: 'contributions',
    columnName: 'pool_share_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Individual contributor share when contributing via a pool.',
  },
  'contributions.conversion_rate': {
    tableName: 'contributions',
    columnName: 'conversion_rate',
    dataType: 'NUMERIC(30, 15)',
    precision: 30,
    scale: 15,
    unit: 'Ratio multiplier (destination / source)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0.000000000000001', minExclusive: true },
    roundingRule: 'Decimal with up to 15 decimal places for exchange rate precision.',
    description: 'Path payment conversion exchange rate quoted by Horizon/SDEX.',
  },
  'contributions.effective_rate': {
    tableName: 'contributions',
    columnName: 'effective_rate',
    dataType: 'NUMERIC(30, 15)',
    precision: 30,
    scale: 15,
    unit: 'Ratio multiplier (destination / source)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0.000000000000001', minExclusive: true },
    roundingRule: 'Decimal with up to 15 decimal places.',
    description: 'Actual executed exchange rate realized on-chain after slippage.',
  },
  'contributions.slippage_bps': {
    tableName: 'contributions',
    columnName: 'slippage_bps',
    dataType: 'INTEGER',
    precision: null,
    scale: 0,
    unit: 'Basis points (1 bps = 0.01%)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: 0, max: 10000 },
    roundingRule: 'Integer basis points.',
    description: 'Slippage tolerance in basis points for path payment.',
  },

  // Withdrawals & Milestones
  'withdrawal_requests.amount': {
    tableName: 'withdrawal_requests',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops. Requires creator and platform multisig co-signature.',
    description: 'Requested disbursement amount from campaign wallet.',
  },
  'milestones.release_percentage': {
    tableName: 'milestones',
    columnName: 'release_percentage',
    dataType: 'NUMERIC(7, 4)',
    precision: 7,
    scale: 4,
    unit: 'Percentage (0.0001% - 100.0000%)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0001', max: '100.0000' },
    roundingRule: 'Exact decimal percentage up to 4 decimal places.',
    description: 'Percentage of campaign raised balance unlocked upon approval.',
  },
  'milestone_auto_release_attempts.amount': {
    tableName: 'milestone_auto_release_attempts',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Disbursement amount attempted in auto-release workflow.',
  },

  // Subscriptions & Recurring Contributions
  'subscriptions.amount_per_period': {
    tableName: 'subscriptions',
    columnName: 'amount_per_period',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Recurring installment amount committed per billing period.',
  },
  'subscription_balances.amount': {
    tableName: 'subscription_balances',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops. Mirrors on-chain Claimable Balance amount.',
    description: 'Scheduled on-chain Stellar Claimable Balance amount.',
  },
  'recurring_contributions.amount': {
    tableName: 'recurring_contributions',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Legacy recurring pledge installment amount.',
  },
  'recurring_payout_schedules.amount': {
    tableName: 'recurring_payout_schedules',
    columnName: 'amount',
    dataType: 'NUMERIC(18, 7)',
    precision: 18,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Fixed installment amount for recurring creator payout schedule.',
  },
  'recurring_payout_schedules.percentage': {
    tableName: 'recurring_payout_schedules',
    columnName: 'percentage',
    dataType: 'NUMERIC(5, 2)',
    precision: 5,
    scale: 2,
    unit: 'Percentage (0.01% - 100.00%)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0.01', max: '100.00' },
    roundingRule: 'Percentage up to 2 decimal places.',
    description: 'Percentage of campaign balance to disburse per schedule.',
  },
  'recurring_payout_runs.amount': {
    tableName: 'recurring_payout_runs',
    columnName: 'amount',
    dataType: 'NUMERIC(18, 7)',
    precision: 18,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: true,
    defaultValue: null,
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Executed disbursement amount in automated recurring payout run.',
  },

  // Pools
  'contribution_pools.target_amount': {
    tableName: 'contribution_pools',
    columnName: 'target_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Total group funding target for the pooled contribution.',
  },
  'contribution_pools.raised_amount': {
    tableName: 'contribution_pools',
    columnName: 'raised_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Sum of confirmed member pledged shares.',
    description: 'Total committed funds across all pool members.',
  },
  'pool_members.share_amount': {
    tableName: 'pool_members',
    columnName: 'share_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Individual member pledged share amount in the pool.',
  },

  // Reward Tiers & Embeds
  'reward_tiers.min_amount': {
    tableName: 'reward_tiers',
    columnName: 'min_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Minimum contribution amount required to qualify for reward tier.',
  },
  'embed_contributions.amount': {
    tableName: 'embed_contributions',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Contribution amount received via public embed widget.',
  },
  'contribution_gift_notifications.amount': {
    tableName: 'contribution_gift_notifications',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Contribution amount dedicated as a gift notification.',
  },

  // Sponsor Matching & Referrals
  'campaign_matches.pledge_amount': {
    tableName: 'campaign_matches',
    columnName: 'pledge_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Sponsor maximum matching pool commitment amount.',
  },
  'campaign_matches.matched_amount': {
    tableName: 'campaign_matches',
    columnName: 'matched_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops. Incremented as matches are executed.',
    description: 'Cumulative sponsor funds drawn down and matched to contributors.',
  },
  'campaign_matches.match_ratio': {
    tableName: 'campaign_matches',
    columnName: 'match_ratio',
    dataType: 'NUMERIC(10, 2)',
    precision: 10,
    scale: 2,
    unit: 'Multiplier ratio (e.g., 1.00 for 1:1, 0.50 for 1:2, 2.00 for 2:1)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.01', minExclusive: true },
    roundingRule: 'Decimal multiplier up to 2 decimal places.',
    description: 'Matching multiplier ratio applied to eligible contributions.',
  },
  'referral_rewards.amount': {
    tableName: 'referral_rewards',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units (asset_type column)',
    stroopAligned: true,
    pairedAssetColumn: 'asset_type',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Referral commission reward amount awarded to referrer.',
  },
  'referral_links.commission_paid': {
    tableName: 'referral_links',
    columnName: 'commission_paid',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Cumulative commission paid out for contributions via this link.',
  },
  'referral_programs.commission_percentage': {
    tableName: 'referral_programs',
    columnName: 'commission_percentage',
    dataType: 'NUMERIC(5, 2)',
    precision: 5,
    scale: 2,
    unit: 'Percentage (1.00% - 20.00%)',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '1.00', max: '20.00' },
    roundingRule: 'Decimal percentage between 1 and 20 with up to 2 decimal places.',
    description: 'Campaign referral program commission percentage.',
  },

  // Refunds
  'refund_requests.amount': {
    tableName: 'refund_requests',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Refund amount requested by contributor.',
  },
  'refund_events.total_refunded': {
    tableName: 'refund_events',
    columnName: 'total_refunded',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Total amount refunded in a refund execution event.',
  },
  'creator_refunds.amount': {
    tableName: 'creator_refunds',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Amount refunded in a creator-initiated batch refund.',
  },

  // Anchor On/Off Ramp (SEP-24)
  'anchor_deposits.anchor_amount': {
    tableName: 'anchor_deposits',
    columnName: 'anchor_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Anchor asset units (anchor_asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'anchor_asset',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops or 7-decimal anchor standard.',
    description: 'Gross deposit amount initiated through the anchor.',
  },
  'anchor_deposits.contribution_amount': {
    tableName: 'anchor_deposits',
    columnName: 'contribution_amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Campaign asset units (campaign_asset column)',
    stroopAligned: true,
    pairedAssetColumn: 'campaign_asset',
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops credited to campaign escrow.',
    description: 'Net contribution amount credited after anchor conversion/fee.',
  },

  // Governance, Treasury & Ops
  'wallet_funding_approvals.deficit_xlm': {
    tableName: 'wallet_funding_approvals',
    columnName: 'deficit_xlm',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'XLM units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'XLM deficit needing approval for base reserve funding.',
  },
  'treasury_policies.require_auditor_for_above': {
    tableName: 'treasury_policies',
    columnName: 'require_auditor_for_above',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: '0',
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops.',
    description: 'Amount threshold above which secondary auditor sign-off is required.',
  },
  'quarantined_payments.amount': {
    tableName: 'quarantined_payments',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Payment amount quarantined pending compliance or sanctions review.',
  },
  'governance_votes_log.token_balance_at_vote': {
    tableName: 'governance_votes_log',
    columnName: 'token_balance_at_vote',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Governance token units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0', minExclusive: false },
    roundingRule: 'Exact stroops (7-decimal token standard).',
    description: 'Governance token snapshot balance determining voting weight.',
  },
  'governance_proposals_meta.proposed_fee_bps': {
    tableName: 'governance_proposals_meta',
    columnName: 'proposed_fee_bps',
    dataType: 'INTEGER',
    precision: null,
    scale: 0,
    unit: 'Basis points',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: 0, max: 10000 },
    roundingRule: 'Integer basis points.',
    description: 'Proposed platform fee rate in basis points.',
  },
  'governance_proposals_meta.proposed_creator_share_bps': {
    tableName: 'governance_proposals_meta',
    columnName: 'proposed_creator_share_bps',
    dataType: 'INTEGER',
    precision: null,
    scale: 0,
    unit: 'Basis points',
    stroopAligned: false,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: 0, max: 10000 },
    roundingRule: 'Integer basis points.',
    description: 'Proposed creator share in basis points.',
  },
  'campaign_stretch_goals.amount': {
    tableName: 'campaign_stretch_goals',
    columnName: 'amount',
    dataType: 'NUMERIC(20, 7)',
    precision: 20,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Funding milestone target for secondary campaign stretch goal.',
  },
  'campaign_budget_categories.amount': {
    tableName: 'campaign_budget_categories',
    columnName: 'amount',
    dataType: 'NUMERIC',
    precision: null,
    scale: null,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Allocated budget amount for campaign expense line item.',
  },
  'campaign_revisions.target_amount': {
    tableName: 'campaign_revisions',
    columnName: 'target_amount',
    dataType: 'DECIMAL(18, 7)',
    precision: 18,
    scale: 7,
    unit: 'Stellar asset units',
    stroopAligned: true,
    pairedAssetColumn: null,
    isNullable: false,
    defaultValue: null,
    bounds: { min: '0.0000001', minExclusive: true },
    roundingRule: 'Exact stroops.',
    description: 'Historical revision snapshot of campaign target funding goal.',
  },
};

/**
 * Format key from tableName and columnName.
 */
function toKey(tableName, columnName) {
  return `${String(tableName).toLowerCase().trim()}.${String(columnName).toLowerCase().trim()}`;
}

/**
 * Retrieve monetary column definition.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @returns {object|null}
 */
function getMonetaryColumn(tableName, columnName) {
  const key = toKey(tableName, columnName);
  return MONETARY_COLUMNS[key] || null;
}

/**
 * Check if a table column is in the monetary data dictionary.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @returns {boolean}
 */
function hasMonetaryColumn(tableName, columnName) {
  return Boolean(getMonetaryColumn(tableName, columnName));
}

/**
 * List all monetary columns in the data dictionary.
 *
 * @param {{ stroopOnly?: boolean, tableName?: string }} [options]
 * @returns {object[]}
 */
function listMonetaryColumns({ stroopOnly = false, tableName = null } = {}) {
  let list = Object.values(MONETARY_COLUMNS);
  if (stroopOnly) {
    list = list.filter(col => col.stroopAligned);
  }
  if (tableName) {
    const t = String(tableName).toLowerCase().trim();
    list = list.filter(col => col.tableName === t);
  }
  return list;
}

/**
 * List all unique database table names containing monetary columns.
 *
 * @returns {string[]}
 */
function listMonetaryTables() {
  const tables = new Set(Object.values(MONETARY_COLUMNS).map(c => c.tableName));
  return Array.from(tables).sort();
}

/**
 * Validate an input value against the monetary column's precision, scale, and bounds.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @param {string|number|bigint} value
 * @returns {{ valid: boolean, error?: string, stroops?: bigint }}
 */
function validateMonetaryValue(tableName, columnName, value) {
  const def = getMonetaryColumn(tableName, columnName);
  if (!def) {
    return { valid: false, error: `Column ${tableName}.${columnName} is not a registered monetary column` };
  }

  // Null check
  if (value === null || value === undefined) {
    if (def.isNullable) {
      return { valid: true };
    }
    return { valid: false, error: `${tableName}.${columnName} cannot be null` };
  }

  // For stroop-aligned columns: use exact stroop validation
  if (def.stroopAligned) {
    const allowZero = def.bounds && def.bounds.min === '0';
    try {
      const stroops = toStroops(value, { allowZero, allowNegative: false });
      if (def.bounds) {
        if (def.bounds.min && !def.bounds.minExclusive) {
          const minStroops = toStroops(def.bounds.min, { allowZero: true });
          if (stroops < minStroops) {
            return { valid: false, error: `Value must be >= ${def.bounds.min}` };
          }
        } else if (def.bounds.min && def.bounds.minExclusive) {
          const minStroops = toStroops(def.bounds.min, { allowZero: true });
          if (stroops <= minStroops) {
            return { valid: false, error: `Value must be > ${def.bounds.min}` };
          }
        }
      }
      return { valid: true, stroops };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  // For integer basis points (bps)
  if (def.dataType === 'INTEGER') {
    const num = Number(value);
    if (!Number.isInteger(num)) {
      return { valid: false, error: `${tableName}.${columnName} must be an integer` };
    }
    if (def.bounds) {
      if (def.bounds.min !== undefined && num < def.bounds.min) {
        return { valid: false, error: `Value must be >= ${def.bounds.min}` };
      }
      if (def.bounds.max !== undefined && num > def.bounds.max) {
        return { valid: false, error: `Value must be <= ${def.bounds.max}` };
      }
    }
    return { valid: true };
  }

  // For arbitrary decimal percentages / conversion rates (e.g. NUMERIC(7,4), NUMERIC(30,15))
  const str = String(value).trim();
  const num = Number(str);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return { valid: false, error: `${tableName}.${columnName} must be a valid number` };
  }

  if (def.scale !== null && def.scale !== undefined) {
    const parts = str.split('.');
    if (parts.length === 2 && parts[1].length > def.scale) {
      return { valid: false, error: `${tableName}.${columnName} exceeds maximum scale of ${def.scale} decimal places` };
    }
  }

  if (def.bounds) {
    if (def.bounds.min !== undefined) {
      const minNum = Number(def.bounds.min);
      if (def.bounds.minExclusive ? num <= minNum : num < minNum) {
        return { valid: false, error: `Value must be ${def.bounds.minExclusive ? '>' : '>='} ${def.bounds.min}` };
      }
    }
    if (def.bounds.max !== undefined) {
      const maxNum = Number(def.bounds.max);
      if (num > maxNum) {
        return { valid: false, error: `Value must be <= ${def.bounds.max}` };
      }
    }
  }

  return { valid: true };
}

module.exports = {
  MONETARY_COLUMNS,
  getMonetaryColumn,
  hasMonetaryColumn,
  listMonetaryColumns,
  listMonetaryTables,
  validateMonetaryValue,
};
