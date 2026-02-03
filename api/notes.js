/**
 * Application Notes API
 * CRUD operations for notes on typeform applications
 */

const express = require('express');
const router = express.Router();
const { postNoteToThread } = require('./slack-threads');

/**
 * GET /api/notes/:applicationId
 * Get all notes for an application
 */
router.get('/:applicationId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { applicationId } = req.params;

    try {
        const result = await pool.query(
            `SELECT id, note_text, created_by, slack_synced, created_at
             FROM application_notes
             WHERE application_id = $1
             ORDER BY created_at DESC`,
            [applicationId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching notes:', error);
        res.status(500).json({ error: 'Failed to fetch notes' });
    }
});

/**
 * POST /api/notes/:applicationId
 * Add a note to an application
 */
router.post('/:applicationId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { applicationId } = req.params;
    const { note_text, created_by = 'admin' } = req.body;

    if (!note_text || !note_text.trim()) {
        return res.status(400).json({ error: 'Note text is required' });
    }

    try {
        // Verify application exists
        const appResult = await pool.query(
            'SELECT id FROM typeform_applications WHERE id = $1',
            [applicationId]
        );

        if (appResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        // Insert the note
        const result = await pool.query(
            `INSERT INTO application_notes (application_id, note_text, created_by)
             VALUES ($1, $2, $3)
             RETURNING id, note_text, created_by, slack_synced, created_at`,
            [applicationId, note_text.trim(), created_by]
        );

        const note = result.rows[0];

        // Try to sync to Slack thread
        let slackSynced = false;
        try {
            const slackResponse = await postNoteToThread(
                pool,
                applicationId,
                note_text.trim(),
                created_by,
                note.created_at
            );

            if (slackResponse) {
                // Update note with slack sync status
                await pool.query(
                    `UPDATE application_notes SET slack_synced = true, slack_message_ts = $1 WHERE id = $2`,
                    [slackResponse.ts, note.id]
                );
                slackSynced = true;
            }
        } catch (slackError) {
            console.error('Failed to sync note to Slack:', slackError.message);
            // Don't fail the request - note is still saved
        }

        // Log activity
        await pool.query(
            'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4)',
            ['note_added', 'typeform_application', applicationId, JSON.stringify({
                note_id: note.id,
                created_by: created_by,
                slack_synced: slackSynced
            })]
        );

        res.status(201).json({
            ...note,
            slack_synced: slackSynced
        });
    } catch (error) {
        console.error('Error adding note:', error);
        res.status(500).json({ error: 'Failed to add note' });
    }
});

/**
 * DELETE /api/notes/:noteId
 * Delete a note
 */
router.delete('/:noteId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { noteId } = req.params;

    try {
        const result = await pool.query(
            'DELETE FROM application_notes WHERE id = $1 RETURNING id, application_id',
            [noteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Note not found' });
        }

        res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
        console.error('Error deleting note:', error);
        res.status(500).json({ error: 'Failed to delete note' });
    }
});

module.exports = router;
