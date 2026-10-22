const KINDS = {
  user: {
    table: 'webhook_deliveries',
    hooks: 'webhooks',
    event: 'event_type',
    usable: 'w.revoked_at IS NULL',
  },
  campaign: {
    table: 'campaign_webhook_deliveries',
    hooks: 'campaign_webhooks',
    event: 'event',
    usable: 'w.active IS TRUE',
  },
};

async function inspectDeadLetters(db, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be 1..200');
  const { rows } = await db.query(
    `SELECT id, delivery_kind, delivery_id, event_type, attempt_count, replay_count, failed_at,
            resolved_at, safe_metadata FROM webhook_dead_letters
     ORDER BY failed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function replayDeadLetter(client, id) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      'SELECT * FROM webhook_dead_letters WHERE id = $1 FOR UPDATE',
      [id]
    );
    const letter = rows[0];
    if (!letter || letter.resolved_at)
      throw new Error('Dead letter is missing or already replayed');
    const kind = KINDS[letter.delivery_kind];
    if (!kind) throw new Error('Unsupported delivery kind');
    // A new delivery preserves immutable attempt history and bounded retry budgets.
    const result = await client.query(
      `INSERT INTO ${kind.table} (webhook_id, ${kind.event}, payload, status)
       SELECT d.webhook_id, d.${kind.event}, d.payload, 'pending'
       FROM ${kind.table} d JOIN ${kind.hooks} w ON w.id = d.webhook_id
       WHERE d.id = $1 AND d.status = 'failed' AND ${kind.usable}
       RETURNING id`,
      [letter.delivery_id]
    );
    if (!result.rows.length) throw new Error('Delivery is not failed or its webhook is disabled');
    await client.query(
      `UPDATE webhook_dead_letters SET resolved_at = NOW(), replay_count = replay_count + 1,
       safe_metadata = safe_metadata || jsonb_build_object('replay_delivery_id', $2::text)
       WHERE id = $1`,
      [id, result.rows[0].id]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
module.exports = { inspectDeadLetters, replayDeadLetter };
