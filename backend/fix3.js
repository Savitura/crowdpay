const fs = require('fs');
const glob = require('glob');
const files = glob.sync('src/emails/*.js');

files.forEach(file => {
  if (file.includes('layout.js')) return;
  let content = fs.readFileSync(file, 'utf8');

  content = content.replace(/function build[a-zA-Z]*\(\{\s*([^}]+?)\s*\}\)\s*\{/g, (match, args) => {
    if (args.includes('unsubscribeUrl')) return match;
    return match.replace(args, args + ', unsubscribeUrl');
  });

  content = content.replace(/renderLayout\(\{\s*(.*?)\s*\}\);/gs, (match, inner) => {
    if (inner.includes('unsubscribeUrl')) return match;
    return `renderLayout({\n    ${inner},\n    unsubscribeUrl\n  });`;
  });

  fs.writeFileSync(file, content);
});
console.log('Fixed emails from scratch!');
