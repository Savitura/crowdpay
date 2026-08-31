const fs = require('fs');

let c = fs.readFileSync('src/index.js', 'utf8');

c = c.replace(/app\.listen\(port, \(\) => \{\n    console\.log\(`CrowdPay server listening on port \$\{port\}`\);\napp\.use/, 'app.listen(port, () => {\n    console.log(`CrowdPay server listening on port ${port}`);\n  });\n}\n\napp.use');

fs.writeFileSync('src/index.js', c);

let auth = fs.readFileSync('src/middleware/embedAuth.js', 'utf8');
auth = auth.replace("'use strict;", "'use strict';");
auth = auth.replace("await validateEmbedToken rawToken);", "await validateEmbedToken(rawToken);");
fs.writeFileSync('src/middleware/embedAuth.js', auth);

let embed = fs.readFileSync('src/routes/embed.js', 'utf8');
embed = embed.replace(/LIMIT 5`,[\s\S]+?GET \/api\/embed\/campaigns\/:campaignId/m, "LIMIT 5`\n    );\n\n/**\n * GET /api/embed/campaigns/:campaignId");
fs.writeFileSync('src/routes/embed.js', embed);

let embedTest = fs.readFileSync('src/routes/embed.test.js', 'utf8');
if (!embedTest.includes('const jwt = require(')) {
  embedTest = "const jwt = require('jsonwebtoken');\nconst CAMPAIGN_ID = 'c-1';\nconst JWT_SECRET = 'test-secret';\nconst TOKEN_ID = 't-1';\nconst CREATOR_ID = 'u-1';\n" + embedTest;
  fs.writeFileSync('src/routes/embed.test.js', embedTest);
}

let camp = fs.readFileSync('../frontend/src/pages/Campaign.jsx', 'utf8');
camp = camp.replace(/}\n \*\n \* Shows a green "You're eligible"/, "}\n\n/**\n * Shows a green \"You're eligible\"");
fs.writeFileSync('../frontend/src/pages/Campaign.jsx', camp);
