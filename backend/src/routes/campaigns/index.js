// backend/src/routes/campaigns/index.js
'use strict';

const express = require('express');
const createHelpers = require('./helpers');
const createDiscoveryRouter = require('./discovery');
const createDraftsRouter = require('./drafts');
const createMilestonesRouter = require('./milestones');
const createTiersRouter = require('./tiers');
const createUpdatesRouter = require('./updates');
const createMembersRouter = require('./members');
const createAnalyticsRouter = require('./analytics');
const createReferralsRouter = require('./referrals');
const createEmbedRouter = require('./embed');
const createRefundsRouter = require('./refunds');
const createCrudRouter = require('./crud');

function createCampaignsRouter(deps = {}) {
  const router = express.Router();
  const helpers = deps.helpers || createHelpers(deps);
  const routerDeps = { ...deps, helpers };

  router.use(createDiscoveryRouter(routerDeps));
  router.use(createDraftsRouter(routerDeps));
  router.use(createMilestonesRouter(routerDeps));
  router.use(createTiersRouter(routerDeps));
  router.use(createUpdatesRouter(routerDeps));
  router.use(createMembersRouter(routerDeps));
  router.use(createAnalyticsRouter(routerDeps));
  router.use(createReferralsRouter(routerDeps));
  router.use(createEmbedRouter(routerDeps));
  router.use(createRefundsRouter(routerDeps));
  router.use(createCrudRouter(routerDeps));

  return router;
}

module.exports = createCampaignsRouter;
module.exports.createCampaignsRouter = createCampaignsRouter;
