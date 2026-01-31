/**
 * Circle.so Integration Module
 *
 * Adds team members and partners to Circle communities when they're submitted during onboarding.
 *
 * Environment Variables Required (add to Railway):
 * - CIRCLE_TOKEN_CA: API token for Copy Accelerator community (members.copyaccelerator.com)
 * - CIRCLE_TOKEN_SPG: API token for Stefan Paul Georgi community (members.stefanpaulgeorgi.com)
 */

// Circle Community Configuration
const CIRCLE_CONFIG = {
  // Copy Accelerator Community (members.copyaccelerator.com)
  CA: {
    communityId: 60481,
    baseUrl: 'https://app.circle.so/api/admin/v2',
    tokenEnvVar: 'CIRCLE_TOKEN_CA',
    // Fallback token (should use env var in production)
    fallbackToken: 'kNEbB1x5Z5Sv5UjAEkborf6t77PoZF3c',
    accessGroups: {
      teamMembers: 4159,    // 'CA Pro Team Members' access group
      partners: 4160        // 'CA Pro Business Owners' access group
    }
  },
  // Stefan Paul Georgi Community (members.stefanpaulgeorgi.com)
  SPG: {
    communityId: 365579,
    baseUrl: 'https://app.circle.so/api/admin/v2',
    tokenEnvVar: 'CIRCLE_TOKEN_SPG',
    // Fallback token (should use env var in production)
    fallbackToken: 'pF3ErkKm3aj8xj4Z7w4UGSav6A9qAijd',
    accessGroups: {
      // Both team members and partners go to 'CA Pro' access group
      teamMembers: 38043,
      partners: 38043
    }
  }
};

/**
 * Get the API token for a Circle community
 * @param {string} community - 'CA' or 'SPG'
 * @returns {string} The API token
 */
function getCircleToken(community) {
  const config = CIRCLE_CONFIG[community];
  if (!config) {
    throw new Error(`Unknown Circle community: ${community}`);
  }

  // Prefer environment variable, fallback to hardcoded token
  return process.env[config.tokenEnvVar] || config.fallbackToken;
}

/**
 * Add a member to a Circle community with specific access group
 * @param {Object} options
 * @param {string} options.community - 'CA' or 'SPG'
 * @param {string} options.email - Member's email address
 * @param {string} options.name - Member's name
 * @param {number} options.spaceGroupId - The access/space group ID to add the member to
 * @returns {Promise<Object>} Result object with success status and details
 */
async function addMemberToCircle({ community, email, name, spaceGroupId }) {
  const config = CIRCLE_CONFIG[community];
  if (!config) {
    return { success: false, error: `Unknown Circle community: ${community}` };
  }

  const token = getCircleToken(community);
  if (!token) {
    return { success: false, error: `No API token configured for ${community}` };
  }

  // Parse name into first and last name
  const nameParts = (name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  try {
    const response = await fetch(`${config.baseUrl}/community_members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`
      },
      body: JSON.stringify({
        community_id: config.communityId,
        email: email,
        name: name,
        first_name: firstName,
        last_name: lastName,
        space_group_ids: [spaceGroupId],
        skip_invitation: false  // Send invitation email
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`[Circle] Successfully added ${email} to ${community} community (space group ${spaceGroupId})`);
      return {
        success: true,
        community,
        email,
        spaceGroupId,
        message: data.message || 'Member added successfully'
      };
    } else {
      // Check if it's a duplicate (member already exists) - this is not an error
      const errorMessage = data.message || data.error || JSON.stringify(data);
      if (errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('exists') ||
          errorMessage.toLowerCase().includes('duplicate')) {
        console.log(`[Circle] Member ${email} already exists in ${community} - continuing`);
        return {
          success: true,
          community,
          email,
          spaceGroupId,
          message: 'Member already exists',
          alreadyExists: true
        };
      }

      console.error(`[Circle] Failed to add ${email} to ${community}: ${errorMessage}`);
      return {
        success: false,
        community,
        email,
        spaceGroupId,
        error: errorMessage
      };
    }
  } catch (error) {
    console.error(`[Circle] Error adding ${email} to ${community}:`, error.message);
    return {
      success: false,
      community,
      email,
      spaceGroupId,
      error: error.message
    };
  }
}

/**
 * Sync team members to Circle communities
 * Team members are added to:
 * - CA: 'CA Pro Team Members' access group (ID: 4159)
 * - SPG: 'CA Pro' access group (ID: 38043)
 *
 * @param {Array} teamMembers - Array of team member objects with name and email
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<Object>} Results object with success count and errors
 */
async function syncTeamMembersToCircle(teamMembers, pool = null) {
  if (!teamMembers || teamMembers.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`[Circle] Syncing ${teamMembers.length} team member(s) to Circle communities`);

  const results = {
    synced: 0,
    errors: []
  };

  for (const member of teamMembers) {
    if (!member.email) {
      console.log(`[Circle] Skipping team member without email: ${member.name || 'Unknown'}`);
      continue;
    }

    // Add to Copy Accelerator community
    const caResult = await addMemberToCircle({
      community: 'CA',
      email: member.email,
      name: member.name || `${member.firstName || ''} ${member.lastName || ''}`.trim(),
      spaceGroupId: CIRCLE_CONFIG.CA.accessGroups.teamMembers
    });

    if (caResult.success) {
      results.synced++;
    } else {
      results.errors.push({
        community: 'CA',
        email: member.email,
        error: caResult.error
      });
    }

    // Add to Stefan Paul Georgi community
    const spgResult = await addMemberToCircle({
      community: 'SPG',
      email: member.email,
      name: member.name || `${member.firstName || ''} ${member.lastName || ''}`.trim(),
      spaceGroupId: CIRCLE_CONFIG.SPG.accessGroups.teamMembers
    });

    if (spgResult.success) {
      results.synced++;
    } else {
      results.errors.push({
        community: 'SPG',
        email: member.email,
        error: spgResult.error
      });
    }
  }

  // Log failures to activity_log if we have a pool
  if (pool && results.errors.length > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'circle_sync_failed',
        'team_member',
        null,
        JSON.stringify({
          type: 'team_members',
          errors: results.errors,
          total_attempted: teamMembers.length
        })
      ]);
    } catch (logError) {
      console.error('[Circle] Failed to log sync errors:', logError.message);
    }
  }

  console.log(`[Circle] Team member sync complete: ${results.synced} successful, ${results.errors.length} errors`);
  return results;
}

/**
 * Sync partners (C-Level Partners) to Circle communities
 * Partners are added to:
 * - CA: 'CA Pro Business Owners' access group (ID: 4160)
 * - SPG: 'CA Pro' access group (ID: 38043)
 *
 * @param {Array} partners - Array of partner objects with name and email
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<Object>} Results object with success count and errors
 */
async function syncPartnersToCircle(partners, pool = null) {
  if (!partners || partners.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`[Circle] Syncing ${partners.length} partner(s) to Circle communities`);

  const results = {
    synced: 0,
    errors: []
  };

  for (const partner of partners) {
    if (!partner.email) {
      console.log(`[Circle] Skipping partner without email: ${partner.name || 'Unknown'}`);
      continue;
    }

    // Add to Copy Accelerator community
    const caResult = await addMemberToCircle({
      community: 'CA',
      email: partner.email,
      name: partner.name || `${partner.firstName || ''} ${partner.lastName || ''}`.trim(),
      spaceGroupId: CIRCLE_CONFIG.CA.accessGroups.partners
    });

    if (caResult.success) {
      results.synced++;
    } else {
      results.errors.push({
        community: 'CA',
        email: partner.email,
        error: caResult.error
      });
    }

    // Add to Stefan Paul Georgi community
    const spgResult = await addMemberToCircle({
      community: 'SPG',
      email: partner.email,
      name: partner.name || `${partner.firstName || ''} ${partner.lastName || ''}`.trim(),
      spaceGroupId: CIRCLE_CONFIG.SPG.accessGroups.partners
    });

    if (spgResult.success) {
      results.synced++;
    } else {
      results.errors.push({
        community: 'SPG',
        email: partner.email,
        error: spgResult.error
      });
    }
  }

  // Log failures to activity_log if we have a pool
  if (pool && results.errors.length > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'circle_sync_failed',
        'partner',
        null,
        JSON.stringify({
          type: 'partners',
          errors: results.errors,
          total_attempted: partners.length
        })
      ]);
    } catch (logError) {
      console.error('[Circle] Failed to log sync errors:', logError.message);
    }
  }

  console.log(`[Circle] Partner sync complete: ${results.synced} successful, ${results.errors.length} errors`);
  return results;
}

/**
 * Sync both team members and partners to Circle communities
 * This is the main function to call from the onboarding flow
 *
 * @param {Array} teamMembers - Array of team member objects
 * @param {Array} partners - Array of partner objects
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<Object>} Combined results
 */
async function syncAllToCircle(teamMembers, partners, pool = null) {
  console.log('[Circle] Starting sync to Circle communities...');

  const [teamResults, partnerResults] = await Promise.all([
    syncTeamMembersToCircle(teamMembers, pool),
    syncPartnersToCircle(partners, pool)
  ]);

  const combined = {
    teamMembers: teamResults,
    partners: partnerResults,
    totalSynced: teamResults.synced + partnerResults.synced,
    totalErrors: teamResults.errors.length + partnerResults.errors.length
  };

  console.log(`[Circle] Sync complete - Total: ${combined.totalSynced} synced, ${combined.totalErrors} errors`);
  return combined;
}

module.exports = {
  addMemberToCircle,
  syncTeamMembersToCircle,
  syncPartnersToCircle,
  syncAllToCircle,
  CIRCLE_CONFIG
};
