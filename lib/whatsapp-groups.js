const GROUP_DEFINITIONS = [
  { key: 'JID_AI', name: 'Copy Accelerator Pro AI Updates' },
  { key: 'JID_TM', name: 'Copy Accelerator Pro - Team Members' },
  { key: 'JID_BO', name: 'Copy Accelerator Business Owners' }
];

function getConfiguredGroups() {
  return GROUP_DEFINITIONS
    .map(group => ({
      ...group,
      jid: process.env[group.key] || null
    }))
    .filter(group => group.jid);
}

function resolveGroupKeysForRole(role) {
  if (role === 'team_member') {
    return ['JID_TM'];
  }

  if (role === 'partner' || role === 'business_owner') {
    return ['JID_AI', 'JID_BO', 'JID_TM'];
  }

  return [];
}

function resolveGroupsByKeys(keys = []) {
  const configured = getConfiguredGroups();
  const map = new Map(configured.map(group => [group.key, group]));
  return keys.map(key => map.get(key)).filter(Boolean);
}

module.exports = {
  GROUP_DEFINITIONS,
  getConfiguredGroups,
  resolveGroupKeysForRole,
  resolveGroupsByKeys
};
