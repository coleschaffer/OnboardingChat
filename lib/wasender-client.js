const DEFAULT_BASE_URL = 'https://www.wasenderapi.com/api';

function normalizePhoneForWasender(phone) {
  if (!phone) return null;
  const digits = phone.toString().replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) {
    return `1${digits}`;
  }
  return digits;
}

async function removeGroupParticipants(groupJid, participants = []) {
  const token = process.env.WASENDER_API_TOKEN;
  const baseUrl = process.env.WASENDER_API_BASE_URL || DEFAULT_BASE_URL;

  if (!token) {
    return { success: false, error: 'WASENDER_API_TOKEN not configured' };
  }

  if (!groupJid) {
    return { success: false, error: 'Missing group JID' };
  }

  const cleanParticipants = participants
    .map(normalizePhoneForWasender)
    .filter(Boolean);

  if (cleanParticipants.length === 0) {
    return { success: false, error: 'No valid participants to remove' };
  }

  try {
    const response = await fetch(`${baseUrl}/groups/${encodeURIComponent(groupJid)}/participants/remove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ participants: cleanParticipants })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: data.message || data.error || 'Wasender error', details: data };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function addGroupParticipants(groupJid, participants = []) {
  const token = process.env.WASENDER_API_TOKEN;
  const baseUrl = process.env.WASENDER_API_BASE_URL || DEFAULT_BASE_URL;

  if (!token) {
    return { success: false, error: 'WASENDER_API_TOKEN not configured' };
  }

  if (!groupJid) {
    return { success: false, error: 'Missing group JID' };
  }

  const cleanParticipants = participants
    .map(normalizePhoneForWasender)
    .filter(Boolean);

  if (cleanParticipants.length === 0) {
    return { success: false, error: 'No valid participants to add' };
  }

  try {
    const response = await fetch(`${baseUrl}/groups/${encodeURIComponent(groupJid)}/participants/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ participants: cleanParticipants })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data.message || data.error || 'Wasender error';
      if (typeof message === 'string' && /already|exists/i.test(message)) {
        return { success: true, already: true, data };
      }
      return { success: false, error: message, details: data };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  normalizePhoneForWasender,
  removeGroupParticipants,
  addGroupParticipants
};
