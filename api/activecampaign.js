/**
 * ActiveCampaign Integration Module
 *
 * Syncs contacts (Team Members and Partners) to ActiveCampaign
 * with appropriate tags and list memberships.
 */

const ACTIVECAMPAIGN_API_KEY = process.env.ACTIVECAMPAIGN_API_KEY;
const ACTIVECAMPAIGN_URI = process.env.ACTIVECAMPAIGN_URI;

// Tag and List IDs
const CONFIG = {
  teamMembers: {
    tags: [63, 264], // CA PRO, CA PRO | Team Members
    lists: [49, 102] // Members - CA PRO, Members - CA PRO (Team Members)
  },
  partners: {
    tags: [63, 265], // CA PRO, CA PRO | Business Owners
    lists: [49, 56]  // Members - CA PRO, Members - CA PRO (Business Owners)
  }
};

/**
 * Check if ActiveCampaign is configured
 */
function isConfigured() {
  return !!(ACTIVECAMPAIGN_API_KEY && ACTIVECAMPAIGN_URI);
}

/**
 * Make an API request to ActiveCampaign
 */
async function apiRequest(endpoint, method = 'GET', body = null) {
  const url = `${ACTIVECAMPAIGN_URI}/api/3/${endpoint}`;

  const options = {
    method,
    headers: {
      'Api-Token': ACTIVECAMPAIGN_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`ActiveCampaign API error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Create or update a contact in ActiveCampaign using the sync endpoint
 * @param {string} email - Contact email
 * @param {string} firstName - Contact first name
 * @param {string} lastName - Contact last name (optional)
 * @returns {Promise<{contactId: string}>}
 */
async function syncContact(email, firstName, lastName = '') {
  const response = await apiRequest('contact/sync', 'POST', {
    contact: {
      email,
      firstName,
      lastName
    }
  });

  return { contactId: response.contact.id };
}

/**
 * Add a tag to a contact
 * @param {string} contactId - ActiveCampaign contact ID
 * @param {number} tagId - Tag ID to add
 */
async function addTagToContact(contactId, tagId) {
  await apiRequest('contactTags', 'POST', {
    contactTag: {
      contact: contactId,
      tag: tagId
    }
  });
}

/**
 * Add a contact to a list
 * @param {string} contactId - ActiveCampaign contact ID
 * @param {number} listId - List ID to add contact to
 */
async function addContactToList(contactId, listId) {
  await apiRequest('contactLists', 'POST', {
    contactList: {
      list: listId,
      contact: contactId,
      status: 1 // 1 = subscribed
    }
  });
}

/**
 * Sync a single contact with all their tags and lists
 * @param {Object} contact - Contact object with name and email
 * @param {string} type - Either 'teamMember' or 'partner'
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<{success: boolean, contactId?: string, error?: string}>}
 */
async function syncSingleContact(contact, type, pool = null) {
  try {
    // Parse name into first/last
    const nameParts = (contact.name || '').trim().split(' ');
    const firstName = contact.firstName || nameParts[0] || '';
    const lastName = contact.lastName || nameParts.slice(1).join(' ') || '';
    const email = contact.email;

    if (!email) {
      console.log(`ActiveCampaign: Skipping contact without email`);
      return { success: false, error: 'No email provided' };
    }

    // Get config based on type
    const config = type === 'teamMember' ? CONFIG.teamMembers : CONFIG.partners;

    // Create/update contact
    const { contactId } = await syncContact(email, firstName, lastName);
    console.log(`ActiveCampaign: Synced contact ${email} (ID: ${contactId})`);

    // Add tags
    for (const tagId of config.tags) {
      try {
        await addTagToContact(contactId, tagId);
        console.log(`ActiveCampaign: Added tag ${tagId} to contact ${contactId}`);
      } catch (tagError) {
        // Tag might already exist, log but continue
        console.log(`ActiveCampaign: Tag ${tagId} may already exist for contact ${contactId}`);
      }
    }

    // Add to lists
    for (const listId of config.lists) {
      try {
        await addContactToList(contactId, listId);
        console.log(`ActiveCampaign: Added contact ${contactId} to list ${listId}`);
      } catch (listError) {
        // Already on list, log but continue
        console.log(`ActiveCampaign: Contact ${contactId} may already be on list ${listId}`);
      }
    }

    return { success: true, contactId };
  } catch (error) {
    console.error(`ActiveCampaign: Error syncing contact ${contact.email}:`, error.message);

    // Log to activity_log if pool is available
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, [
          'activecampaign_sync_failed',
          type,
          null,
          JSON.stringify({
            email: contact.email,
            name: contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
            error: error.message
          })
        ]);
      } catch (logError) {
        console.error('ActiveCampaign: Failed to log error to activity_log:', logError.message);
      }
    }

    return { success: false, error: error.message };
  }
}

/**
 * Sync team members to ActiveCampaign
 * @param {Array} teamMembers - Array of team member objects with name and email
 * @param {Object} pool - Database pool for logging
 */
async function syncTeamMembers(teamMembers, pool = null) {
  if (!isConfigured()) {
    console.log('ActiveCampaign: Not configured, skipping team member sync');
    return { synced: 0, errors: [] };
  }

  if (!teamMembers || teamMembers.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`ActiveCampaign: Syncing ${teamMembers.length} team member(s)`);

  const results = { synced: 0, errors: [] };

  for (const member of teamMembers) {
    const result = await syncSingleContact(member, 'teamMember', pool);
    if (result.success) {
      results.synced++;
    } else {
      results.errors.push({ email: member.email, error: result.error });
    }
  }

  // Log success to activity_log if we have a pool and synced contacts
  if (pool && results.synced > 0) {
    try {
      const syncedEmails = teamMembers.filter(m => m.email).map(m => m.email);
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'activecampaign_team_member_synced',
        'team_member',
        null,
        JSON.stringify({
          count: results.synced,
          emails: syncedEmails
        })
      ]);
    } catch (logError) {
      console.error('ActiveCampaign: Failed to log sync success:', logError.message);
    }
  }

  return results;
}

/**
 * Sync C-Level partners to ActiveCampaign
 * @param {Array} partners - Array of partner objects with name and email
 * @param {Object} pool - Database pool for logging
 */
async function syncPartners(partners, pool = null) {
  if (!isConfigured()) {
    console.log('ActiveCampaign: Not configured, skipping partner sync');
    return { synced: 0, errors: [] };
  }

  if (!partners || partners.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`ActiveCampaign: Syncing ${partners.length} partner(s)`);

  const results = { synced: 0, errors: [] };

  for (const partner of partners) {
    const result = await syncSingleContact(partner, 'partner', pool);
    if (result.success) {
      results.synced++;
    } else {
      results.errors.push({ email: partner.email, error: result.error });
    }
  }

  // Log success to activity_log if we have a pool and synced contacts
  if (pool && results.synced > 0) {
    try {
      const syncedEmails = partners.filter(p => p.email).map(p => p.email);
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'activecampaign_partner_synced',
        'partner',
        null,
        JSON.stringify({
          count: results.synced,
          emails: syncedEmails
        })
      ]);
    } catch (logError) {
      console.error('ActiveCampaign: Failed to log sync success:', logError.message);
    }
  }

  return results;
}

/**
 * Sync all contacts (team members and partners) to ActiveCampaign
 * This is the main entry point called from onboarding.js
 * @param {Array} teamMembers - Array of team member objects
 * @param {Array} cLevelPartners - Array of partner objects
 * @param {Object} pool - Database pool for logging
 */
async function syncOnboardingContacts(teamMembers, cLevelPartners, pool = null) {
  if (!isConfigured()) {
    console.log('ActiveCampaign: Not configured, skipping contact sync');
    return;
  }

  // Run syncs - don't throw errors to avoid blocking onboarding
  try {
    await syncTeamMembers(teamMembers, pool);
  } catch (error) {
    console.error('ActiveCampaign: Error syncing team members:', error.message);
  }

  try {
    await syncPartners(cLevelPartners, pool);
  } catch (error) {
    console.error('ActiveCampaign: Error syncing partners:', error.message);
  }
}

module.exports = {
  isConfigured,
  syncContact,
  addTagToContact,
  addContactToList,
  syncTeamMembers,
  syncPartners,
  syncOnboardingContacts
};
