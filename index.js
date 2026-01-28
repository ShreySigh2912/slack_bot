import 'dotenv/config';
import pkg from '@slack/bolt';
import express from 'express';
const { App } = pkg;

/** @typedef {{ step: 'askName' | 'askBatch', name?: string }} UserState */

// In-memory state for simple OAuth state verification and DM conversation states
/** @type {Map<string, number>} */
const oauthStates = new Map(); // state -> timestamp

/** @type {Map<string, UserState>} */
const dmState = new Map();

// Store installations in memory (use a database in production)
/** @type {Map<string, { botToken: string, botUserId: string, teamId: string, installedAt: string }>} */
const installations = new Map();

// Validate required environment variables
const requiredEnvVars = [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URL,
  ANNOUNCE_CHANNEL_ID,
  LOBBY_CHANNEL_ID,
  BATCH2_CHANNEL_IDS,
  BATCH3_CHANNEL_IDS,
  BATCH4_CHANNEL_IDS
} = process.env;

// Parse batch channels (all support comma-separated multiple channels)
const parseChannelIds = (envVar) =>
  envVar ? envVar.split(',').map(id => id.trim()).filter(Boolean) : [];

const batch2Channels = parseChannelIds(BATCH2_CHANNEL_IDS);
const batch3Channels = parseChannelIds(BATCH3_CHANNEL_IDS);
const batch4Channels = parseChannelIds(BATCH4_CHANNEL_IDS);

// Create Express app
const expressApp = express();

// Initialize the Slack Bolt app
let app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// OAuth scopes required by the app
const SCOPES = [
  'channels:read',
  'channels:manage',
  'groups:read',
  'groups:write',
  'chat:write',
  'im:write',
  'im:history',
  'users:read',
  'channels:join'
];

/**
 * Helper to send a DM to a user with error handling and logging
 * @param {Object} params
 * @param {Object} params.client - Slack WebClient instance
 * @param {string} params.user - User ID to DM
 * @param {string} params.text - Fallback text
 * @param {Array} [params.blocks] - Message blocks (optional)
 */
async function dm({ client, user, text, blocks }) {
  try {
    if (!user) {
      throw new Error('User ID is required');
    }

    // Open or get existing DM channel
    const open = await client.conversations.open({
      users: user,
      return_im: true
    });

    const channel = open.channel?.id;
    if (!channel) {
      throw new Error('Failed to open or create DM channel');
    }

    // Send message
    const result = await client.chat.postMessage({
      channel,
      text,
      blocks,
      mrkdwn: true
    });

    if (!result.ok) {
      throw new Error(`Failed to send message: ${result.error || 'Unknown error'}`);
    }

    return result;
  } catch (error) {
    console.error('DM Error:', {
      user,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

// Healthcheck route
expressApp.get('/', (_req, res) => {
  res.type('text/plain').send('admission-bot up');
});

expressApp.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Validate request content type
const requireSlackJson = (req, res, next) => {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    console.error('Invalid content type:', contentType);
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }
  next();
};

// Rate limiting middleware (simple in-memory implementation)
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // Max requests per window

const rateLimiter = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  // Clean up old entries
  for (const [key, { timestamp }] of rateLimit.entries()) {
    if (now - timestamp > RATE_LIMIT_WINDOW) {
      rateLimit.delete(key);
    }
  }

  const clientRate = rateLimit.get(ip) || { count: 0, timestamp: now };

  if (clientRate.count >= RATE_LIMIT_MAX) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ error: 'Too many requests' });
  }

  clientRate.count++;
  rateLimit.set(ip, clientRate);

  // Set rate limit headers
  res.set({
    'X-RateLimit-Limit': RATE_LIMIT_MAX,
    'X-RateLimit-Remaining': RATE_LIMIT_MAX - clientRate.count,
    'X-RateLimit-Reset': Math.floor((now + RATE_LIMIT_WINDOW) / 1000)
  });

  next();
};

// Slack Events endpoint - handles URL verification and event callbacks
expressApp.post(
  '/slack/events',
  express.raw({ type: 'application/json' }),
  requireSlackJson,
  rateLimiter,
  async (req, res) => {
    const requestId = Math.random().toString(36).substring(2, 10);

    try {
      // Parse the raw body
      const rawBody = req.body?.toString('utf8') || '';
      if (!rawBody) {
        console.log(`[${requestId}] Empty request body`);
        return res.status(400).json({ error: 'Empty request body' });
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (parseErr) {
        console.log(`[${requestId}] JSON parse error: ${parseErr.message}`);
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      console.log(`[${requestId}] Received Slack request: type = "${body.type}"`);

      // 1) Handle URL verification challenge
      if (body.type === 'url_verification') {
        console.log(`[${requestId}] URL verification challenge received`);
        return res.status(200).json({ challenge: body.challenge });
      }

      // 2) Handle event_callback (actual Slack events)
      if (body.type === 'event_callback') {
        const event = body.event;
        console.log(`[${requestId}] Event callback: event_type = "${event?.type}"`);

        // Acknowledge to Slack immediately to prevent retries
        res.status(200).send('');

        try {
          await handleSlackEvent(event, requestId);
        } catch (processErr) {
          console.error(`[${requestId}] Error processing event:`, processErr.message);
        }

        return;
      }

      // 3) Other event types
      console.log(`[${requestId}] Unknown event type: "${body.type}"`);
      res.status(200).send('');
    } catch (err) {
      console.error(`[${requestId}] Error in /slack/events:`, err.message);
      // Always return 200 to prevent Slack retry loops
      if (!res.headersSent) {
        res.status(200).send('');
      }
    }
  }
);

/**
 * Handle Slack events
 * @param {Object} event - The Slack event object
 * @param {string} requestId - Request ID for logging
 */
async function handleSlackEvent(event, requestId) {
  if (!event) return;

  const targetChannelId = ANNOUNCE_CHANNEL_ID || LOBBY_CHANNEL_ID;

  if (event.type === 'member_joined_channel') {
    // User joined a channel - start the flow
    if (!targetChannelId || event.channel !== targetChannelId) {
      console.log(`[${requestId}] Ignoring join event - not the target channel`);
      return;
    }

    const userId = event.user;
    if (!userId) return;

    console.log(`[${requestId}] User ${userId} joined target channel - starting flow`);
    await dm({
      client: app.client,
      user: userId,
      text: 'Welcome! What is your full name?',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '*Welcome!* What is your full name?' }
      }]
    });
    dmState.set(userId, { step: 'askName' });
    console.log(`[${requestId}] Welcome message sent`);
  }
  else if (event.type === 'message' && event.channel_type === 'im') {
    // Direct message received
    if (event.subtype || event.bot_id) return; // Ignore bot messages

    const userId = event.user;
    if (!userId) return;

    const state = dmState.get(userId);
    const text = (event.text || '').trim();
    const lowerText = text.toLowerCase();

    console.log(`[${requestId}] DM from ${userId}: "${text}"`);

    if (!state) {
      // Check if user is greeting the bot
      const greetings = ['hey', 'hello', 'hi', 'hola', 'namaste', 'help', 'start'];
      const isGreeting = greetings.some(greeting => lowerText.includes(greeting));

      if (isGreeting) {
        console.log(`[${requestId}] Greeting detected - starting flow`);
        await dm({
          client: app.client,
          user: userId,
          text: 'Hello! How may I help you? What is your full name?',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: '*Hello! How may I help you?*\n\nLet\'s get you set up. What is your full name?' }
          }]
        });
        dmState.set(userId, { step: 'askName' });
      }
      return;
    }

    // Handle conversation flow
    if (state.step === 'askName') {
      const name = text;
      if (!name) {
        await dm({ client: app.client, user: userId, text: 'Please share your full name.' });
        return;
      }
      console.log(`[${requestId}] Got name: ${name}`);
      dmState.set(userId, { step: 'askBatch', name });
      await dm({
        client: app.client,
        user: userId,
        text: 'Thanks, ' + name + '. Which batch are you in? 2, 3, or 4?',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `Thanks, ${name}. Which batch are you in? *2*, *3*, or *4*?` }
        }]
      });
      return;
    }

    if (state.step === 'askBatch') {
      const normalized = text.replace(/[^0-9]/g, '');
      let batchChannels = [];
      let batchName = '';

      if (normalized === '2') {
        batchChannels = batch2Channels;
        batchName = 'Batch 2';
      } else if (normalized === '3') {
        batchChannels = batch3Channels;
        batchName = 'Batch 3';
      } else if (normalized === '4') {
        batchChannels = batch4Channels;
        batchName = 'Batch 4';
      }

      if (batchChannels.length === 0) {
        await dm({
          client: app.client,
          user: userId,
          text: 'Please enter a valid batch number (2, 3, or 4).'
        });
        return;
      }

      console.log(`[${requestId}] Adding user to ${batchName} (${batchChannels.length} channel(s))`);

      const results = [];
      let anySuccess = false;

      for (const channelId of batchChannels) {
        try {
          // First, ensure the bot is in the channel
          try {
            await app.client.conversations.join({ channel: channelId });
          } catch (joinError) {
            console.log(`[${requestId}] Bot join attempt for ${channelId}:`, joinError.data?.error || joinError.message);
          }

          // Try to invite the user
          await app.client.conversations.invite({
            channel: channelId,
            users: userId
          });
          results.push({ channelId, success: true, status: 'added' });
          anySuccess = true;
        } catch (inviteErr) {
          if (inviteErr.data?.error === 'already_in_channel') {
            results.push({ channelId, success: true, status: 'already_member' });
            anySuccess = true;
          } else {
            console.error(`[${requestId}] Invite to ${channelId} failed:`, inviteErr.data?.error || inviteErr.message);
            results.push({ channelId, success: false, status: inviteErr.data?.error || 'failed' });
          }
        }
      }

      // Build response message
      if (anySuccess) {
        const channelLinks = results
          .filter(r => r.success)
          .map(r => `<#${r.channelId}>`)
          .join(', ');

        await dm({
          client: app.client,
          user: userId,
          text: `You're in! Added to ${batchName}. Welcome!`,
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `*You're in!* Added to ${batchName}.\n\nWelcome to ${channelLinks}!` }
          }]
        });
        console.log(`[${requestId}] User invited to ${batchName}`);
      } else {
        await dm({
          client: app.client,
          user: userId,
          text: 'I could not add you automatically. A moderator will help you shortly.'
        });
      }

      dmState.delete(userId);
    }
  }
}

// OAuth Install endpoint
expressApp.get('/slack/install', (_req, res) => {
  try {
    if (!SLACK_CLIENT_ID || !SLACK_REDIRECT_URL) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_REDIRECT_URL');
    }

    const state = Math.random().toString(36).substring(2, 15);
    oauthStates.set(state, Date.now());

    const authUrl = `https://slack.com/oauth/v2/authorize?` + new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      scope: SCOPES.join(','),
      state: state,
      redirect_uri: SLACK_REDIRECT_URL
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('Error in OAuth install:', error);
    res.status(500).send(`Error during OAuth installation: ${error.message}`);
  }
});

// OAuth redirect handler
expressApp.get('/slack/oauth_redirect', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state parameter');
    }

    if (!oauthStates.has(state)) {
      throw new Error('Invalid state parameter');
    }

    // Clean up used state
    oauthStates.delete(state);

    // Exchange code for token
    const axios = (await import('axios')).default;
    const response = await axios.post('https://slack.com/api/oauth.v2.access', null, {
      params: {
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri: SLACK_REDIRECT_URL
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const result = response.data;

    if (!result.ok) {
      throw new Error(result.error || 'Failed to get OAuth token');
    }

    // Store the installation (in production, use a database)
    installations.set(result.team.id, {
      teamId: result.team.id,
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      installedAt: new Date().toISOString()
    });

    // Update the app instance with the new token
    app = new App({
      token: result.access_token,
      signingSecret: SLACK_SIGNING_SECRET,
      processBeforeResponse: true
    });

    console.log('OAuth success for team:', result.team?.name || result.team?.id);

    // Send success response
    res.send(`
      <html>
        <head>
          <title>Installation Successful</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
            .success { color: #2EB67D; font-size: 24px; margin: 20px 0; }
            .info { color: #666; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1>Installation Successful!</h1>
          <p class="success">Your bot has been added to ${result.team.name}!</p>
          <p class="info">You can now close this window and start using the bot in your Slack workspace.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>Installation Failed</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
            .error { color: #E01E5A; font-size: 24px; margin: 20px 0; }
            .info { color: #666; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1>Installation Failed</h1>
          <p class="error">${error.message}</p>
          <p class="info">Please try again or contact support if the problem persists.</p>
          <p><a href="/slack/install">Try again</a></p>
        </body>
      </html>
    `);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Export the Express app
export default expressApp;

