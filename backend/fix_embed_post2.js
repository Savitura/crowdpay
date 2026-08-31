const fs = require('fs');
let embed = fs.readFileSync('src/routes/embed.js', 'utf8');

const regex = /res\.json\(\{\s*id: campaign\.id,\s*title: campaign\.title,[\s\S]*?milestones: milestonesQuery\.rows,\s*\}\);/;

const correctResJson = `res.json({
      id: campaign.id,
      raised_amount: updated.raised_amount,
      target_amount: updated.target_amount,
    });`;

if (regex.test(embed)) {
  embed = embed.replace(regex, correctResJson);
  fs.writeFileSync('src/routes/embed.js', embed);
  console.log('Fixed POST /contribute res.json');
} else {
  console.log('Could not find the bad res.json in POST /contribute');
}
