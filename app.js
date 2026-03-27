/*
 * SLACK BOT - ADMISSION & DM CONCIERGE
 * 
 * Required Bot Token Scopes (OAuth & Permissions):
 *   - chat:write
 *   - im:write
 *   - im:history
 *   - users:read
 *   - channels:read
 *   - groups:read
 *   - channels:manage
 *   - groups:write
 * 
 * Required Event Subscriptions (Event Subscriptions → bot events):
 *   - member_joined_channel
 *   - message.im
 * 
 * ⚠️  IMPORTANT: After adding new scopes or events, you MUST reinstall the app
 *    to your workspace (OAuth & Permissions → Reinstall App)
 */

import 'dotenv/config';
import express from 'express';
import bolt from '@slack/bolt';

const { App } = bolt;

// --- Bolt App (HTTP mode) ---
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// --- Express server wrapper ---
const server = express();

// Health endpoints
server.get('/', (_req, res) => res.status(200).send('OK'));
server.get('/health', (_req, res) => res.status(200).send('OK'));

// Slack Events endpoint
server.post(
  '/slack/events',
  // IMPORTANT: raw body so Slack signature verification works
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const raw = req.body?.toString('utf8') || '';
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}

      // 1) URL verification: echo the challenge
      if (body?.type === 'url_verification' && body?.challenge) {
        console.log('Responding to Slack challenge:', body.challenge);
        return res.status(200).send(body.challenge);
      }

      // 2) Forward other events to Bolt. Attach raw body for signature check.
      req.body = raw;
      await slackApp.processEvent(req, res);
    } catch (err) {
      console.error('Slack /slack/events error:', err);
      if (!res.headersSent) res.status(200).end(); // prevent Slack retries loop
    }
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the batch selection modal (reusable)
 * @returns {object} Slack modal view object
 */
function buildBatchModal() {
  return {
    type: "modal",
    callback_id: "batch_form_submit",
    title: { type: "plain_text", text: "Choose Your Batch" },
    submit: { type: "plain_text", text: "Confirm" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{
      type: "input",
      block_id: "batch_block",
      label: { type: "plain_text", text: "Which batch are you part of?" },
      element: {
        type: "radio_buttons",
        action_id: "batch",
        options: [
          { text: { type: "plain_text", text: "Batch 2" }, value: "batch2" },
          { text: { type: "plain_text", text: "Batch 3" }, value: "batch3" },
          { text: { type: "plain_text", text: "Batch 4" }, value: "batch4" },
          { text: { type: "plain_text", text: "Batch 5" }, value: "batch5" }
        ]
      }
    }]
  };
}

/**
 * Get channel IDs for a batch (supports multiple channels)
 * @param {string} batchKey - The batch key (batch2, batch3, batch4)
 * @returns {string[]} Array of channel IDs
 */
function getBatchChannels(batchKey) {
  const channelMap = {
    batch2: process.env.BATCH2_CHANNEL_ID ? [process.env.BATCH2_CHANNEL_ID] : [],
    batch3: process.env.BATCH3_CHANNEL_ID ? [process.env.BATCH3_CHANNEL_ID] : [],
    batch4: process.env.BATCH4_CHANNEL_IDS
      ? process.env.BATCH4_CHANNEL_IDS.split(',').map(id => id.trim()).filter(Boolean)
      : [],
    batch5: process.env.BATCH5_CHANNEL_ID ? [process.env.BATCH5_CHANNEL_ID] : []
  };
  return channelMap[batchKey] || [];
}

/**
 * Sends the DM concierge help menu with action buttons
 * @param {object} client - Slack Web API client
 * @param {string} channel - Channel ID (DM channel)
 */
async function sendHelpMenu(client, channel) {
  await client.chat.postMessage({
    channel,
    text: "How can I help you?",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "👋 *How can I help you?*\n\nChoose an option below:"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🎓 Batch Access", emoji: true },
            action_id: "menu_batch_access",
            style: "primary"
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Nothing", emoji: true },
            action_id: "menu_nothing"
          }
        ]
      }
    ]
  });
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

// --- 1) Member joins lobby channel → Send welcome with batch button ---
slackApp.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    if (event.channel !== process.env.LOBBY_CHANNEL_ID) return;
    const user = event.user;
    const { user: info } = await client.users.info({ user });
    if (info?.is_bot) return;

    const { channel: im } = await client.conversations.open({ users: user });
    await client.chat.postMessage({
      channel: im.id,
      text: "Welcome! Please pick your batch.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "👋 *Welcome!* Select your batch to get access." } },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Select Batch" }, action_id: "open_batch_form" }
        ]}
      ]
    });
  } catch (e) { logger.error(e); }
});

// --- 2) Direct Message (DM) → Show help menu ---
slackApp.event('message', async ({ event, client, logger }) => {
  try {
    // Only handle direct messages (IMs) from humans
    if (event.channel_type !== 'im') return; // Not a DM
    if (event.subtype) return; // Ignore bot messages, edits, etc.
    if (event.bot_id) return; // Ignore bot messages

    const text = (event.text || '').toLowerCase().trim();
    const GREETING = /\b(hi|hello|hey|help|namaste|hola|start|menu)\b/;

    // Show menu for greetings OR any message (set to true for always-on concierge)
    if (GREETING.test(text) || true) {
      console.log(`📨 DM received from user ${event.user}: "${event.text}" → Showing help menu`);
      await sendHelpMenu(client, event.channel);
    }
  } catch (e) {
    logger.error('Error in message.im handler:', e);
  }
});

// ============================================================================
// ACTION HANDLERS
// ============================================================================

// --- 3a) "Select Batch" button from welcome message → Open modal ---
slackApp.action('open_batch_form', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    console.log(`🎯 Action: open_batch_form from user ${body.user.id}`);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildBatchModal() // Reuse modal builder
    });
  } catch (e) {
    logger.error('Error in open_batch_form:', e);
  }
});

// --- 3b) "Batch Access" button from DM menu → Open modal ---
slackApp.action('menu_batch_access', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    console.log(`🎯 Action: menu_batch_access from user ${body.user.id}`);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildBatchModal() // Reuse modal builder
    });
  } catch (e) {
    logger.error('Error in menu_batch_access:', e);
  }
});

// --- 3c) "Nothing" button from DM menu → Polite closing ---
slackApp.action('menu_nothing', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    console.log(`🎯 Action: menu_nothing from user ${body.user.id}`);
    // Get the channel (DM) from the action
    const channel = body.channel?.id;
    if (channel) {
      await client.chat.postMessage({
        channel,
        text: "No problem! If you need anything later, just say hi. 👋"
      });
    }
  } catch (e) {
    logger.error('Error in menu_nothing:', e);
  }
});

// ============================================================================
// VIEW SUBMISSION HANDLERS
// ============================================================================

// --- 4) Batch modal submission → Invite user to selected batch channel(s) ---
slackApp.view('batch_form_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const user = body.user.id;
    const selected = view.state.values.batch_block.batch.selected_option?.value;
    const targetChannels = getBatchChannels(selected);

    if (targetChannels.length === 0) {
      console.warn(`⚠️  No channels configured for selection: ${selected}`);
      const { channel: im } = await client.conversations.open({ users: user });
      await client.chat.postMessage({
        channel: im.id,
        text: `⚠️ Sorry, no channels are configured for ${selected}. Please contact an admin.`
      });
      return;
    }

    console.log(`✅ User ${user} selected ${selected} → Inviting to ${targetChannels.length} channel(s)`);

    const results = [];

    // Process each target channel
    for (const channelId of targetChannels) {
      // Try to join the channel first (bot must be a member to invite)
      try {
        await client.conversations.join({ channel: channelId });
      } catch (joinErr) {
        console.log(`ℹ️  Bot already in channel ${channelId} or cannot join:`, joinErr.message);
      }

      // Invite user to the channel
      try {
        await client.conversations.invite({ channel: channelId, users: user });
        results.push({ channelId, success: true, status: 'added' });
        console.log(`   ✓ Added to <#${channelId}>`);
      } catch (inviteErr) {
        if (inviteErr.data?.error === 'already_in_channel') {
          results.push({ channelId, success: true, status: 'already_member' });
          console.log(`   ℹ️  Already in <#${channelId}>`);
        } else {
          results.push({ channelId, success: false, status: inviteErr.data?.error || 'error' });
          console.error(`   ✗ Failed to add to ${channelId}:`, inviteErr.data?.error);
        }
      }
    }

    // Build confirmation message
    const { channel: im } = await client.conversations.open({ users: user });
    const successCount = results.filter(r => r.success).length;

    if (successCount === targetChannels.length) {
      const channelLinks = results.map(r => `<#${r.channelId}>`).join(', ');
      await client.chat.postMessage({
        channel: im.id,
        text: `✅ You're in! Added to your batch channel(s): ${channelLinks}. Welcome!`
      });
    } else if (successCount > 0) {
      const addedChannels = results.filter(r => r.success).map(r => `<#${r.channelId}>`).join(', ');
      const failedChannels = results.filter(r => !r.success).map(r => `<#${r.channelId}>`).join(', ');
      await client.chat.postMessage({
        channel: im.id,
        text: `⚠️ Partially added:\n✅ Success: ${addedChannels}\n❌ Failed: ${failedChannels}\n\nA moderator will help with the remaining channels.`
      });
    } else {
      await client.chat.postMessage({
        channel: im.id,
        text: `❌ Could not add you to the batch channels. A moderator will help you shortly.`
      });
    }
  } catch (e) {
    logger.error('Error in batch_form_submit:', e);
    // Try to notify user of error
    try {
      const { channel: im } = await client.conversations.open({ users: body.user.id });
      await client.chat.postMessage({
        channel: im.id,
        text: `❌ Something went wrong. Please try again or contact a moderator.`
      });
    } catch {}
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('');
  console.log('🚀 ========================================');
  console.log(`✅  Slack Bot is RUNNING on port ${port}`);
  console.log('🚀 ========================================');
  console.log('');
  console.log('📋 Features enabled:');
  console.log('   ✓ Member join → Batch selection');
  console.log('   ✓ DM concierge → Help menu');
  console.log('   ✓ Batch access modal (Batch 2, 3, 4, 5)');
  console.log('');
  console.log('📍 Slack Events URL: /slack/events');
  console.log('🔍 Healthcheck: GET /');
  console.log('');
  console.log('📦 Batch channels configured:');
  console.log(`   Batch 2: ${process.env.BATCH2_CHANNEL_ID || '(not set)'}`);
  console.log(`   Batch 3: ${process.env.BATCH3_CHANNEL_ID || '(not set)'}`);
  console.log(`   Batch 4: ${process.env.BATCH4_CHANNEL_IDS || '(not set)'}`);
  console.log(`   Batch 5: ${process.env.BATCH5_CHANNEL_ID || '(not set)'}`);
  console.log('');
});
