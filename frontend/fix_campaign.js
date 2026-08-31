const fs = require('fs');
let camp = fs.readFileSync('src/pages/Campaign.jsx', 'utf8');
camp = camp.replace('}\r\n *\r\n * Shows a green "You\\'re eligible"', '}\r\n\r\n/**\r\n * Shows a green "You\\'re eligible"');
camp = camp.replace('}\n *\n * Shows a green "You\\'re eligible"', '}\n\n/**\n * Shows a green "You\\'re eligible"');
fs.writeFileSync('src/pages/Campaign.jsx', camp);
console.log('Fixed Campaign.jsx');
