const fs = require('fs');
let code = fs.readFileSync('src/services/emailService.js', 'utf8');

const newIsUnsub = `
async function isUnsubscribed(email, category) {
  // Try to find the user
  const { rows: users } = await db.query(
    "SELECT id FROM users WHERE email = $1",
    [email.toLowerCase()]
  );
  if (!users.length) return false;

  // Map old categories to the new ones
  const map = {
    marketing: 'marketing',
    campaign_update: 'campaign_updates',
    refund: 'refunds',
    milestone: 'milestones',
    dispute: 'disputes'
  };
  const mapped = map[category] || 'campaign_updates';

  const { rows } = await db.query(
    "SELECT * FROM notification_preferences WHERE user_id = $1",
    [users[0].id]
  );
  if (!rows.length) {
    // defaults: marketing off, others on
    return mapped === 'marketing';
  }
  
  return !rows[0][mapped];
}
`;

code = code.replace(/async function isUnsubscribed\(email, category\)\s*\{[\s\S]*?return rows\.length > 0;\s*\}/, newIsUnsub.trim());
fs.writeFileSync('src/services/emailService.js', code);
