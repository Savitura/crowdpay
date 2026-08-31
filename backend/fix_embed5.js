const fs = require('fs');
let embed = fs.readFileSync('src/routes/embed.js', 'utf8');

// Replace everything between res.header('Access-Control-Allow-Origin', '*'); and const milestonesQuery
const startMark = "res.header('Access-Control-Allow-Origin', '*');";
const endMark = "const milestonesQuery = await db.query(";

const idxStart = embed.indexOf(startMark);
const idxEnd = embed.indexOf(endMark);

if (idxStart !== -1 && idxEnd !== -1) {
  embed = embed.substring(0, idxStart + startMark.length) +
`
    const { rows } = await db.query(
      \`SELECT id, title, description, target_amount, raised_amount, asset_type, status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1 AND deleted_at IS NULL\`,
      [campaignId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    const countRows = [{ count: campaign.backer_count || 0 }];
    const contributorsQuery = { rows: [] };

    ` + embed.substring(idxEnd);
}

// Replace require fs and path
embed = "const fs = require('fs');\nconst path = require('path');\n" + embed;

fs.writeFileSync('src/routes/embed.js', embed);
