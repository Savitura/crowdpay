const fs = require('fs');
let embed = fs.readFileSync('src/routes/embed.js', 'utf8');

const badSectionStart = embed.indexOf('  const payload = verifyEmbedToken(token);');
const match = embed.match(/\/\*\*[\r\n\s]+\* GET \/api\/embed\/campaigns\/:campaignId/);
const badSectionEnd = match ? match.index : -1;

if (badSectionStart !== -1 && badSectionEnd !== -1) {
  embed = embed.substring(0, badSectionStart) +
`  const payload = verifyEmbedToken(token);
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
 * Public endpoint gated by embed token. Returns ONLY public summary fields.
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

` + embed.substring(badSectionEnd);
}

// Fix 2: 'campaign' is not defined in GET /api/embed/campaigns/:campaignId
const fix2Target = `    const { rows } = await db.query(
      \`SELECT title, description, target_amount, raised_amount, asset_type, status, deadline
       FROM campaigns WHERE id = $1 AND deleted_at IS NULL\`,
      [campaignId]
    );`;

const fix2Replacement = `    const { rows } = await db.query(
      \`SELECT title, description, target_amount, raised_amount, asset_type, status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1 AND deleted_at IS NULL\`,
      [campaignId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    const countRows = [{ count: campaign.backer_count || 0 }];
    const contributorsQuery = { rows: [] };`;
embed = embed.replace(fix2Target, fix2Replacement);

const fix3Target = `      res.setHeader('Content-Security-Policy', buildEmbedCsp());
      res.removeHeader('X-Frame-Options');

      const widgetPath = path.join(__dirname, '../../../frontend/public/embed/widget.html');`;
const fix3Replacement = `      res.setHeader('Content-Security-Policy', buildEmbedCsp());
      res.removeHeader('X-Frame-Options');

      const path = require('path');
      const fs = require('fs');
      const widgetPath = path.join(__dirname, '../../../frontend/public/embed/widget.html');`;
embed = embed.replace(fix3Target, fix3Replacement);

const fix4Target = `      res.setHeader('Access-Control-Allow-Origin', '*');

      const widgetScriptPath = path.join(__dirname, '../../../frontend/public/embed/widget.js');`;
const fix4Replacement = `      res.setHeader('Access-Control-Allow-Origin', '*');

      const path = require('path');
      const fs = require('fs');
      const widgetScriptPath = path.join(__dirname, '../../../frontend/public/embed/widget.js');`;
embed = embed.replace(fix4Target, fix4Replacement);

fs.writeFileSync('src/routes/embed.js', embed);
console.log('Fixed embed.js nicely');
