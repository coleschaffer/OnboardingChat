const { addGroupParticipants, normalizePhoneForWasender } = require('./wasender-client');
const { resolveGroupsByKeys } = require('./whatsapp-groups');

function buildWhatsAppAddSummary({ label, groupResults, participantsCount, skipped, missingGroupKeys, hideParticipantCount = false }) {
  const lines = [`📱 WhatsApp add requested: ${label}`];

  if (!hideParticipantCount && participantsCount != null) {
    lines.push(`• Participants: ${participantsCount}`);
  }

  if (missingGroupKeys && missingGroupKeys.length > 0) {
    lines.push(`• Missing group JIDs: ${missingGroupKeys.join(', ')}`);
  }

  for (const { group, result } of groupResults) {
    const statusLabel = result?.success ? 'ok' : 'failed';
    const already = result?.already ? ' (already in group)' : '';
    const errorText = result?.success ? '' : ` — ${result?.error || 'error'}`;
    lines.push(`• ${group.name}: ${statusLabel}${already}${errorText}`);
  }

  if (skipped && skipped.length > 0) {
    const skippedLines = skipped.map(entry => `• ${entry.name || 'Unknown'} (${entry.email || 'no email'})`);
    lines.push(`⚠️ Skipped (missing phone):\n${skippedLines.join('\n')}`);
  }

  return lines.join('\n');
}

async function addContactsToGroups({ contacts = [], groupKeys = [] }) {
  const groups = resolveGroupsByKeys(groupKeys);
  const configuredKeys = new Set(groups.map(group => group.key));
  const missingGroupKeys = groupKeys.filter(key => !configuredKeys.has(key));

  const skipped = [];
  const participants = new Map();

  for (const contact of contacts) {
    const normalized = normalizePhoneForWasender(contact.phone);
    if (!normalized) {
      skipped.push({ name: contact.name, email: contact.email });
      continue;
    }
    if (!participants.has(normalized)) {
      participants.set(normalized, contact);
    }
  }

  const participantList = Array.from(participants.keys());
  const groupResults = [];

  for (const group of groups) {
    const result = await addGroupParticipants(group.jid, participantList);
    groupResults.push({ group, result });
  }

  return {
    groupResults,
    participants: participantList,
    skipped,
    missingGroupKeys
  };
}

module.exports = {
  addContactsToGroups,
  buildWhatsAppAddSummary
};
