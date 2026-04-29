const { body, query, validationResult } = require('express-validator');
const { Keypair } = require('@stellar/stellar-sdk');
const { getSupportedAssetCodes } = require('../services/stellarService');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const VALID_CAMPAIGN_STATUSES = ['active', 'funded', 'closed', 'failed'];
const VALID_ORDER_BY = ['newest', 'ending_soon', 'most_funded', 'most_backed'];

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

const registerValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/)
    .withMessage('Password must include a lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must include an uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must include a number'),
  body('name')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Name is required'),
  body('role')
    .optional()
    .isIn(['contributor', 'creator'])
    .withMessage('Role must be contributor or creator'),
];

const loginValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  body('password').notEmpty().withMessage('Password is required'),
];

const createCampaignValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required'),
  body('description')
    .optional({ nullable: true })
    .customSanitizer(stripHtml),
  body('target_amount')
    .exists()
    .withMessage('Target amount is required')
    .isFloat({ gt: 0 })
    .withMessage('Target amount must be greater than zero'),
  body('asset_type')
    .notEmpty()
    .withMessage('Asset type is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`Asset type must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid date')
    .custom((value) => {
      const deadline = new Date(value);
      const now = new Date();
      if (deadline <= now) {
        throw new Error('Deadline must be in the future');
      }
      return true;
    }),
  body('min_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Minimum contribution must be greater than zero'),
  body('max_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum contribution must be greater than zero')
    .custom((value, { req }) => {
      if (value && req.body.min_contribution && parseFloat(value) <= parseFloat(req.body.min_contribution)) {
        throw new Error('Maximum contribution must be greater than minimum contribution');
      }
      if (value && req.body.target_amount && parseFloat(value) > parseFloat(req.body.target_amount)) {
        throw new Error('Maximum contribution cannot exceed the target amount');
      }
      return true;
    }),
  body('milestones')
    .optional({ nullable: true })
    .custom((value) => {
      if (value == null) return true;
      if (!Array.isArray(value)) throw new Error('Milestones must be an array');
      if (value.length > 10) throw new Error('Campaigns can define at most 10 milestones');
      for (const [index, milestone] of value.entries()) {
        if (!milestone || typeof milestone !== 'object') {
          throw new Error(`Milestone ${index + 1} must be an object`);
        }
        if (!String(milestone.title || '').trim()) {
          throw new Error(`Milestone ${index + 1} title is required`);
        }
        const release = Number(milestone.release_percentage);
        if (!Number.isFinite(release) || release <= 0) {
          throw new Error(`Milestone ${index + 1} release percentage must be greater than zero`);
        }
      }
      return true;
    }),
  body('milestones.*.title').optional().customSanitizer(stripHtml),
  body('milestones.*.description').optional().customSanitizer(stripHtml),
  body('show_backer_amounts')
    .optional()
    .isBoolean()
    .withMessage('show_backer_amounts must be a boolean'),
];

const createCampaignUpdateValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required'),
  body('body')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Body is required'),
];

const contributionValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .isUUID()
    .withMessage('campaign_id must be a valid UUID'),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero'),
  body('send_asset')
    .notEmpty()
    .withMessage('send_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`send_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('display_name')
    .optional({ nullable: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 50 })
    .withMessage('Display name must be at most 50 characters'),
];

const withdrawalValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .isUUID()
    .withMessage('campaign_id must be a valid UUID'),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero'),
  body('destination_key')
    .notEmpty()
    .withMessage('destination_key is required')
    .custom((value) => {
      try {
        Keypair.fromPublicKey(value);
        return true;
      } catch (_err) {
        throw new Error('destination_key must be a valid Stellar public key');
      }
    }),
];

const getCampaignsValidation = [
  query('search').optional().customSanitizer(stripHtml),
  query('status')
    .optional()
    .isIn(VALID_CAMPAIGN_STATUSES)
    .withMessage(`status must be one of: ${VALID_CAMPAIGN_STATUSES.join(', ')}`),
  query('asset')
    .optional()
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('sort')
    .optional()
    .isIn(VALID_ORDER_BY)
    .withMessage(`sort must be one of: ${VALID_ORDER_BY.join(', ')}`),
  query('limit')
    .optional()
    .toInt()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be a positive integer up to 100'),
  query('offset')
    .optional()
    .toInt()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer'),
];

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const fields = result.array().reduce((acc, error) => {
    if (!acc[error.param]) {
      acc[error.param] = error.msg;
    }
    return acc;
  }, {});

  return res.status(422).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      fields,
    },
  });
}

module.exports = {
  registerValidation,
  loginValidation,
  createCampaignValidation,
  createCampaignUpdateValidation,
  contributionValidation,
  withdrawalValidation,
  getCampaignsValidation,
  validateRequest,
};
