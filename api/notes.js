/**
 * Application Notes API
 * CRUD operations for notes on typeform applications
 */

const express = require('express');
const router = express.Router();
const { addApplicationNote } = require('../lib/notes');

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

    try {
        const note = await addApplicationNote({
            pool,
            applicationId,
            noteText: note_text,
            createdBy: created_by
        });

        res.status(201).json(note);
    } catch (error) {
        console.error('Error adding note:', error);
        if (error.code === 'APPLICATION_NOT_FOUND') {
            return res.status(404).json({ error: 'Application not found' });
        }
        if (error.message === 'Note text is required') {
            return res.status(400).json({ error: 'Note text is required' });
        }
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
