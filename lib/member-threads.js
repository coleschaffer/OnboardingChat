const { postMessage } = require('../api/slack-threads');

async function getMemberThread(pool, email, threadType, periodKey) {
  if (!pool || !email || !threadType || !periodKey) return null;

  const normalizedEmail = email.toString().trim().toLowerCase();
  if (!normalizedEmail) return null;

  const result = await pool.query(
    `
      SELECT *
      FROM member_threads
      WHERE TRIM(LOWER(member_email)) = TRIM(LOWER($1))
        AND thread_type = $2
        AND period_key = $3
      LIMIT 1
    `,
    [normalizedEmail, threadType, periodKey]
  );

  return result.rows[0] || null;
}

async function createMemberThread(pool, {
  email,
  name,
  threadType,
  periodKey,
  channelId,
  summaryText,
  summaryBlocks,
  metadata
}) {
  if (!pool || !email || !threadType || !periodKey) return null;

  const normalizedEmail = email.toString().trim().toLowerCase();
  if (!normalizedEmail) return null;

  await pool.query(
    `
      INSERT INTO member_threads (member_email, member_name, thread_type, period_key, metadata)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (member_email, thread_type, period_key) DO NOTHING
    `,
    [
      normalizedEmail,
      name || null,
      threadType,
      periodKey,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  const existing = await getMemberThread(pool, normalizedEmail, threadType, periodKey);
  if (!existing) return null;

  if (existing.slack_thread_ts || !channelId || !summaryText) {
    return { thread: existing, created: !existing.slack_thread_ts };
  }

  try {
    const response = await postMessage(channelId, summaryText, summaryBlocks || null);
    if (response?.ts) {
      const updateResult = await pool.query(
        `
          UPDATE member_threads
          SET slack_channel_id = $1,
              slack_thread_ts = $2
          WHERE id = $3
          RETURNING *
        `,
        [channelId, response.ts, existing.id]
      );
      return { thread: updateResult.rows[0], created: true };
    }
  } catch (error) {
    console.error('[MemberThreads] Failed to post Slack thread:', error.message);
  }

  return { thread: existing, created: !existing.slack_thread_ts };
}

async function updateMemberThreadMetadata(pool, threadId, metadata) {
  if (!pool || !threadId) return null;

  const result = await pool.query(
    `
      UPDATE member_threads
      SET metadata = $2
      WHERE id = $1
      RETURNING *
    `,
    [threadId, metadata ? JSON.stringify(metadata) : null]
  );

  return result.rows[0] || null;
}

module.exports = {
  getMemberThread,
  createMemberThread,
  updateMemberThreadMetadata
};
