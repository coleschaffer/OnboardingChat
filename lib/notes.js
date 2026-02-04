/**
 * Application Notes Helpers
 *
 * Shared logic for creating notes and syncing them into Slack threads.
 */

const { postNoteToThread, postNoteToPurchaseThread } = require('../api/slack-threads');

async function logNoteAdded(pool, applicationId, noteId, createdBy, syncStatus) {
  try {
    await pool.query(
      'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
      [
        'note_added',
        'typeform_application',
        applicationId,
        JSON.stringify({
          note_id: noteId,
          created_by: createdBy,
          ...syncStatus
        })
      ]
    );
  } catch (logError) {
    console.error('Failed to log note_added activity:', logError.message);
  }
}

/**
 * Create a note record (DB only).
 * Returns the inserted note and the application's email (for purchase thread mirroring).
 */
async function createApplicationNote({ pool, applicationId, noteText, createdBy = 'admin' }) {
  const trimmed = (noteText || '').trim();
  if (!trimmed) {
    throw new Error('Note text is required');
  }

  const appResult = await pool.query(
    'SELECT id, email FROM typeform_applications WHERE id = $1',
    [applicationId]
  );
  if (appResult.rows.length === 0) {
    const error = new Error('Application not found');
    error.code = 'APPLICATION_NOT_FOUND';
    throw error;
  }

  const application = appResult.rows[0];

  const result = await pool.query(
    `INSERT INTO application_notes (application_id, note_text, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, application_id, note_text, created_by, slack_synced, created_at`,
    [applicationId, trimmed, createdBy]
  );

  return { note: result.rows[0], applicationEmail: application.email };
}

/**
 * Best-effort sync for an existing note into Slack threads.
 */
async function syncApplicationNoteToSlack({ pool, applicationId, applicationEmail, noteId, noteText, createdBy, createdAt }) {
  let applicationSlackSynced = false;
  let applicationSlackMessageTs = null;

  try {
    const slackResponse = await postNoteToThread(pool, applicationId, noteText, createdBy, createdAt);
    if (slackResponse?.ts) {
      await pool.query(
        'UPDATE application_notes SET slack_synced = true, slack_message_ts = $1 WHERE id = $2',
        [slackResponse.ts, noteId]
      );
      applicationSlackSynced = true;
      applicationSlackMessageTs = slackResponse.ts;
    }
  } catch (slackError) {
    console.error('Failed to sync note to application Slack thread:', slackError.message);
  }

  let purchaseSlackSynced = false;
  let purchaseSlackMessageTs = null;

  try {
    const purchaseResponse = await postNoteToPurchaseThread(pool, applicationEmail, noteText, createdBy, createdAt);
    if (purchaseResponse?.ts) {
      purchaseSlackSynced = true;
      purchaseSlackMessageTs = purchaseResponse.ts;
    }
  } catch (slackError) {
    console.error('Failed to sync note to purchase Slack thread:', slackError.message);
  }

  return {
    slack_application_synced: applicationSlackSynced,
    slack_application_message_ts: applicationSlackMessageTs,
    slack_purchase_synced: purchaseSlackSynced,
    slack_purchase_message_ts: purchaseSlackMessageTs
  };
}

/**
 * Add an application note and (best-effort) sync to Slack.
 *
 * @param {Object} params
 * @param {Object} params.pool - pg Pool
 * @param {string} params.applicationId - typeform_applications.id
 * @param {string} params.noteText - note body
 * @param {string} params.createdBy - display name for who created the note
 * @returns {Promise<Object>} note row + sync flags
 */
async function addApplicationNote({ pool, applicationId, noteText, createdBy = 'admin' }) {
  const { note, applicationEmail } = await createApplicationNote({
    pool,
    applicationId,
    noteText,
    createdBy
  });

  const syncStatus = await syncApplicationNoteToSlack({
    pool,
    applicationId,
    applicationEmail,
    noteId: note.id,
    noteText: note.note_text,
    createdBy: note.created_by,
    createdAt: note.created_at
  });

  await logNoteAdded(pool, applicationId, note.id, note.created_by, syncStatus);

  return { ...note, ...syncStatus };
}

module.exports = {
  createApplicationNote,
  syncApplicationNoteToSlack,
  addApplicationNote
};
