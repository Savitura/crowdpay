const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Strictly gate all routes in this file
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).send('Not allowed in production');
  }
  next();
});

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

router.get('/email-preview', (req, res) => {
  const templates = getEmailTemplates();
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Email Template Preview</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; line-height: 1.5; }
        h1 { border-bottom: 1px solid #eaeaea; padding-bottom: 0.5rem; }
        .template { margin-bottom: 1.5rem; border: 1px solid #eaeaea; padding: 1rem; border-radius: 8px; }
        .template h3 { margin-top: 0; }
        .methods { display: flex; flex-direction: column; gap: 0.5rem; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .form-group { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
        input[type="text"] { padding: 0.25rem 0.5rem; border: 1px solid #ccc; border-radius: 4px; flex-grow: 1; }
        button { padding: 0.25rem 0.75rem; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0052a3; }
      </style>
    </head>
    <body>
      <h1>Email Templates</h1>
      <p>Select a template and method to preview. You can add query parameters (e.g. <code>&name=John</code>) in the URL.</p>
  `;

  for (const t of templates) {
    html += `<div class="template">
      <h3>${t.name}</h3>
      <div class="methods">
    `;
    
    for (const method of t.methods) {
      // Create a small form that navigates to the URL
      html += `
        <form action="/api/v1/dev/email-preview/${t.name}" method="GET" target="_blank" class="form-group">
          <input type="hidden" name="_method" value="${method}">
          <strong>${method}</strong>
          <input type="text" name="queryString" placeholder="name=Test&amount=100 (optional query string without ?)">
          <button type="submit" onclick="if(this.form.queryString.value) { this.form.action = '/api/v1/dev/email-preview/${t.name}?' + this.form.queryString.value; this.form.queryString.disabled = true; }">Preview</button>
        </form>
      `;
    }
    html += `</div></div>`;
  }

  html += `</body></html>`;
  res.send(html);
});

router.get('/email-preview/:templateName', (req, res) => {
  const { templateName } = req.params;
  const emailsDir = path.join(__dirname, '../emails');
  const templatePath = path.join(emailsDir, \`\${templateName}.js\`);

  if (!fs.existsSync(templatePath)) {
    return res.status(404).send(\`Template "\${templateName}" not found.\`);
  }

  try {
    const templateModule = require(templatePath);
    const method = req.query._method || 'build';
    
    if (typeof templateModule[method] !== 'function') {
      return res.status(400).send(\`Method "\${method}" not found on template "\${templateName}".\`);
    }

    // Pass all query params (except _method and queryString) to the build method
    const params = { ...req.query };
    delete params._method;
    delete params.queryString;

    // Provide some default dummy values if not provided
    const defaultParams = {
      name: 'John Doe',
      creatorName: 'Creator Alice',
      contributorName: 'Contributor Bob',
      campaignTitle: 'Save the Ocean',
      campaignUrl: 'http://localhost:5173/campaigns/test',
      targetAmount: '10,000 USDC',
      raisedAmount: '10,000 USDC',
      walletPublicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ',
      txHash: '0x1234567890abcdef',
      amount: '50 USDC',
      asset: 'USDC',
      outcome: 'resolved in favor of contributor',
      unsubscribeUrl: 'http://localhost:5173/unsubscribe?token=123',
    };

    const finalParams = { ...defaultParams, ...params };

    const result = templateModule[method](finalParams);
    
    // Send the generated HTML string directly to the browser
    if (result && result.html) {
      res.send(result.html);
    } else {
      res.status(500).send('Template did not return an html property.');
    }
  } catch (err) {
    res.status(500).send(\`<pre>Error rendering template: \${err.stack}</pre>\`);
  }
});

module.exports = router;
