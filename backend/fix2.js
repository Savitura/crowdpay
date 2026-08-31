const fs = require('fs');
const glob = require('glob');
const files = glob.sync('src/emails/*.js');

files.forEach(file => {
  if (file.includes('layout.js')) return;
  let content = fs.readFileSync(file, 'utf8');

  // Find all function declarations that start with build
  // function build({ name, walletPublicKey }) {
  // function buildForCreator({ adminName, campaignTitle }) {
  content = content.replace(/function build[a-zA-Z]*\(\{\s*([^}]+?)\s*\}\)\s*\{/g, (match, args) => {
    return match.replace(args, args + ', unsubscribeUrl');
  });

  // Find all renderLayout calls
  // renderLayout({ previewText: "...", bodyHtml: [ ... ].join("") })
  // renderLayout({ previewText, bodyHtml })
  content = content.replace(/renderLayout\(\{\s*(.*?)\s*\}\);/gs, (match, inner) => {
    return `renderLayout({\n    ${inner},\n    unsubscribeUrl\n  });`;
  });

  fs.writeFileSync(file, content);
});
console.log('Fixed emails properly!');
