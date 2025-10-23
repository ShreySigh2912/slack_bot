import 'dotenv/config';
import pkg from '@slack/bolt';
import express from 'express';
const { App } = pkg;

// In-memory state for simple OAuth state verification and DM conversation states
const oauthStates = new Map(); // state -> timestamp
const dmState = new Map(); // userId -> { step: 'askName' | 'askBatch', name?: string }

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URL,
  ANNOUNCE_CHANNEL_ID,
  BATCH2_CHANNEL_ID,
  BATCH3_CHANNEL_ID,
  PORT
} = process.env;

// Create Express app
const expressApp = express();

// Create Bolt App (without built-in Express server)
const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// Helper to DM a user
async function dm({ client, user, text, blocks }) {
  const open = await client.conversations.open({ users: user });
  const channel = open.channel?.id;
  if (!channel) throw new Error('Failed to open IM');
  await client.chat.postMessage({ channel, text, blocks, mrkdwn: true });
}

// Healthcheck route
expressApp.get('/', (_req, res) => {
  res.type('text/plain').send('admission-bot up');
});

// Slack Events endpoint - handles URL verification and event callbacks
expressApp.post(
  '/slack/events',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // Parse the raw body
      const rawBody = req.body?.toString('utf8') || '';
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch (parseErr) {
        console.error('❌ Failed to parse request body:', parseErr);
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
              let targetChannelId = null;
              if (normalized === '2') {
                targetChannelId = BATCH2_CHANNEL_ID || null;
              } else if (normalized === '3') {
                targetChannelId = BATCH3_CHANNEL_ID || null;
              }
              if (!targetChannelId) {
                await dm({
                  client: app.client,
                  user: userId,
                  text: 'Please reply with 2 or 3.'
                });
                return;
              }
              
              console.log(`🎓 Adding user to batch channel ${targetChannelId}`);
              try {
                await app.client.conversations.invite({ channel: targetChannelId, users: userId });
                await dm({
                  client: app.client,
                  user: userId,
                  text: `✅ You have been invited to <#${targetChannelId}>. Welcome!`
                });
                console.log('✅ User invited successfully');
              } catch (inviteErr) {
                console.error('❌ Invite failed:', inviteErr);
                await dm({
                  client: app.client,
                  user: userId,
                  text: 'I could not add you automatically. A moderator will help you shortly.'
                });
              } finally {
                dmState.delete(userId);
              }
              return;
            }
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

// Start Express server
const port = Number(PORT) || 3000;
expressApp.listen(port, () => {
  console.log('');
  console.log('🚀 ========================================');
  console.log(`✅  admission-bot is RUNNING on port ${port}`);
  console.log('🚀 ========================================');
  console.log('');
  console.log(`📍 Slack Events URL: https://slack-bot-1-5oui.onrender.com/slack/events`);
  console.log(`🔍 Healthcheck: GET http://localhost:${port}/`);
  console.log('');
  console.log('✨ Ready to receive Slack events!');
  console.log('   - URL verification will respond with JSON');
  console.log('   - Events will be processed manually');
  console.log('   - Greeting detection enabled');
  console.log('');
});


