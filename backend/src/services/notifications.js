const db = require('../config/database');
const logger = require('../config/logger');

async function createNotification(userId, { type, title, body, link }) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body || null, link || null]
    );
  } catch (err) {
    logger.error('Failed to create notification', { user_id: userId, type, error: err.message });
  }
}

module.exports = { createNotification };
