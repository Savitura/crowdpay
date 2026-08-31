const fs = require('fs');
const glob = require('glob');
const files = glob.sync('src/emails/*.js');
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  // Handle various mangled insertions from the first run
  content = content.replace(/\]\.join\(""\),\s*,\s*unsubscribeUrl/g, '].join(""),\n    unsubscribeUrl');
  content = content.replace(/\n\s*,\s*unsubscribeUrl/g, ',\n    unsubscribeUrl');
  content = content.replace(/,,\n    unsubscribeUrl/g, ',\n    unsubscribeUrl');
  fs.writeFileSync(file, content);
});
console.log('Fixed syntax errors');
