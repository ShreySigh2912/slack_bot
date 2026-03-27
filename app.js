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
 * Interactivity & Shortcuts → Request URL:
 *   https://<your-render-url>/slack/events
 *
 * Environment Variables (Render dashboard):
 *   SLACK_BOT_TOKEN      xoxb-...
 *   SLACK_SIGNING_SECRET from App Credentials → Signing Secret
 *   LOBBY_CHANNEL_ID     channel where new members arrive
 *   BATCH3_CHANNEL_ID    comma-separated channel IDs for Batch 3
 *   BATCH4_CHANNEL_ID    comma-separated channel IDs for Batch 4
 *   BATCH5_CHANNEL_ID    comma-separated channel IDs for Batch 5
 */

import 'dotenv/config';
import express from 'express';
import { App, ExpressReceiver } from '@slack/bolt';

// ─── Bolt receiver (handles signature verification + event dispatch) ──────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: '/slack/events',
});

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ─── Main Express server ──────────────────────────────────────────────────────
// We sit in front of receiver.app so we can handle the URL verification
// challenge BEFORE Bolt's signature check runs. All other requests are
// forwarded to receiver.app unchanged.
const server = express();

server.get('/', (_req, res) => res.status(200).send('OK'));
server.get('/health', (_req, res) => res.status(200).send('OK'));

// Intercept /slack/events before it reaches Bolt
server.post(
  '/slack/events',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    const raw = req.body?.toString('utf8') || '';
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }

    // URL verification — Slack just wants the challenge echoed back.
    // No signature check needed here.
    if (body?.type === 'url_verification') {
      console.log('[bot] URL verification challenge — responding');
      return res.status(200).json({ challenge: body.challenge });
    }

    // For every other request: set req.rawBody so Bolt's signature
    // verification middleware can read it (it looks for req.rawBody),
    // and set req.body to the parsed object so Bolt can process the event.
    req.rawBody = raw;
    req.body = body;
    next();
  }
);

// Hand everything else off to Bolt's Express app.
// req.rawBody + req.body are already set above so body-parser is skipped
// and signature verification reads req.rawBody directly.
server.use(receiver.app);

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
  try { await client.conversations.join({ channel: channelId }); } catch { /* already a member */ }
  try {
    await client.conversations.invite({ channel: channelId, users: userId });
    return { success: true };
  } catch (err) {
    if (err.data?.error === 'already_in_channel') return { success: true };
    console.error(`[bot] invite ${userId} → ${channelId} failed:`, err.data?.error);
    return { success: false, channelId };
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
  } catch (err) { logger.error('[bot] open_batch_form:', err); }
});

slack.action('menu_batch_access', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildBatchModal() });
  } catch (err) { logger.error('[bot] menu_batch_access:', err); }
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
  } catch (err) { logger.error('[bot] menu_nothing:', err); }
});

// ─── View submissions ─────────────────────────────────────────────────────────

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
      targetChannels.map(id => inviteUserToChannel(client, id, userId))
    );

    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      const links = targetChannels.map(id => `<#${id}>`).join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `You have been added to: ${links}. Welcome!`,
      });
    } else if (failed.length < results.length) {
      const okLinks = targetChannels.filter((_, i) => results[i].success).map(id => `<#${id}>`).join(', ');
      const failLinks = failed.map(r => `<#${r.channelId}>`).join(', ');
      await client.chat.postMessage({
        channel: dm.id,
        text: `Added to: ${okLinks}\nCould not add to: ${failLinks} — please contact an admin.`,
      });
    } else {
      await client.chat.postMessage({
        channel: dm.id,
        text: 'Could not add you to the channels. Please contact an admin.',
      });
    }
  } catch (err) {
    logger.error('[bot] batch_form_submit error:', err);
    try {
      const { channel: dm } = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: dm.id, text: 'Something went wrong. Please contact an admin.' });
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
  console.log('  POST /slack/events  — Slack events');
  console.log('  GET  /health        — Healthcheck');
  console.log('');
  console.log('  Batch channels:');
  console.log(`    Batch 3 : ${process.env.BATCH3_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 4 : ${process.env.BATCH4_CHANNEL_ID || '(not set)'}`);
  console.log(`    Batch 5 : ${process.env.BATCH5_CHANNEL_ID || '(not set)'}`);
  console.log('');
});
