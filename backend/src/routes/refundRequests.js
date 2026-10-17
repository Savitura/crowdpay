const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/refundRequestService');

router.use(requireAuth);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { campaignId, contributionId, amount, reason } = req.body;
    const request = await service.createRequest({
      campaignId,
      contributionId,
      amount,
      reason,
      contributorId: req.user.userId,
    });
    res.status(201).json(request);
  })
);

router.get(
  '/campaign/:campaignId',
  asyncHandler(async (req, res) => {
    res.json(
      await service.listRequests(req.params.campaignId, req.user.userId, req.user.role === 'admin')
    );
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.getRequest(req.params.id, req.user.userId, req.user.role === 'admin'));
  })
);

router.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const { approve, rejectionReason } = req.body;
    res.json(
      await service.reviewRequest(req.params.id, {
        reviewerId: req.user.userId,
        approve: approve === true,
        rejectionReason,
        isAdmin: req.user.role === 'admin',
      })
    );
  })
);

router.post(
  '/:id/pay',
  asyncHandler(async (req, res) => {
    res.json(await service.payRequest(req.params.id, { actorId: req.user.userId }));
  })
);

module.exports = router;
