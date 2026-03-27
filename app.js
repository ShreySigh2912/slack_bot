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
 *   LOBBY_CHANNEL_ID     - Channel where new members arrive
 *   BATCH3_CHANNEL_ID    - Channel ID(s) for Batch 3 (comma-separated if multiple)
 *   BATCH4_CHANNEL_ID    - Channel ID(s) for Batch 4
 *   BATCH5_CHANNEL_ID    - Channel ID(s) for Batch 5
 *   PORT                 - Set automatically by Render (do not set manually)
 */

import 'dotenv/config';
import { App, ExpressReceiver } from '@slack/bolt';

// ExpressReceiver handles signature verification, URL verification, and HTTP routing.
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

// Health endpoints — add to the receiver's underlying Express router.
receiver.router.get('/', (_req, res) => res.status(200).send('OK'));
receiver.router.get('/health', (_req, res) => res.status(200).send('OK'));

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getChannels(envValue) {
  if (!envValue) return [];
  return envValue.split(',').map(id => id.trim()).filter(Boolean);
}

function getBatchChannels(batchKey) {
  const map = {
    batch3: getChannels(process.env.BATCH3_CHANNEL_ID),
    batch4: getChannels(process.env.BATCH4_CHANNEL_ID),
    batch5: getChannels(process.env.BATCH5_CHANNEL_ID),
  };
  return map[batchKey] ?? [];
}

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
            { text: { type: 'plain_text', text: 'Batch 3' }, value: 'batch3' },
            { text: { type: 'plain_text', text: 'Batch 4' }, value: 'batch4' },
            { text: { type: 'plain_text', text: 'Batch 5' }, value: 'batch5' },
          ],
        },
      },
    ],
  };
}

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

async function inviteUserToChannel(client, channelId, userId) {
  try { await client.conversations.join({ channel: channelId }); } catch { /* already member */ }
  try {
    await client.conversations.invite({ channel: channelId, users: userId });
    return { success: true, status: 'added' };
  } catch (err) {
    if (err.data?.error === 'already_in_channel') return { success: true, status: 'already_member' };
    console.error(`[bot] Failed to invite ${userId} to ${channelId}:`, err.data?.error);
    return { success: false, status: err.data?.error || 'unknown_error' };
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

slack.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    if (event.channel !== process.env.LOBBY_CHANNEL_ID) return;
    const { user: info } = await client.users.info({ user: event.user });
    if (info?.is_bot) return;

    console.log(`[bot] New member in lobby: ${event.user}`);
    const { channel: dm } = await client.conversations.open({ users: event.user });
    await client.chat.postMessage({
      channel: dm.id,
      text: 'Welcome! Select your batch to get access.',
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
    logger.error('[bot] member_joined_channel error:', err);
  }
});

slack.event('message', async ({ event, client, logger }) => {
  try {
    if (event.channel_type !== 'im') return;
    if (event.subtype) return;
    if (event.bot_id) return;

    console.log(`[bot] DM from ${event.user}: "${event.text}"`);
    await sendHelpMenu(client, event.channel);
  } catch (err) {
    logger.error('[bot] message event error:', err);
  }
});

// ─── Actions ──────────────────────────────────────────────────────────────────

slack.action('open_batch_form', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildBatchModal() });
  } catch (err) {
    logger.error('[bot] open_batch_form error:', err);
  }
});

slack.action('menu_batch_access', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildBatchModal() });
  } catch (err) {
    logger.error('[bot] menu_batch_access error:', err);
  }
});

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
    logger.error('[bot] menu_nothing error:', err);
  }
});

// ─── View Submissions ─────────────────────────────────────────────────────────

slack.view('batch_form_submit', async ({ ack, body, view, client, logger }) => {
  await ack();

  const userId = body.user.id;
  const selected = view.state.values.batch_block.batch_select.selected_option?.value;
  console.log(`[bot] batch_form_submit: user=${userId} batch=${selected}`);

  try {
    const { channel: dm } = await client.conversations.open({ users: userId });
    const targetChannels = getBatchChannels(selected);

    if (targetChannels.length === 0) {
      console.warn(`[bot] No channels configured for ${selected}`);
      await client.chat.postMessage({
        channel: dm.id,
        text: `No channels are configured for ${selected} yet. Please contact an admin.`,
      });
      return;
    }

    const results = await Promise.all(
      targetChannels.map(channelId => inviteUserToChannel(client, channelId, userId))
    );

    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      const links = targetChannels.map(id => `<#${id}>`).join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `You have been added to your batch channel(s): ${links}. Welcome!`,
      });
    } else if (succeeded.length > 0) {
      const okLinks = targetChannels.filter((_, i) => results[i].success).map(id => `<#${id}>`).join(', ');
      const failLinks = targetChannels.filter((_, i) => !results[i].success).map(id => `<#${id}>`).join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `Added to: ${okLinks}\nCould not add to: ${failLinks}\n\nPlease contact an admin for the remaining channel(s).`,
      });
    } else {
      await client.chat.postMessage({
        channel: dm.id,
        text: 'Could not add you to the batch channels. Please contact an admin.',
      });
    }
  } catch (err) {
    logger.error('[bot] batch_form_submit error:', err);
    try {
      const { channel: dm } = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: dm.id, text: 'Something went wrong. Please try again or contact an admin.' });
    } catch { /* best-effort */ }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  const PORT = process.env.PORT || 3000;
  await slack.start(PORT);

  console.log('');
  console.log('=========================================');
  console.log(`  Slack Admission Bot — port ${PORT}`);
  console.log('=========================================');
  console.log('');
  console.log('  Slack Events URL : POST /slack/events');
  console.log('  Healthcheck      : GET  /health');
  console.log('');
  console.log('  Batch channels configured:');
  console.log(`    Batch 3 : ${process.env.BATCH3_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 4 : ${process.env.BATCH4_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 5 : ${process.env.BATCH5_CHANNEL_ID || '(not set)'}`);
  console.log('');
})();
