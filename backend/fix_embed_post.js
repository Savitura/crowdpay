const fs = require('fs');
let embed = fs.readFileSync('src/routes/embed.js', 'utf8');

const badResJsonStart = `    res.json({
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      target_amount: campaign.target_amount,
      raised_amount: campaign.raised_amount,
      asset_type: campaign.asset_type,
      status: campaign.status,
      backer_count: campaign.backer_count || contributorsQuery.rows.length,
      days_remaining: daysRemaining,
      progress_percentage: Number(progressPercentage.toFixed(1)),
      contribution_url: campaign.contribution_url || \`\${req.protocol}://\${req.get('host')}/campaigns/\${campaign.id}\`,
      recent_backers: contributorsQuery.rows.map(c => ({
        id: c.id,
        amount: c.amount,
        name: c.contributor_name || 'Anonymous',
        created_at: c.created_at,
      })),
      milestones: milestonesQuery.rows,
    });`;

const correctResJson = `    res.json({
      id: campaign.id,
      raised_amount: updated.raised_amount,
      target_amount: updated.target_amount,
    });`;

if (embed.includes(badResJsonStart)) {
  embed = embed.replace(badResJsonStart, correctResJson);
  fs.writeFileSync('src/routes/embed.js', embed);
  console.log('Fixed POST /contribute res.json');
} else {
  console.log('Could not find the bad res.json in POST /contribute');
}
