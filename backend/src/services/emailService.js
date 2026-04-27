const nodemailer = require('nodemailer');

let transporter;

if (process.env.SMTP_HOST || process.env.EMAIL_SERVICE_API_KEY) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: process.env.SMTP_PORT || 587,
    auth: {
      user: process.env.SMTP_USER || 'apikey',
      pass: process.env.SMTP_PASS || process.env.EMAIL_SERVICE_API_KEY,
    },
  });
}

/**
 * Sends an email asynchronously.
 */
async function sendEmail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`[Email Service Mock] to: ${to} | subject: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"CrowdPay" <noreply@crowdpay.local>',
      to,
      subject,
      text: text || '',
      html: html || '',
    });
  } catch (error) {
    console.error(`[Email Service Error] Failed to send email to ${to}:`, error.message);
  }
}

module.exports = { sendEmail };
