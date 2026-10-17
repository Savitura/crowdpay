const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const EMAILS_DIR = path.resolve(__dirname, '../emails');
const SAFE_TEMPLATE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Strict gate: never allow outside development
router.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

function getEmailTemplates() {
  if (!fs.existsSync(EMAILS_DIR)) return [];

  const files = fs.readdirSync(EMAILS_DIR);
  const templates = [];

  for (const file of files) {
    if (file === 'layout.js' || !file.endsWith('.js')) continue;
    const templateName = file.replace(/\.js$/, '');
    if (!SAFE_TEMPLATE_NAME_REGEX.test(templateName)) continue;

    const templatePath = path.resolve(EMAILS_DIR, file);
    // Defense-in-depth: ensure resolved path is strictly within EMAILS_DIR
    if (!templatePath.startsWith(EMAILS_DIR)) continue;

    try {
      const templateModule = require(templatePath);
      const methods = Object.keys(templateModule).filter(
        key => typeof templateModule[key] === 'function' && key.startsWith('build')
      );

      if (methods.length > 0) {
        templates.push({
          name: templateName,
          methods,
        });
      }
    } catch {
      // Ignore invalid modules in dev listing
    }
  }

  return templates;
}

// GET /api/dev/emails - list available templates
router.get('/emails', (req, res) => {
  const templates = getEmailTemplates();

  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    let html = `<!DOCTYPE html>
<html>
<head>
  <title>Email Template Preview (Development)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; line-height: 1.5; color: #1f2937; }
    h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1.5rem; }
    .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.875rem; font-weight: 600; margin-bottom: 1rem; }
    .template-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: #ffffff; }
    .template-title { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem; }
    .methods-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .method-link { display: inline-block; padding: 0.35rem 0.75rem; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 0.875rem; }
    .method-link:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <span class="badge">DEVELOPMENT ONLY</span>
  <h1>Email Templates Preview</h1>
  <p>Select a template method below to preview its rendered HTML output.</p>
`;
    for (const t of templates) {
      html += `  <div class="template-card">
    <div class="template-title">${t.name}</div>
    <div class="methods-list">
`;
      for (const method of t.methods) {
        html += `      <a class="method-link" href="/api/dev/emails/${encodeURIComponent(t.name)}?_method=${encodeURIComponent(method)}" target="_blank">${method}()</a>\n`;
      }
      html += `    </div>\n  </div>\n`;
    }
    html += `</body>\n</html>`;
    return res.type('html').send(html);
  }

  res.json({ templates });
});

// GET /api/dev/emails/:templateName - preview specific rendered template
router.get('/emails/:templateName', (req, res) => {
  const { templateName } = req.params;

  if (!SAFE_TEMPLATE_NAME_REGEX.test(templateName)) {
    return res.status(400).json({ error: 'Invalid template name' });
  }

  const templatePath = path.resolve(EMAILS_DIR, `${templateName}.js`);
  if (!templatePath.startsWith(EMAILS_DIR) || !fs.existsSync(templatePath)) {
    return res.status(404).json({ error: `Template "${templateName}" not found` });
  }

  try {
    const templateModule = require(templatePath);
    const method = req.query._method || 'build';

    if (typeof templateModule[method] !== 'function') {
      return res.status(400).json({
        error: `Method "${method}" not found on template "${templateName}"`,
      });
    }

    const defaultParams = {
      name: 'Alex Johnson',
      recipientName: 'Alex Johnson',
      creatorName: 'Amara Okafor',
      contributorName: 'Chioma Adebayo',
      campaignTitle: 'Lagos Clean Energy Hub',
      campaignUrl: 'http://localhost:5173/campaigns/11111111-1111-1111-1111-111111111111',
      targetAmount: '10,000 USDC',
      raisedAmount: '10,000 USDC',
      walletPublicKey: 'GBZXN7PIRZGNMHGA728RGRUPKZXA6Y4WXA6Y4WXA6Y4WXA6Y4WXA6Y4W',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      amount: '100 USDC',
      asset: 'USDC',
      outcome: 'resolved in favor of contributor',
      unsubscribeUrl: 'http://localhost:5173/unsubscribe?token=sample-token',
      deadline: new Date(Date.now() + 86400000 * 7).toISOString(),
      reason: 'Verification completed',
      notes: 'Evidence reviewed by auditor',
    };

    const queryParams = { ...req.query };
    delete queryParams._method;

    const result = templateModule[method]({ ...defaultParams, ...queryParams });

    if (req.query.format === 'json') {
      return res.json({
        subject: result?.subject,
        text: result?.text,
        html: result?.html,
      });
    }

    if (result && result.html) {
      return res.type('html').send(result.html);
    }

    return res.status(500).json({ error: 'Template did not return an html property' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to render template', details: err.message });
  }
});

module.exports = router;
module.exports.getEmailTemplates = getEmailTemplates;
