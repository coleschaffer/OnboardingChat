// Cron worker for Railway
// This script is called by Railway cron and triggers scheduled job processing

const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';
const CRON_SECRET = process.env.CRON_SECRET;

async function callJobEndpoint(endpoint, name) {
  console.log(`Processing ${name}...`);

  try {
    const response = await fetch(`${BASE_URL}/api/jobs/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': CRON_SECRET
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`${name} error response:`, data);
      return { success: false, error: data };
    }

    console.log(`${name} result:`, JSON.stringify(data, null, 2));
    return { success: true, data };
  } catch (error) {
    console.error(`Error calling ${name}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function runCronJobs() {
  console.log('Running cron jobs...');
  console.log('Time:', new Date().toISOString());

  if (!CRON_SECRET) {
    console.error('CRON_SECRET not configured');
    process.exit(1);
  }

  const results = {};

  // Process delayed welcomes (for members who didn't complete OnboardingChat after 1 hour)
  results.delayedWelcomes = await callJobEndpoint('process-delayed-welcomes', 'Delayed Welcomes');

  // Process Monday.com syncs (10 minutes after OnboardingChat completion)
  results.mondaySyncs = await callJobEndpoint('process-monday-syncs', 'Monday.com Syncs');

  console.log('\n=== Cron Jobs Summary ===');
  console.log('Delayed Welcomes:', results.delayedWelcomes.success ? 'OK' : 'FAILED');
  console.log('Monday.com Syncs:', results.mondaySyncs.success ? 'OK' : 'FAILED');

  const allSuccess = Object.values(results).every(r => r.success);
  console.log('\nCompleted', allSuccess ? 'successfully' : 'with errors');

  process.exit(allSuccess ? 0 : 1);
}

runCronJobs();
