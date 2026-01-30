const express = require('express');
const router = express.Router();

// Validate team count using Claude API
router.post('/validate-team-count', async (req, res) => {
  try {
    const { teamCount } = req.body;

    if (!teamCount) {
      return res.json({ hasTeamMembers: false });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('ANTHROPIC_API_KEY not set, using fallback logic');
      return res.json({ hasTeamMembers: fallbackCheck(teamCount) });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20250514',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: `A business owner was asked "How many team members do you currently have?" and they responded: "${teamCount}"

Does this response indicate they have 1 or more team members? Reply with only "yes" or "no".`
          }
        ]
      })
    });

    if (!response.ok) {
      console.error('Claude API error:', response.status);
      return res.json({ hasTeamMembers: fallbackCheck(teamCount) });
    }

    const data = await response.json();
    const answer = data.content[0]?.text?.toLowerCase().trim();
    const hasTeamMembers = answer === 'yes';

    console.log(`Team count validation: "${teamCount}" -> ${hasTeamMembers ? 'has team' : 'no team'}`);

    res.json({ hasTeamMembers });
  } catch (error) {
    console.error('Validation error:', error);
    res.json({ hasTeamMembers: fallbackCheck(req.body.teamCount) });
  }
});

// Fallback logic if API fails
function fallbackCheck(teamCount) {
  const tc = (teamCount || '').toLowerCase().trim();
  if (tc === '' || tc === '0' || tc === 'zero' || tc === 'none' || tc === 'no') {
    return false;
  }
  if (tc.includes('just me') || tc.includes('only me') || tc.includes('no team')) {
    return false;
  }
  return true;
}

module.exports = router;
