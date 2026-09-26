const router = require("express").Router();
const fs = require('fs');
const path = require('path');

function getEmailTemplates() {
  const emailsDir = path.join(__dirname, '../emails');
  const files = fs.readdirSync(emailsDir);
  const templates = [];

  for (const file of files) {
    if (file === 'layout.js' || !file.endsWith('.js')) continue;
    const templateName = file.replace('.js', '');
    const templatePath = path.join(emailsDir, file);
    const templateModule = require(templatePath);
    
    const methods = Object.keys(templateModule).filter(
      (key) => typeof templateModule[key] === 'function' && key.startsWith('build')
    );
    
    if (methods.length > 0) {
      templates.push({
        name: templateName,
        methods: methods
      });
    }
  }

  return templates;
}
