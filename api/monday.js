/**
 * Monday.com Integration Module
 *
 * Syncs Team Members and Partners to Monday.com boards after OnboardingChat completion.
 * - Team Members are added to the "PRO Team Members" board
 * - Partners are added as Subitems to the Business Owner's row in "PRO Business Owners" board
 *
 * Environment Variables Required:
 * - MONDAY_API_TOKEN: API token from Monday.com
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';

// Board IDs
const BOARDS = {
  PRO_BUSINESS_OWNERS: '6400461985',
  PRO_TEAM_MEMBERS: '6414054485'
};

// Cache for column IDs (populated on first use)
let columnCache = {};

/**
 * Get the Monday.com API token
 */
function getToken() {
  return process.env.MONDAY_API_TOKEN;
}

/**
 * Check if Monday.com is configured
 */
function isConfigured() {
  return !!getToken();
}

/**
 * Make a GraphQL request to Monday.com API
 * @param {string} query - GraphQL query
 * @param {Object} variables - Query variables
 * @returns {Promise<Object>} Response data
 */
async function mondayRequest(query, variables = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('Monday.com API token not configured');
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (data.errors) {
    console.error('[Monday] GraphQL errors:', JSON.stringify(data.errors));
    throw new Error(data.errors[0]?.message || 'Monday.com API error');
  }

  return data.data;
}

/**
 * Get column IDs for a board
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Map of column title to column ID
 */
async function getColumnIds(boardId) {
  // Check cache first
  if (columnCache[boardId]) {
    return columnCache[boardId];
  }

  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await mondayRequest(query, { boardId: [boardId] });
  const columns = data.boards[0]?.columns || [];

  // Build map of title -> id
  const columnMap = {};
  for (const col of columns) {
    columnMap[col.title] = { id: col.id, type: col.type };
  }

  // Cache it
  columnCache[boardId] = columnMap;
  console.log(`[Monday] Cached ${Object.keys(columnMap).length} columns for board ${boardId}`);

  return columnMap;
}

/**
 * Find a Business Owner by email in the PRO Business Owners board
 * @param {string} email - Email to search for
 * @returns {Promise<Object|null>} Item data or null if not found
 */
async function findBusinessOwnerByEmail(email) {
  if (!email) return null;

  // Get column IDs to find the email column
  const columns = await getColumnIds(BOARDS.PRO_BUSINESS_OWNERS);
  const emailCol = columns['Email'];

  if (!emailCol) {
    console.error('[Monday] Email column not found on PRO Business Owners board');
    return null;
  }

  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values(
        board_id: $boardId,
        columns: [{ column_id: $columnId, column_values: [$value] }],
        limit: 1
      ) {
        items {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    }
  `;

  try {
    const data = await mondayRequest(query, {
      boardId: BOARDS.PRO_BUSINESS_OWNERS,
      columnId: emailCol.id,
      value: email.toLowerCase()
    });

    const items = data.items_page_by_column_values?.items || [];
    if (items.length > 0) {
      console.log(`[Monday] Found Business Owner: ${items[0].name} (ID: ${items[0].id})`);
      return items[0];
    }

    console.log(`[Monday] No Business Owner found with email: ${email}`);
    return null;
  } catch (error) {
    console.error(`[Monday] Error finding Business Owner by email ${email}:`, error.message);
    return null;
  }
}

/**
 * Check if a team member already exists in PRO Team Members board by email
 * @param {string} email - Email to search for
 * @returns {Promise<boolean>} True if exists
 */
async function teamMemberExistsInMonday(email) {
  if (!email) return false;

  const columns = await getColumnIds(BOARDS.PRO_TEAM_MEMBERS);
  const emailCol = columns['Email'];

  if (!emailCol) return false;

  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values(
        board_id: $boardId,
        columns: [{ column_id: $columnId, column_values: [$value] }],
        limit: 1
      ) {
        items { id }
      }
    }
  `;

  try {
    const data = await mondayRequest(query, {
      boardId: BOARDS.PRO_TEAM_MEMBERS,
      columnId: emailCol.id,
      value: email.toLowerCase()
    });
    return (data.items_page_by_column_values?.items || []).length > 0;
  } catch (error) {
    console.error(`[Monday] Error checking team member existence:`, error.message);
    return false;
  }
}

/**
 * Create an item on the PRO Team Members board
 * @param {Object} teamMember - Team member data
 * @param {string} businessOwnerId - Monday.com item ID of the Business Owner
 * @returns {Promise<Object>} Result
 */
async function createTeamMemberItem(teamMember, businessOwnerId) {
  const columns = await getColumnIds(BOARDS.PRO_TEAM_MEMBERS);

  // Build column values JSON
  const columnValues = {};

  // Email
  if (columns['Email'] && teamMember.email) {
    columnValues[columns['Email'].id] = { email: teamMember.email, text: teamMember.email };
  }

  // Title = 'Team Member'
  if (columns['Title']) {
    columnValues[columns['Title'].id] = 'Team Member';
  }

  // Onboarding Form = 'Completed' (status column)
  if (columns['Onboarding Form']) {
    columnValues[columns['Onboarding Form'].id] = { label: 'Completed' };
  }

  // Onboarding Meeting = 'N/A' (status column)
  if (columns['Onboarding Meeting']) {
    columnValues[columns['Onboarding Meeting'].id] = { label: 'N/A' };
  }

  // Feedback Request = 'No' (status column)
  if (columns['Feedback Request']) {
    columnValues[columns['Feedback Request'].id] = { label: 'No' };
  }

  // Status = 'Active' (status column)
  if (columns['Status']) {
    columnValues[columns['Status'].id] = { label: 'Active' };
  }

  // Product = 'CA PRO - FREE' (status column)
  if (columns['Product']) {
    columnValues[columns['Product'].id] = { label: 'CA PRO - FREE' };
  }

  // PRO Account Owners = linked to Business Owner (connect boards column)
  if (columns['PRO Account Owners'] && businessOwnerId) {
    columnValues[columns['PRO Account Owners'].id] = {
      item_ids: [parseInt(businessOwnerId)]
    };
  }

  const query = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;

  const itemName = teamMember.name || `${teamMember.firstName || ''} ${teamMember.lastName || ''}`.trim() || 'Unknown';

  const data = await mondayRequest(query, {
    boardId: BOARDS.PRO_TEAM_MEMBERS,
    itemName: itemName,
    columnValues: JSON.stringify(columnValues)
  });

  console.log(`[Monday] Created Team Member item: ${data.create_item.name} (ID: ${data.create_item.id})`);
  return data.create_item;
}

/**
 * Create a subitem (Partner) under a Business Owner item
 * @param {Object} partner - Partner data
 * @param {string} businessOwnerId - Monday.com item ID of the Business Owner
 * @returns {Promise<Object>} Result
 */
async function createPartnerSubitem(partner, businessOwnerId) {
  // For subitems, we need to get the subitem board's columns
  // The subitem board is automatically created when subitems are enabled

  // Build column values for subitem
  // Note: Subitem columns have different IDs, we'll use common ones
  const columnValues = {};

  // Email column for subitems
  if (partner.email) {
    // Try common email column IDs for subitems
    columnValues['email'] = { email: partner.email, text: partner.email };
  }

  // Role = 'Business Partners'
  columnValues['text'] = 'Business Partners';  // Often the first text column is 'Role'

  const query = `
    mutation ($parentItemId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_subitem(
        parent_item_id: $parentItemId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
        board {
          id
        }
      }
    }
  `;

  const itemName = partner.name || `${partner.firstName || ''} ${partner.lastName || ''}`.trim() || 'Unknown';

  try {
    const data = await mondayRequest(query, {
      parentItemId: businessOwnerId,
      itemName: itemName,
      columnValues: JSON.stringify(columnValues)
    });

    console.log(`[Monday] Created Partner subitem: ${data.create_subitem.name} (ID: ${data.create_subitem.id})`);
    return data.create_subitem;
  } catch (error) {
    // If column values fail, try creating without them and update separately
    console.log(`[Monday] Retrying subitem creation without column values...`);

    const simpleQuery = `
      mutation ($parentItemId: ID!, $itemName: String!) {
        create_subitem(
          parent_item_id: $parentItemId,
          item_name: $itemName
        ) {
          id
          name
          board {
            id
          }
        }
      }
    `;

    const data = await mondayRequest(simpleQuery, {
      parentItemId: businessOwnerId,
      itemName: itemName
    });

    // Now try to update columns if we got the subitem board ID
    if (data.create_subitem?.board?.id && partner.email) {
      try {
        await updateSubitemColumns(data.create_subitem.board.id, data.create_subitem.id, partner);
      } catch (updateError) {
        console.log(`[Monday] Could not update subitem columns: ${updateError.message}`);
      }
    }

    console.log(`[Monday] Created Partner subitem (simple): ${data.create_subitem.name} (ID: ${data.create_subitem.id})`);
    return data.create_subitem;
  }
}

/**
 * Update subitem columns after creation
 */
async function updateSubitemColumns(boardId, itemId, partner) {
  // Get the subitem board columns
  const columns = await getColumnIds(boardId);

  // Find email and role columns
  const emailCol = columns['Email'] || columns['email'];
  const roleCol = columns['Role'] || columns['role'] || columns['Notes'];

  if (emailCol && partner.email) {
    const query = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `;

    await mondayRequest(query, {
      boardId: boardId,
      itemId: itemId,
      columnId: emailCol.id,
      value: JSON.stringify({ email: partner.email, text: partner.email })
    });
  }

  if (roleCol) {
    const query = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `;

    await mondayRequest(query, {
      boardId: boardId,
      itemId: itemId,
      columnId: roleCol.id,
      value: 'Business Partners'
    });
  }
}

/**
 * Sync team members to Monday.com
 * @param {Array} teamMembers - Array of team member objects
 * @param {string} businessOwnerEmail - Email of the Business Owner
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<Object>} Results
 */
async function syncTeamMembersToMonday(teamMembers, businessOwnerEmail, pool = null) {
  if (!isConfigured()) {
    console.log('[Monday] Not configured, skipping team member sync');
    return { synced: 0, errors: [] };
  }

  if (!teamMembers || teamMembers.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`[Monday] Syncing ${teamMembers.length} team member(s)`);

  const results = { synced: 0, errors: [] };

  // Find the Business Owner first - required to link team members
  const businessOwner = await findBusinessOwnerByEmail(businessOwnerEmail);
  const businessOwnerId = businessOwner?.id;

  if (!businessOwnerId) {
    console.error(`[Monday] Cannot sync team members: Business Owner not found with email ${businessOwnerEmail}`);
    return {
      synced: 0,
      errors: [{ error: `Business Owner not found: ${businessOwnerEmail}` }],
      businessOwnerNotFound: true  // Flag to indicate retry needed
    };
  }

  for (const member of teamMembers) {
    try {
      // Check if team member already exists in Monday
      if (member.email && await teamMemberExistsInMonday(member.email)) {
        console.log(`[Monday] Team member ${member.email} already exists, skipping`);
        continue;
      }

      await createTeamMemberItem(member, businessOwnerId);
      results.synced++;
    } catch (error) {
      console.error(`[Monday] Error creating team member ${member.email}:`, error.message);
      results.errors.push({ email: member.email, error: error.message });
    }
  }

  // Log to activity_log
  if (pool && results.synced > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_team_member_synced',
        'team_member',
        null,
        JSON.stringify({
          count: results.synced,
          emails: teamMembers.filter(m => m.email).map(m => m.email),
          business_owner_email: businessOwnerEmail
        })
      ]);
    } catch (logError) {
      console.error('[Monday] Failed to log sync success:', logError.message);
    }
  }

  if (pool && results.errors.length > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_sync_failed',
        'team_member',
        null,
        JSON.stringify({
          type: 'team_members',
          errors: results.errors
        })
      ]);
    } catch (logError) {
      console.error('[Monday] Failed to log sync errors:', logError.message);
    }
  }

  console.log(`[Monday] Team member sync complete: ${results.synced} synced, ${results.errors.length} errors`);
  return results;
}

/**
 * Sync partners to Monday.com as subitems
 * @param {Array} partners - Array of partner objects
 * @param {string} businessOwnerEmail - Email of the Business Owner
 * @param {Object} pool - Database pool for logging
 * @returns {Promise<Object>} Results
 */
async function syncPartnersToMonday(partners, businessOwnerEmail, pool = null) {
  if (!isConfigured()) {
    console.log('[Monday] Not configured, skipping partner sync');
    return { synced: 0, errors: [] };
  }

  if (!partners || partners.length === 0) {
    return { synced: 0, errors: [] };
  }

  console.log(`[Monday] Syncing ${partners.length} partner(s) as subitems`);

  const results = { synced: 0, errors: [] };

  // Find the Business Owner - required for subitems
  const businessOwner = await findBusinessOwnerByEmail(businessOwnerEmail);

  if (!businessOwner) {
    console.error(`[Monday] Cannot sync partners: Business Owner not found with email ${businessOwnerEmail}`);
    return {
      synced: 0,
      errors: [{ error: `Business Owner not found: ${businessOwnerEmail}` }],
      businessOwnerNotFound: true  // Flag to indicate retry needed
    };
  }

  for (const partner of partners) {
    try {
      await createPartnerSubitem(partner, businessOwner.id);
      results.synced++;
    } catch (error) {
      console.error(`[Monday] Error creating partner subitem ${partner.email}:`, error.message);
      results.errors.push({ email: partner.email, error: error.message });
    }
  }

  // Log to activity_log
  if (pool && results.synced > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_partner_synced',
        'partner',
        null,
        JSON.stringify({
          count: results.synced,
          emails: partners.filter(p => p.email).map(p => p.email),
          business_owner_email: businessOwnerEmail,
          business_owner_id: businessOwner.id
        })
      ]);
    } catch (logError) {
      console.error('[Monday] Failed to log sync success:', logError.message);
    }
  }

  if (pool && results.errors.length > 0) {
    try {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, [
        'monday_sync_failed',
        'partner',
        null,
        JSON.stringify({
          type: 'partners',
          errors: results.errors
        })
      ]);
    } catch (logError) {
      console.error('[Monday] Failed to log sync errors:', logError.message);
    }
  }

  console.log(`[Monday] Partner sync complete: ${results.synced} synced, ${results.errors.length} errors`);
  return results;
}

/**
 * Sync all (team members and partners) to Monday.com
 * This is called 10 minutes after OnboardingChat completion
 * @param {Object} onboardingData - Full onboarding data including team members and partners
 * @param {string} businessOwnerEmail - Email of the Business Owner
 * @param {Object} pool - Database pool
 * @returns {Promise<Object>} Combined results
 */
async function syncOnboardingToMonday(onboardingData, businessOwnerEmail, pool = null) {
  if (!isConfigured()) {
    console.log('[Monday] Not configured, skipping sync');
    return { teamMembers: { synced: 0, errors: [] }, partners: { synced: 0, errors: [] } };
  }

  console.log(`[Monday] Starting sync for Business Owner: ${businessOwnerEmail}`);

  const teamMembers = onboardingData.teamMembers || [];
  const partners = onboardingData.cLevelPartners || onboardingData.partners || [];

  const [teamResults, partnerResults] = await Promise.all([
    syncTeamMembersToMonday(teamMembers, businessOwnerEmail, pool),
    syncPartnersToMonday(partners, businessOwnerEmail, pool)
  ]);

  const combined = {
    teamMembers: teamResults,
    partners: partnerResults,
    totalSynced: teamResults.synced + partnerResults.synced,
    totalErrors: teamResults.errors.length + partnerResults.errors.length
  };

  console.log(`[Monday] Sync complete - ${combined.totalSynced} synced, ${combined.totalErrors} errors`);
  return combined;
}

module.exports = {
  isConfigured,
  getColumnIds,
  findBusinessOwnerByEmail,
  createTeamMemberItem,
  createPartnerSubitem,
  syncTeamMembersToMonday,
  syncPartnersToMonday,
  syncOnboardingToMonday,
  BOARDS
};
