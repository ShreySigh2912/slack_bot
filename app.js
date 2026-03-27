/**
 * SLACK ADMISSION BOT
 *
 * Required Bot Token Scopes (api.slack.com → OAuth & Permissions):
 *   chat:write, im:write, im:history, users:read,
 *   channels:read, groups:read, channels:manage, groups:write
 *
 * Required Event Subscriptions (Event Subscriptions → Bot Events):
 *   member_joined_channel, message.im
 *
 * Required Interactivity:
 *   Interactivity & Shortcuts → ON
 *   Request URL: https://<your-render-url>/slack/events
 *
 * Environment Variables (set in Render dashboard):
 *   SLACK_BOT_TOKEN      - Bot User OAuth Token (xoxb-...)
 *   SLACK_SIGNING_SECRET - App Signing Secret
 *   LOBBY_CHANNEL_ID     - Channel ID where new members arrive
 *   BATCH2_CHANNEL_ID    - Channel ID(s) for Batch 2 (comma-separated if multiple)
 *   BATCH3_CHANNEL_ID    - Channel ID(s) for Batch 3
 *   BATCH4_CHANNEL_ID    - Channel ID(s) for Batch 4
 *   BATCH5_CHANNEL_ID    - Channel ID(s) for Batch 5
 *   PORT                 - Set automatically by Render (do not set manually)
 */

import 'dotenv/config';
import express from 'express';
import bolt from '@slack/bolt';

const { App } = bolt;

// ─── Slack Bolt (no built-in receiver — we route manually via Express) ────────
const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── Express server ───────────────────────────────────────────────────────────
const server = express();

// Healthcheck endpoints (Render pings these to verify the service is up)
server.get('/', (_req, res) => res.status(200).send('OK'));
server.get('/health', (_req, res) => res.status(200).send('OK'));

// All Slack events, actions, and view submissions come through this endpoint.
// IMPORTANT: express.raw() must be used here — Slack signature verification
// requires the raw request body, not a parsed JSON object.
server.post(
  '/slack/events',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const raw = req.body?.toString('utf8') || '';
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore parse errors */ }

      // Slack sends a one-time challenge when you first configure the Events URL.
      if (body?.type === 'url_verification') {
        console.log('[slack] URL verification challenge received');
        return res.status(200).json({ challenge: body.challenge });
      }

      // Forward everything else to Bolt for processing.
      req.body = raw;
      await slack.processEvent(req, res);
    } catch (err) {
      console.error('[slack] /slack/events error:', err);
      // Always return 200 to Slack to prevent retry storms.
      if (!res.headersSent) res.status(200).end();
    }
  }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse comma-separated channel IDs from an env var value.
 * e.g. "C123,C456" → ["C123", "C456"]
 */
function getChannels(envValue) {
  if (!envValue) return [];
  return envValue.split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * Return the list of channel IDs configured for a given batch key.
 */
function getBatchChannels(batchKey) {
  const map = {
    batch2: getChannels(process.env.BATCH2_CHANNEL_ID),
    batch3: getChannels(process.env.BATCH3_CHANNEL_ID),
    batch4: getChannels(process.env.BATCH4_CHANNEL_ID),
    batch5: getChannels(process.env.BATCH5_CHANNEL_ID),
  };
  return map[batchKey] ?? [];
}

/**
 * Build the batch-selection modal view.
 */
function buildBatchModal() {
  return {
    type: 'modal',
    callback_id: 'batch_form_submit',
    title: { type: 'plain_text', text: 'Choose Your Batch' },
    submit: { type: 'plain_text', text: 'Confirm' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'batch_block',
        label: { type: 'plain_text', text: 'Which batch are you part of?' },
        element: {
          type: 'radio_buttons',
          action_id: 'batch_select',
          options: [
            { text: { type: 'plain_text', text: 'Batch 2' }, value: 'batch2' },
            { text: { type: 'plain_text', text: 'Batch 3' }, value: 'batch3' },
            { text: { type: 'plain_text', text: 'Batch 4' }, value: 'batch4' },
            { text: { type: 'plain_text', text: 'Batch 5' }, value: 'batch5' },
          ],
        },
      },
    ],
  };
}

/**
 * Post the help menu to a DM channel.
 */
async function sendHelpMenu(client, channelId) {
  await client.chat.postMessage({
    channel: channelId,
    text: 'How can I help you?',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*How can I help you?*\n\nChoose an option below:' },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Batch Access' },
            action_id: 'menu_batch_access',
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Nothing, thanks' },
            action_id: 'menu_nothing',
          },
        ],
      },
    ],
  });
}

/**
 * Invite a user to a channel, joining the channel as the bot first if needed.
 * Returns { success: boolean, status: string }
 */
async function inviteUserToChannel(client, channelId, userId) {
  // Bot must be in the channel before it can invite others.
  try {
    await client.conversations.join({ channel: channelId });
  } catch {
    // Already a member or private channel — ignore.
  }

  try {
    await client.conversations.invite({ channel: channelId, users: userId });
    return { success: true, status: 'added' };
  } catch (err) {
    if (err.data?.error === 'already_in_channel') {
      return { success: true, status: 'already_member' };
    }
    console.error(`[slack] Failed to invite ${userId} to ${channelId}:`, err.data?.error);
    return { success: false, status: err.data?.error || 'unknown_error' };
  }
}

// ─── Event: member joins the lobby channel ────────────────────────────────────
slack.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    // Only act on joins to the designated lobby channel.
    if (event.channel !== process.env.LOBBY_CHANNEL_ID) return;

    // Skip bots.
    const { user: info } = await client.users.info({ user: event.user });
    if (info?.is_bot) return;

    console.log(`[slack] New member in lobby: ${event.user}`);

    // Open a DM and send a welcome message with the batch selection button.
    const { channel: dm } = await client.conversations.open({ users: event.user });
    await client.chat.postMessage({
      channel: dm.id,
      text: 'Welcome! Please select your batch to get access.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Welcome!* Select your batch below to get added to your group channels.' },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Select My Batch' },
              action_id: 'open_batch_form',
              style: 'primary',
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error('[slack] member_joined_channel error:', err);
  }
});

// ─── Event: DM message received ───────────────────────────────────────────────
slack.event('message', async ({ event, client, logger }) => {
  try {
    // Only handle DMs from real users.
    if (event.channel_type !== 'im') return;
    if (event.subtype) return;   // skip edits, deletions, bot messages
    if (event.bot_id) return;

    console.log(`[slack] DM from ${event.user}: "${event.text}"`);
    await sendHelpMenu(client, event.channel);
  } catch (err) {
    logger.error('[slack] message event error:', err);
  }
});

// ─── Action: "Select My Batch" button (from welcome DM) ──────────────────────
slack.action('open_batch_form', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    console.log(`[slack] open_batch_form triggered by ${body.user.id}`);
    await client.views.open({ trigger_id: body.trigger_id, view: buildBatchModal() });
  } catch (err) {
    logger.error('[slack] open_batch_form error:', err);
  }
});

// ─── Action: "Batch Access" button (from DM help menu) ───────────────────────
slack.action('menu_batch_access', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    console.log(`[slack] menu_batch_access triggered by ${body.user.id}`);
    await client.views.open({ trigger_id: body.trigger_id, view: buildBatchModal() });
  } catch (err) {
    logger.error('[slack] menu_batch_access error:', err);
  }
});

// ─── Action: "Nothing, thanks" button ────────────────────────────────────────
slack.action('menu_nothing', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const channelId = body.channel?.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No problem! If you ever need help, just send me a message.',
      });
    }
  } catch (err) {
    logger.error('[slack] menu_nothing error:', err);
  }
});

// ─── View submission: batch modal confirmed ───────────────────────────────────
slack.view('batch_form_submit', async ({ ack, body, view, client, logger }) => {
  await ack();

  const userId = body.user.id;
  const selected = view.state.values.batch_block.batch_select.selected_option?.value;

  console.log(`[slack] batch_form_submit: user=${userId} batch=${selected}`);

  try {
    const { channel: dm } = await client.conversations.open({ users: userId });
    const targetChannels = getBatchChannels(selected);

    if (targetChannels.length === 0) {
      console.warn(`[slack] No channels configured for ${selected}`);
      await client.chat.postMessage({
        channel: dm.id,
        text: `No channels are configured for ${selected} yet. Please contact an admin.`,
      });
      return;
    }

    // Invite user to every channel configured for this batch.
    const results = await Promise.all(
      targetChannels.map(channelId => inviteUserToChannel(client, channelId, userId))
    );

    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      // All good
      const links = targetChannels.map(id => `<#${id}>`).join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `You have been added to your batch channel(s): ${links}. Welcome!`,
      });
    } else if (succeeded.length > 0) {
      // Partial success
      const okLinks = targetChannels
        .filter((_, i) => results[i].success)
        .map(id => `<#${id}>`)
        .join(', ');
      const failLinks = targetChannels
        .filter((_, i) => !results[i].success)
        .map(id => `<#${id}>`)
        .join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `Added to: ${okLinks}\nCould not add to: ${failLinks}\n\nPlease contact an admin for the remaining channel(s).`,
      });
    } else {
      // Total failure
      await client.chat.postMessage({
        channel: dm.id,
        text: `Could not add you to the batch channels. Please contact an admin.`,
      });
    }
  } catch (err) {
    logger.error('[slack] batch_form_submit error:', err);
    try {
      const { channel: dm } = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.id,
        text: 'Something went wrong. Please try again or contact an admin.',
      });
    } catch { /* best-effort */ }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('=========================================');
  console.log(`  Slack Admission Bot — port ${PORT}`);
  console.log('=========================================');
  console.log('');
  console.log('  Slack Events URL : POST /slack/events');
  console.log('  Healthcheck      : GET  /health');
  console.log('');
  console.log('  Batch channels configured:');
  console.log(`    Batch 2 : ${process.env.BATCH2_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 3 : ${process.env.BATCH3_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 4 : ${process.env.BATCH4_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 5 : ${process.env.BATCH5_CHANNEL_ID || '(not set)'}`);
  console.log('');
});
