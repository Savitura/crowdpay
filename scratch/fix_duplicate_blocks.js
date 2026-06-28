const fs = require('fs');
let lines = fs.readFileSync('frontend/src/pages/Campaign.jsx', 'utf8').split('\n');
lines.splice(1959, 130);
fs.writeFileSync('frontend/src/pages/Campaign.jsx', lines.join('\n'));

lines = fs.readFileSync('frontend/src/pages/AdminDashboard.jsx', 'utf8').split('\n');
lines.splice(932, 11);
fs.writeFileSync('frontend/src/pages/AdminDashboard.jsx', lines.join('\n'));
