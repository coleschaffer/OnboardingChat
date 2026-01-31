// Cron worker for Railway
// This script is called by Railway cron and triggers the delayed welcome processing

const BASE_URL = process.env.BASE_URL || 'https://onboarding.copyaccelerator.com';
const CRON_SECRET = process.env.CRON_SECRET;

async function processDelayedWelcomes() {
  console.log('Running delayed welcome processor...');
  console.log('Time:', new Date().toISOString());

  if (!CRON_SECRET) {
    console.error('CRON_SECRET not configured');
    process.exit(1);
  }

  try {
    const response = await fetch(`${BASE_URL}/api/jobs/process-delayed-welcomes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': CRON_SECRET
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error response:', data);
      process.exit(1);
    }

    console.log('Result:', JSON.stringify(data, null, 2));
    console.log('Completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error calling delayed welcome endpoint:', error.message);
    process.exit(1);
  }
}

processDelayedWelcomes();
