function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function button(label, url) {
  return `
    <tr>
      <td align="center" style="padding: 24px 0;">
        <a href="${escapeHtml(url)}" target="_blank"
          style="background-color:#0f62fe;border-radius:6px;color:#ffffff;display:inline-block;
                 font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;
                 line-height:44px;text-align:center;text-decoration:none;width:240px;-webkit-text-size-adjust:none;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>`;
}

/**
 * Renders a branded, table-based HTML email shell. Table layout + inline CSS
 * is required for consistent rendering across Outlook/Gmail/Apple Mail.
 */
function renderLayout({ previewText = "", bodyHtml, unsubscribeUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CrowdPay</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(previewText)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background-color:#0f1f3d;padding:20px 32px;">
              <span style="color:#ffffff;font-size:20px;font-weight:bold;">CrowdPay</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f9fafb;color:#8a8f98;font-size:12px;line-height:1.6;border-top:1px solid #eceef1;">
              You're receiving this email because of activity on your CrowdPay account.
              ${unsubscribeUrl ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#8a8f98;text-decoration:underline;">Unsubscribe from these emails</a>` : ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function paragraph(text) {
  return `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 16px;font-size:20px;color:#0f1f3d;">${escapeHtml(text)}</h1>`;
}

function link(label, url) {
  return `<a href="${escapeHtml(url)}" target="_blank" style="color:#0f62fe;word-break:break-all;">${escapeHtml(label)}</a>`;
}

function table(rows) {
  const rowsHtml = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 0;color:#5c6066;width:40%;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#1a1a1a;font-weight:bold;">${escapeHtml(value)}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;">${rowsHtml}</table>`;
}

module.exports = {
  escapeHtml,
  renderLayout,
  paragraph,
  heading,
  link,
  table,
  buttonRow: (label, url) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${button(label, url)}</table>`,
};
