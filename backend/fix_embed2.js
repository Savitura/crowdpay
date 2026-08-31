const fs = require('fs');
let embed = fs.readFileSync('src/routes/embed.js', 'utf8');

const startIndex = embed.indexOf('async function authenticateEmbedToken');
const endMatch = embed.match(/\/\*\*[\r\n\s]+\* GET \/api\/embed\/campaigns\/:campaignId/);
const endIndex = endMatch ? endMatch.index : -1;

console.log(startIndex, endIndex);
if (startIndex !== -1 && endIndex !== -1) {
  const replacement = `async function authenticateEmbedToken(req, res, next) {
  const token = extractEmbedToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Embed token required in Authorization header' });
  }

  const payload = verifyEmbedToken(token);
  if (!payload || !payload.sub) {
    return res.status(401).json({ error: 'Invalid or expired embed token' });
  }

  if (req.params.campaignId && payload.sub !== req.params.campaignId) {
    return res.status(401).json({ error: 'Embed token does not match campaign ID' });
  }

  const originHeader = req.headers.origin || req.get('origin');
  if (originHeader && !validateOrigin(originHeader, payload.origins)) {
    return res.status(403).json({ error: 'Origin not allowed for this embed token' });
  }

  const { rows } = await db.query(
    \`SELECT * FROM embed_tokens WHERE campaign_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1\`,
    [payload.sub]
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: 'Embed token expired or revoked' });
  }

  const activeToken = rows[0];
  db.query(\`UPDATE embed_tokens SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1\`, [activeToken.id]).catch(() => {});

  req.embedPayload = payload;
  req.embedTokenRow = activeToken;
  next();
}

/**
 * GET /api/embed/:campaignId/stats
 */
router.get(
  '/:campaignId/stats',
  embedStatsLimiter,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;

    const campaignQuery = await db.query(
      \`SELECT id, title, description, target_amount, raised_amount, asset_type,
              status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1\`,
      [campaignId]
    );

    if (campaignQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignQuery.rows[0];

    const contributorsQuery = await db.query(
      \`SELECT id, amount, created_at, contributor_name
       FROM contributions
       WHERE campaign_id = $1 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 5\`
    );

    res.json({
      campaign,
      recentContributors: contributorsQuery.rows,
    });
  })
);

`;

  embed = embed.substring(0, startIndex) + replacement + embed.substring(endIndex);
  fs.writeFileSync('src/routes/embed.js', embed);
  console.log('Fixed embed.js');
}
