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
 * This is a two-step process:
 * 1. Create/invite the member to the community
 * 2. Add them to the specific access group
 *
 * @param {Object} options
 * @param {string} options.community - 'CA' or 'SPG'
 * @param {string} options.email - Member's email address
 * @param {string} options.name - Member's name
 * @param {number} options.accessGroupId - The access group ID to add the member to
 * @returns {Promise<Object>} Result object with success status and details
 */
async function addMemberToCircle({ community, email, name, accessGroupId }) {
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
    // Step 1: Create/invite the member to the community
    const createResponse = await fetch(`${config.baseUrl}/community_members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`
      },
      body: JSON.stringify({
        email: email,
        name: name || `${firstName} ${lastName}`.trim(),
        skip_invitation: false  // Send invitation email
      })
    });

    const createData = await createResponse.json();
    let memberCreated = false;
    let memberAlreadyExists = false;

    if (createResponse.ok) {
      console.log(`[Circle] Successfully invited ${email} to ${community} community`);
      memberCreated = true;
    } else {
      // Check if member already exists - this is fine, we still need to add to access group
      const errorMessage = createData.message || createData.error || JSON.stringify(createData);
      if (errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('exists') ||
          errorMessage.toLowerCase().includes('duplicate') ||
          errorMessage.toLowerCase().includes('member')) {
        console.log(`[Circle] Member ${email} already exists in ${community} - will add to access group`);
        memberAlreadyExists = true;
      } else {
        console.error(`[Circle] Failed to create member ${email} in ${community}: ${errorMessage}`);
        return {
          success: false,
          community,
          email,
          accessGroupId,
          error: errorMessage
        };
      }
    }

    // Step 2: Add member to the access group
    const accessGroupResponse = await fetch(`${config.baseUrl}/access_groups/${accessGroupId}/community_members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`
      },
      body: JSON.stringify({
        email: email
      })
    });

    const accessGroupData = await accessGroupResponse.json();

    if (accessGroupResponse.ok) {
      console.log(`[Circle] Successfully added ${email} to access group ${accessGroupId} in ${community}`);
      return {
        success: true,
        community,
        email,
        accessGroupId,
        message: accessGroupData.message || 'Member added to access group',
        memberCreated,
        memberAlreadyExists
      };
    } else {
      // Check if already in access group
      const errorMessage = accessGroupData.message || accessGroupData.error || JSON.stringify(accessGroupData);
      if (errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('exists')) {
        console.log(`[Circle] Member ${email} already in access group ${accessGroupId} in ${community}`);
        return {
          success: true,
          community,
          email,
          accessGroupId,
          message: 'Member already in access group',
          alreadyInGroup: true
        };
      }

      console.error(`[Circle] Failed to add ${email} to access group ${accessGroupId} in ${community}: ${errorMessage}`);
      return {
        success: false,
        community,
        email,
        accessGroupId,
        error: `Member invited but failed to add to access group: ${errorMessage}`
      };
    }
  } catch (error) {
    console.error(`[Circle] Error adding ${email} to ${community}:`, error.message);
    return {
      success: false,
      community,
      email,
      accessGroupId,
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
      accessGroupId: CIRCLE_CONFIG.CA.accessGroups.teamMembers
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
      accessGroupId: CIRCLE_CONFIG.SPG.accessGroups.teamMembers
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

  // Log to activity_log if we have a pool
  if (pool) {
    try {
      // Log successes
      if (results.synced > 0) {
        const syncedEmails = teamMembers.filter(m => m.email).map(m => m.email);
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, [
          'circle_team_member_synced',
          'team_member',
          null,
          JSON.stringify({
            count: teamMembers.length,
            emails: syncedEmails,
            communities: ['CA', 'SPG']
          })
        ]);
      }

      // Log failures
      if (results.errors.length > 0) {
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
      }
    } catch (logError) {
      console.error('[Circle] Failed to log activity:', logError.message);
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
      accessGroupId: CIRCLE_CONFIG.CA.accessGroups.partners
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
      accessGroupId: CIRCLE_CONFIG.SPG.accessGroups.partners
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

  // Log to activity_log if we have a pool
  if (pool) {
    try {
      // Log successes
      if (results.synced > 0) {
        const syncedEmails = partners.filter(p => p.email).map(p => p.email);
        await pool.query(`
          INSERT INTO activity_log (action, entity_type, entity_id, details)
          VALUES ($1, $2, $3, $4)
        `, [
          'circle_partner_synced',
          'partner',
          null,
          JSON.stringify({
            count: partners.length,
            emails: syncedEmails,
            communities: ['CA', 'SPG']
          })
        ]);
      }

      // Log failures
      if (results.errors.length > 0) {
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
      }
    } catch (logError) {
      console.error('[Circle] Failed to log activity:', logError.message);
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
