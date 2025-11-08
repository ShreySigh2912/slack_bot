import 'dotenv/config';
import pkg from '@slack/bolt';
import express from 'express';
import { fileURLToPath } from 'url';
const { App } = pkg;

// In-memory state for simple OAuth state verification and DM conversation states
const oauthStates = new Map(); // state -> timestamp
const dmState = new Map(); // userId -> { step: 'askName' | 'askBatch', name?: string }

// Validate required environment variables
const requiredEnvVars = [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_REDIRECT_URL',
  'ANNOUNCE_CHANNEL_ID'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URL,
  ANNOUNCE_CHANNEL_ID,
  BATCH2_CHANNEL_ID,
  BATCH3_CHANNEL_ID,
  PORT = '3000' // Default port if not specified
} = process.env;

// Create Express app
const expressApp = express();

// Initialize app without token - we'll set it after OAuth
let app = new App({
  signingSecret: SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  // Disable token requirement since we'll get it from OAuth
  authorize: async () => {
    return {
      botToken: SLACK_BOT_TOKEN,
      botId: process.env.BOT_USER_ID
    };
  }
});

// Store installations in memory (use a database in production)
const installations = new Map();

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
    console.error('❌ DM Error:', {
      user,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    throw error; // Re-throw to be handled by the caller
  }
}

// Healthcheck route
expressApp.get('/', (_req, res) => {
  res.type('text/plain').send('admission-bot up');
});

// Validate request content type
const requireSlackJson = (req, res, next) => {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    console.error('❌ Invalid content type:', contentType);
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
  for (const [ip, { timestamp }] of rateLimit.entries()) {
    if (now - timestamp > RATE_LIMIT_WINDOW) {
      rateLimit.delete(ip);
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
    const requestStart = Date.now();
    let requestId = Math.random().toString(36).substring(2, 10);
    
    const logRequest = (status, message = '') => {
      console.log(`[${new Date().toISOString()}] [${requestId}] ${req.method} ${req.path} - ${status} ${message}`.trim());
    };
    
    try {
      // Parse the raw body
      const rawBody = req.body?.toString('utf8') || '';
      if (!rawBody) {
        logRequest('400', 'Empty request body');
        return res.status(400).json({ error: 'Empty request body' });
      }
      
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (parseErr) {
        logRequest('400', `JSON parse error: ${parseErr.message}`);
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      console.log(`📥 Received Slack request: type = "${body.type}"`);

      // 1) Handle URL verification challenge
      if (body.type === 'url_verification') {
        console.log('✅ URL verification challenge received:', body.challenge);
        // CRITICAL: Respond with JSON containing the challenge value
        return res.status(200).json({ challenge: body.challenge });
      }

      // 2) Handle event_callback (actual Slack events)
      if (body.type === 'event_callback') {
        console.log(`📩 Event callback received: event_type = "${body.event?.type}"`);
        
        // Acknowledge to Slack immediately to prevent retries
        res.status(200).send('');
        
        // Manually trigger the appropriate handler based on event type
        const event = body.event;
        
        try {
          if (event.type === 'member_joined_channel') {
            // User joined a channel - start the flow
            if (!ANNOUNCE_CHANNEL_ID || event.channel !== ANNOUNCE_CHANNEL_ID) {
              console.log(`⏭️  Ignoring join event - not the announce channel`);
              return;
            }
            const userId = event.user;
            if (!userId) return;
            
            console.log(`👋 User ${userId} joined announce channel - starting flow`);
            await dm({
              client: app.client,
              user: userId,
              text: 'Welcome! What is your full name?',
              blocks: [{
                type: 'section',
                text: { type: 'mrkdwn', text: '👋 *Welcome!* What is your full name?' }
              }]
            });
            dmState.set(userId, { step: 'askName' });
            console.log('✅ Welcome message sent');
          }
          else if (event.type === 'message' && event.channel_type === 'im') {
            // Direct message received
            if (event.subtype || event.bot_id) return; // Ignore bot messages
            
            const userId = event.user;
            if (!userId) return;
            
            const state = dmState.get(userId);
            const text = (event.text || '').trim();
            const lowerText = text.toLowerCase();
            
            console.log(`💬 DM from ${userId}: "${text}"`);
            
            if (!state) {
              // Check if user is greeting the bot
              const greetings = ['hey', 'hello', 'hi', 'hola', 'namaste', 'help', 'start'];
              const isGreeting = greetings.some(greeting => lowerText.includes(greeting));
              
              if (isGreeting) {
                console.log(`👋 Greeting detected - starting flow`);
                await dm({
                  client: app.client,
                  user: userId,
                  text: 'Hello! How may I help you? What is your full name?',
                  blocks: [{
                    type: 'section',
                    text: { type: 'mrkdwn', text: '👋 *Hello! How may I help you?*\n\nLet\'s get you set up. What is your full name?' }
                  }]
                });
                dmState.set(userId, { step: 'askName' });
                return;
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
              console.log(`📝 Got name: ${name}`);
              dmState.set(userId, { step: 'askBatch', name });
              await dm({
                client: app.client,
                user: userId,
                text: 'Thanks, ' + name + '. Which batch are you in? 2 or 3?',
                blocks: [{
                  type: 'section',
                  text: { type: 'mrkdwn', text: `Thanks, ${name}. Which batch are you in? *2* or *3*?` }
                }]
              });
              return;
            }
            
            if (state.step === 'askBatch') {
              const normalized = text.replace(/[^0-9]/g, '');
              let targetChannels = [];
              
              if (normalized === '2') {
                // Get Batch 2 channels from environment variable
                const batch2Channels = process.env.BATCH2_CHANNEL_IDS ? 
                  process.env.BATCH2_CHANNEL_IDS.split(',').map(id => id.trim()) : [];
                
                targetChannels = batch2Channels.map(id => ({
                  id,
                  name: `Batch 2 Channel (${id.substring(0, 6)}...)`
                }));
                
              } else if (normalized === '3') {
                // Get Batch 3 channels from environment variable
                const batch3Channels = process.env.BATCH3_CHANNEL_IDS ? 
                  process.env.BATCH3_CHANNEL_IDS.split(',').map(id => id.trim()) : [];
                
                targetChannels = batch3Channels.map(id => ({
                  id,
                  name: `Batch 3 Channel (${id.substring(0, 6)}...)`
                }));
              }
              
              if (targetChannels.length === 0) {
                await dm({
                  client: app.client,
                  user: userId,
                  text: 'Sorry, there was an issue with channel configuration. Please contact an admin for assistance.'
                });
                console.error('No target channels configured for batch:', normalized);
                return;
              }
              
              console.log(`🎓 Adding user to ${targetChannels.length} batch ${normalized} channels`);
              const results = [];
              let success = false;
              
              // Process each target channel
              for (const channel of targetChannels) {
                // First, ensure the bot is in the channel
                try {
                  await app.client.conversations.join({
                    channel: channel.id
                  });
                } catch (joinError) {
                  console.error(`Failed to join channel ${channel.id}:`, joinError.data?.error || joinError.message);
                }
                
                // Then try to invite the user
                try {
                  await app.client.conversations.invite({ 
                    channel: channel.id, 
                    users: userId 
                  });
                  results.push(`✅ Added to ${channel.name} (<#${channel.id}>)`);
                  success = true;
                } catch (inviteError) {
                  if (inviteError.data?.error === 'already_in_channel') {
                    results.push(`ℹ️ Already in ${channel.name} (<#${channel.id}>)`);
                    success = true;
                  } else if (inviteError.data?.error === 'channel_not_found' || inviteError.data?.error === 'invalid_channel') {
                    console.error(`Invalid channel ID: ${channel.id} for ${channel.name}`);
                    results.push(`⚠️ Could not add to ${channel.name} (invalid channel configuration)`);
                  } else {
                    console.error(`Failed to add to ${channel.name}:`, inviteError.data?.error || inviteError.message);
                    results.push(`❌ Failed to add to ${channel.name} (${inviteError.data?.error || 'unknown error'})`);
                  }
                }
              }
              
              await dm({
                client: app.client,
                user: userId,
                text: `*Channel Updates:*\n${results.join('\n')}\n\nWelcome to the community!`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: '*Channel Updates:*'
                    }
                  },
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: results.join('\n')
                    }
                  },
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: '\n🎉 *Welcome to the community!* 🎉'
                    }
                  }
                ]
              });
              
              console.log('✅ User invited to all channels');
            } catch (inviteErr) {
              console.error('❌ Invite failed:', inviteErr);
              try {
                await dm({
                  client: app.client,
                  user: userId,
                  text: 'I could not add you automatically. A moderator will help you shortly.'
                });
              } catch (dmErr) {
                console.error('❌ Failed to send DM:', dmErr);
              }
            } finally {
              dmState.delete(userId);
            }
            return;
          }
          
          console.log('✅ Event processed successfully');
        } catch (processErr) {
          console.error('❌ Error processing event:', processErr);
        }
        
        return;
      }

      // 3) Other event types
      console.log(`ℹ️ Unknown or unsupported event type: "${body.type}"`);
      res.status(200).send('');
    } catch (err) {
      console.error('❌ Error in /slack/events:', err);
      // Always return 200 to prevent Slack retry loops
      if (!res.headersSent) {
        res.status(200).send('');
      }
    }
  }
);

// Optional: Simple Install link
expressApp.get('/slack/install', (req, res) => {
  try {
    if (!SLACK_CLIENT_ID || !SLACK_REDIRECT_URL) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_REDIRECT_URL');
    }
    const scopes = [
      'chat:write',
      'im:write',
      'im:history',
      'users:read',
      'channels:read',
      'groups:read',
      'channels:manage',
      'groups:write'
    ];
    const state = Math.random().toString(36).slice(2);
    oauthStates.set(state, Date.now());
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', SLACK_CLIENT_ID);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('user_scope', '');
    url.searchParams.set('redirect_uri', SLACK_REDIRECT_URL);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GET /slack/install error', err);
    res.status(500).send('Install error');
  }
});

// Optional: OAuth redirect handler
expressApp.get('/slack/oauth_redirect', async (req, res) => {
  try {
    const { state, code } = req.query;
    if (!state || typeof state !== 'string' || !oauthStates.has(state)) {
      return res.status(400).send('Invalid state');
    }
    oauthStates.delete(state);
    if (!code || typeof code !== 'string') {
      return res.status(400).send('Missing code');
    }
    // Exchange code for tokens
    const result = await app.client.oauth.v2.access({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URL
    });
    // eslint-disable-next-line no-console
    console.log('OAuth success for team', result.team?.name || result.team?.id);
    res.status(200).send('<html><body>Installed. You can close this tab.</body></html>');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GET /slack/oauth_redirect error', err);
    res.status(500).send('OAuth error');
  }
});

// Error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
  // Consider restarting the process in production
  // process.exit(1);
});

// Error handler for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception:', error);
  // Consider restarting the process in production
  // process.exit(1);
});

// Handle graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🚦 Received ${signal}. Shutting down gracefully...`);
  
  try {
    // Close any open connections or resources here
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('✅ HTTP server closed');
    }
    
    console.log('👋 Process terminated');
    process.exit(0);
  } catch (err) {
  }
};

// OAuth scopes required by the app
const SCOPES = [
  'channels:read',
  'channels:manage',
  'groups:read',
  'groups:write',
  'chat:write',
  'im:write',
  'users:read',
  'channels:join',
  'channels:manage.invites'
];

// Complete the OAuth install endpoint
expressApp.get('/slack/install', (req, res) => {
  try {
    if (!SLACK_CLIENT_ID || !SLACK_REDIRECT_URL) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_REDIRECT_URL');
    }
    
    const state = Math.random().toString(36).substring(2, 15);
    oauthStates.set(state, Date.now());
    
    const authUrl = `https://slack.com/oauth/v2/authorize?` + new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      scope: SCOPES.join(','),
      user_scope: 'channels:write,groups:write,channels:read,groups:read,chat:write,im:write,users:read',
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
    
    // Exchange code for token using axios
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
    
    // Update the app with the new token
    app = new App({
      token: result.access_token,
      signingSecret: SLACK_SIGNING_SECRET,
      processBeforeResponse: true
    });
    
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
          <h1>🎉 Installation Successful!</h1>
          <p class="success">Your bot has been added to ${result.team.name}!</p>
          <p class="info">You can now close this window and start using the bot in your Slack workspace.</p>
          <script>
            // Close the window after 5 seconds
            setTimeout(() => window.close(), 3000);
          </script>
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
          <h1>⚠️ Installation Failed</h1>
          <p class="error">${error.message}</p>
          <p class="info">Please try again or contact support if the problem persists.</p>
          <p><a href="/slack/install">Try again</a></p>
        </body>
      </html>
    `);
  }
});

// Server will be started in the main execution block below

// Handle graceful shutdown
async function shutdown(signal) {
  console.log(`\n🚨 Received ${signal}. Shutting down gracefully...`);
  
  try {
    await app.stop();
    console.log('✅ Bolt app stopped');
    
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
    
    // Force close after 5 seconds
    setTimeout(() => {
      console.warn('⚠️ Forcing shutdown after timeout');
      process.exit(1);
    }, 5000);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Listen for termination signals
['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Don't exit for uncaught exceptions to keep the process running
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Export the Express app for server.js
export default expressApp;

// If this file is run directly, start the server
if (process.env.NODE_ENV !== 'test' && process.argv[1] === fileURLToPath(import.meta.url)) {
  let server;
  try {
    const port = parseInt(PORT, 10) || 3000;
    
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid PORT: ${PORT}. Must be between 1 and 65535`);
    }
    
    server = expressApp.listen(port, '0.0.0.0', () => {
      const address = server.address();
      const host = address.address === '::' ? 'localhost' : address.address;
      const port = address.port;
      
      console.log('\n' + '='.repeat(60));
      console.log(`🚀  admission-bot v${process.env.npm_package_version || '1.0.0'}`);
      console.log(`✅  Server running at http://${host}:${port}`);
      console.log(`🌐 OAuth URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || `${host}:${port}`}/slack/install`);
      console.log('🚀 ' + '='.repeat(60));
      console.log('\n📋 Environment:');
      console.log(`   - Node.js: ${process.version}`);
      console.log(`   - NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   - PID: ${process.pid}`);
      console.log('\n🔗 Endpoints:');
      console.log(`   - Healthcheck: GET http://${host}:${port}/`);
      console.log(`   - Slack Events: POST http://${host}:${port}/slack/events`);
      console.log(`   - OAuth Install: GET http://${host}:${port}/slack/install`);
      console.log('\n✨ Ready to receive Slack events!');
    });
    
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use`);
      } else {
        console.error('❌ Server error:', error);
      }
      process.exit(1);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}
