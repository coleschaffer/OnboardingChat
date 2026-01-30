// Typeform API Client for fetching existing responses

const TYPEFORM_API_BASE = 'https://api.typeform.com';

class TypeformClient {
  constructor(token, formId) {
    this.token = token || process.env.TYPEFORM_TOKEN;
    this.formId = formId || process.env.TYPEFORM_FORM_ID || 'q6umv3xg';
  }

  async fetchResponses(options = {}) {
    const { pageSize = 100, since, until, after } = options;

    let url = `${TYPEFORM_API_BASE}/forms/${this.formId}/responses?page_size=${pageSize}`;

    if (since) url += `&since=${since}`;
    if (until) url += `&until=${until}`;
    if (after) url += `&after=${after}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Typeform API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async fetchAllResponses() {
    const allResponses = [];
    let hasMore = true;
    let after = null;

    while (hasMore) {
      const data = await this.fetchResponses({ after });
      allResponses.push(...data.items);

      if (data.items.length < 100) {
        hasMore = false;
      } else {
        // Get the token of the last response for pagination
        after = data.items[data.items.length - 1].token;
      }
    }

    return allResponses;
  }

  async getFormDefinition() {
    const response = await fetch(`${TYPEFORM_API_BASE}/forms/${this.formId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Typeform API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // Parse a single Typeform response into our application format
  parseResponse(formResponse) {
    const answers = formResponse.answers || [];
    const answersMap = {};

    // Build a map of field ref to answer
    for (const answer of answers) {
      const ref = answer.field?.ref;
      if (!ref) continue;

      let value;
      switch (answer.type) {
        case 'text':
        case 'short_text':
        case 'long_text':
          value = answer.text;
          break;
        case 'email':
          value = answer.email;
          break;
        case 'phone_number':
          value = answer.phone_number;
          break;
        case 'number':
          value = answer.number;
          break;
        case 'boolean':
          value = answer.boolean;
          break;
        case 'choice':
          value = answer.choice?.label;
          break;
        case 'choices':
          value = answer.choices?.labels?.join(', ');
          break;
        case 'date':
          value = answer.date;
          break;
        default:
          value = answer.text || answer[answer.type];
      }

      answersMap[ref] = value;
    }

    return {
      typeform_response_id: formResponse.token,
      submitted_at: formResponse.submitted_at,
      answers: answersMap,
      raw: formResponse
    };
  }
}

// Sync Typeform responses to database
async function syncTypeformResponses(pool) {
  if (!process.env.TYPEFORM_TOKEN) {
    console.log('TYPEFORM_TOKEN not configured, skipping sync');
    return { synced: 0, skipped: 0, errors: [] };
  }

  const client = new TypeformClient();
  const errors = [];
  let synced = 0;
  let skipped = 0;

  try {
    console.log('Fetching Typeform responses...');
    const responses = await client.fetchAllResponses();
    console.log(`Found ${responses.length} responses`);

    for (const response of responses) {
      try {
        const parsed = client.parseResponse(response);

        // Check if already exists
        const existing = await pool.query(
          'SELECT id FROM typeform_applications WHERE typeform_response_id = $1',
          [parsed.typeform_response_id]
        );

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Extract common fields (adjust field refs based on your form)
        const firstName = parsed.answers['first_name'] || parsed.answers['name']?.split(' ')[0] || '';
        const lastName = parsed.answers['last_name'] || parsed.answers['name']?.split(' ').slice(1).join(' ') || '';

        await pool.query(`
          INSERT INTO typeform_applications (
            typeform_response_id,
            first_name,
            last_name,
            email,
            phone,
            business_description,
            annual_revenue,
            main_challenge,
            why_ca_pro,
            raw_data,
            status,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          parsed.typeform_response_id,
          firstName,
          lastName,
          parsed.answers['email'] || '',
          parsed.answers['phone'] || parsed.answers['phone_number'] || '',
          parsed.answers['business_description'] || parsed.answers['business'] || '',
          parsed.answers['annual_revenue'] || parsed.answers['revenue'] || '',
          parsed.answers['main_challenge'] || parsed.answers['challenge'] || '',
          parsed.answers['why_ca_pro'] || parsed.answers['why_join'] || '',
          JSON.stringify(parsed.raw),
          'new',
          parsed.submitted_at
        ]);

        synced++;
      } catch (err) {
        errors.push({ response_id: response.token, error: err.message });
      }
    }

    // Log activity
    if (synced > 0) {
      await pool.query(`
        INSERT INTO activity_log (action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4)
      `, ['typeform_sync', 'application', null, JSON.stringify({ synced, skipped, errors: errors.length })]);
    }

    console.log(`Typeform sync complete: ${synced} synced, ${skipped} skipped, ${errors.length} errors`);

    return { synced, skipped, errors };
  } catch (error) {
    console.error('Typeform sync error:', error);
    throw error;
  }
}

module.exports = {
  TypeformClient,
  syncTypeformResponses
};
