/**
 * Wasender (WhatsApp) Webhook Handler
 *
 * Tracks when members join the WhatsApp group and updates application/member status.
 *
 * Expected to receive events like: "group-participants.update" (join/leave/promote/etc).
 */

const express = require('express');
const router = express.Router();
const { postMessage } = require('./slack-threads');

function toSearchableString(value) {
  if (value == null) return '';

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(v => toSearchableString(v)).join(' ');
  }

  if (typeof value === 'object') {
    // Common participant shapes across WhatsApp SDKs / APIs
    const candidate =
      value.id ||
      value.jid ||
      value.participant ||
      value.user ||
      value.phone ||
      value.number ||
      value.waId ||
      value.wa_id ||
      value.msisdn ||
      null;

    if (candidate) return toSearchableString(candidate);

    // Last resort: stringify and extract digits
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  try {
    return value.toString();
  } catch {
    return '';
  }
}

function digitsOnly(value) {
  return toSearchableString(value).replace(/\D/g, '');
}

function normalizeGroupJid(value) {
  const raw = toSearchableString(value).trim();
  if (!raw) return null;

  // Common WhatsApp group JID looks like: 120363261244407125@g.us
  const match = raw.match(/[0-9]+@g\.us/);
  if (match) return match[0];

  // Sometimes UIs or APIs expose the group id without the domain.
  const digits = digitsOnly(raw);
  if (digits.length >= 11) return `${digits}@g.us`;

  return raw;
}

function last10Digits(value) {
  const digits = digitsOnly(value);
  if (!digits) return null;
  return digits.length <= 10 ? digits : digits.slice(-10);
}

function findGroupJidFromPayload(payload, data) {
  // Try the most common shapes first
  const candidates = [
    data?.group,
    data?.groupId,
    data?.group_id,
    data?.chat,
    data?.chatId,
    data?.chat_id,
    data?.remoteJid,
    data?.remote_jid,
    payload?.group,
    payload?.groupId,
    payload?.group_id,
    payload?.chat,
    payload?.chatId,
    payload?.chat_id
  ];

  for (const candidate of candidates) {
    const jid = normalizeGroupJid(candidate?.id ?? candidate?.jid ?? candidate);
    if (jid && jid.includes('@g.us')) return jid;
  }

  // Last resort: scan the payload for any string containing "@g.us"
  // (depth-limited to avoid pathological payloads)
  const visited = new Set();
  const queue = [{ value: payload, depth: 0 }];

  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (value == null) continue;
    if (depth > 6) continue;

    if (typeof value === 'string') {
      const jid = normalizeGroupJid(value);
      if (jid && jid.includes('@g.us')) return jid;
      continue;
    }

    if (typeof value !== 'object') continue;
    if (visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }

    for (const k of Object.keys(value)) {
      // Prefer keys that look like they'd contain the group/chat id
      const v = value[k];
      if (typeof v === 'string' && v.includes('@g.us')) {
        const jid = normalizeGroupJid(v);
        if (jid && jid.includes('@g.us')) return jid;
      }
      queue.push({ value: v, depth: depth + 1 });
    }
  }

  return null;
}

async function findApplicationByPhone(pool, phoneLast10) {
  if (!phoneLast10) return null;

  const result = await pool.query(
    `
      SELECT id, email, first_name, last_name, whatsapp_joined_at
      FROM typeform_applications
      WHERE phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [phoneLast10]
  );

  return result.rows[0] || null;
}

async function findEmailByPhoneFallback(pool, phoneLast10) {
  if (!phoneLast10) return null;

  // Try business_owners first (WhatsApp number or phone)
  const bo = await pool.query(
    `
      SELECT email
      FROM business_owners
      WHERE (whatsapp_number IS NOT NULL AND regexp_replace(whatsapp_number, '[^0-9]', '', 'g') LIKE '%' || $1)
         OR (phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `,
    [phoneLast10]
  );
  if (bo.rows[0]?.email) return bo.rows[0].email;

  // Try samcart_orders phone
  const so = await pool.query(
    `
      SELECT email
      FROM samcart_orders
      WHERE phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [phoneLast10]
  );
  if (so.rows[0]?.email) return so.rows[0].email;

  return null;
}

async function markWhatsAppJoined(pool, application, rawPayload) {
  // Only update once to prevent repeated webhook deliveries spamming Slack.
  const updateResult = await pool.query(
    `
      UPDATE typeform_applications
      SET whatsapp_joined_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND whatsapp_joined_at IS NULL
      RETURNING id, email, first_name, last_name, whatsapp_joined_at
    `,
    [application.id]
  );

  const updated = updateResult.rows[0] || null;
  const didUpdate = !!updated;

  const email = (updated?.email || application.email || '').toLowerCase();

  // Mirror onto business_owners (best-effort)
  if (email) {
    try {
      await pool.query(
        `
          UPDATE business_owners
          SET whatsapp_joined = true,
              whatsapp_joined_at = COALESCE(whatsapp_joined_at, CURRENT_TIMESTAMP)
          WHERE LOWER(email) = LOWER($1)
        `,
        [email]
      );
    } catch (e) {
      console.error('[Wasender] Failed updating business_owners whatsapp_joined:', e.message);
    }
  }

  // Log activity
  try {
    await pool.query(
      'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
      [
        'whatsapp_joined',
        'typeform_application',
        application.id,
        JSON.stringify({
          email: application.email || null,
          first_name: application.first_name || null,
          last_name: application.last_name || null,
          did_update: didUpdate,
          source: 'wasender_webhook',
          raw_event: rawPayload?.event || rawPayload?.type || null
        })
      ]
    );
  } catch (e) {
    console.error('[Wasender] Failed logging activity_log whatsapp_joined:', e.message);
  }

  return { didUpdate, updated };
}

async function postJoinedToNotificationsThread(pool, email, displayName, phoneLast10) {
  if (!email) return false;

  const stefanSlackId = process.env.STEF_SLACK_MEMBER_ID;
  const mention = stefanSlackId ? `<@${stefanSlackId}>` : 'Stefan';

  const orderResult = await pool.query(
    `
      SELECT slack_channel_id, slack_thread_ts
      FROM samcart_orders
      WHERE LOWER(email) = LOWER($1)
        AND slack_channel_id IS NOT NULL
        AND slack_thread_ts IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [email]
  );

  const order = orderResult.rows[0];
  if (!order) return false;

  const safeName = displayName || email || 'Member';
  const phoneSuffix = phoneLast10 ? ` (…${phoneLast10.slice(-4)})` : '';

  const text = `✅ *WhatsApp Joined:* ${safeName}${phoneSuffix}\n${mention}`;
  await postMessage(order.slack_channel_id, text, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text }
    }
  ], order.slack_thread_ts);

  return true;
}

router.post('/', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    // Optional shared secret
    const expectedSecret = process.env.WASENDER_WEBHOOK_SECRET;
    const providedSecret = req.headers['x-wasender-secret'] || req.query.secret;
    if (expectedSecret && providedSecret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = req.body || {};
    const eventName = payload.event || payload.type || payload.scope || payload.topic || null;
    const data = payload.data || payload.payload || payload;

    // We primarily care about group participant additions (member joins WhatsApp group).
    const isParticipantsUpdate = eventName === 'group-participants.update' || (Array.isArray(data.participants) && typeof data.action === 'string');
    if (!isParticipantsUpdate) {
      return res.json({ received: true, ignored: true, event: eventName });
    }

    const action = (data.action || '').toLowerCase();
    if (action && action !== 'add' && action !== 'invite' && action !== 'join') {
      return res.json({ received: true, ignored: true, event: eventName, action });
    }

    // If configured, only process join events for specific WhatsApp group(s).
    // This prevents "Joined" being marked when someone joins unrelated groups.
    const allowedEnv = (process.env.WASENDER_ALLOWED_GROUP_JIDS || '').trim();
    if (allowedEnv) {
      const allowed = new Set(
        allowedEnv
          .split(',')
          .map(s => normalizeGroupJid(s))
          .filter(Boolean)
      );

      const groupJid = findGroupJidFromPayload(payload, data);
      const normalizedGroupJid = normalizeGroupJid(groupJid);
      if (!normalizedGroupJid || !allowed.has(normalizedGroupJid)) {
        return res.json({
          received: true,
          ignored: true,
          reason: 'group_not_allowed',
          event: eventName,
          group_jid: normalizedGroupJid || null
        });
      }
    }

    const participantsRaw = data.participants ?? data.participant ?? null;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw
      : (participantsRaw ? [participantsRaw] : []);

    const processed = [];
    const skipped = [];

    for (const participant of participants) {
      const phoneLast10 = last10Digits(participant);
      if (!phoneLast10) {
        skipped.push({ participant, reason: 'no_phone' });
        continue;
      }

      let application = await findApplicationByPhone(pool, phoneLast10);

      // Fallback to email from other tables (business_owners / samcart_orders), then find application by email
      if (!application) {
        const fallbackEmail = await findEmailByPhoneFallback(pool, phoneLast10);
        if (fallbackEmail) {
          const byEmail = await pool.query(
            `
              SELECT id, email, first_name, last_name, whatsapp_joined_at
              FROM typeform_applications
              WHERE LOWER(email) = LOWER($1)
              ORDER BY created_at DESC
              LIMIT 1
            `,
            [fallbackEmail]
          );
          application = byEmail.rows[0] || null;
        }
      }

      if (!application) {
        skipped.push({ participant: phoneLast10, reason: 'no_matching_application' });
        continue;
      }

      const { didUpdate } = await markWhatsAppJoined(pool, application, payload);

      // Only post to Slack on the first join update (avoid webhook redelivery spam)
      if (didUpdate) {
        const displayName = [application.first_name, application.last_name].filter(Boolean).join(' ').trim();
        try {
          await postJoinedToNotificationsThread(pool, application.email, displayName, phoneLast10);
        } catch (e) {
          console.error('[Wasender] Failed posting WhatsApp-joined Slack message:', e.message);
        }
      }

      processed.push({ participant: phoneLast10, application_id: application.id, did_update: didUpdate });
    }

    res.json({
      received: true,
      event: eventName,
      action: action || null,
      processed_count: processed.length,
      skipped_count: skipped.length,
      processed,
      skipped
    });
  } catch (error) {
    console.error('Wasender webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Wasender webhook endpoint is active', timestamp: new Date().toISOString() });
});

module.exports = router;
