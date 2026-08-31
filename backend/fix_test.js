const fs = require('fs');
let code = fs.readFileSync('src/services/emailService.test.js', 'utf8');
code = code.replace(/\{ enabled: true \}/g, '{ marketing: true }');
code = code.replace(/\{ enabled: false \}/g, '{ campaign_updates: false }');
fs.writeFileSync('src/services/emailService.test.js', code);
