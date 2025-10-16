import 'dotenv/config';
import bolt from '@slack/bolt';
import express from 'express';

const { App } = bolt;

// Validate required envs early for clearer boot failures
const requiredEnv = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'LOBBY_CHANNEL_ID',
  'BATCH2_CHANNEL_ID',
  'BATCH3_CHANNEL_ID',
];

const missing = requiredEnv.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
}

const port = Number(process.env.PORT || 3000);

// --- Bolt app (no socket mode; HTTP only) ---
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Util: minimal retry for rate limits and transient failures
async function withRetry(fn, { label, retries = 3, baseDelayMs = 800 } = {}) {
  let attempt = 0;
  let lastError;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const slackErr = err?.data?.error || err?.code || err?.message;
      console.error(`[retry] ${label || 'op'} failed (attempt ${attempt + 1}/${retries + 1})`, { error: slackErr });
      const retryAfter = Number(err?.data?.headers?.['retry-after'] || err?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * (attempt + 1);
      if (attempt === retries) break;
      await new Promise((res) => setTimeout(res, delay));
      attempt += 1;
    }
  }
  throw lastError;
}

// Event: member_joined_channel
slackApp.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    const { user: joinedUserId, channel: joinedChannelId } = event;
    if (joinedChannelId !== process.env.LOBBY_CHANNEL_ID) {
      logger.debug('Join event not in lobby, ignoring');
      return;
    }

    const userInfo = await withRetry(() => client.users.info({ user: joinedUserId }), { label: 'users.info' });
    if (userInfo?.user?.is_bot) return;

    const imOpen = await withRetry(() => client.conversations.open({ users: joinedUserId }), {
      label: 'conversations.open',
    });
    const dmChannel = imOpen?.channel?.id;
    if (!dmChannel) return;

    await withRetry(
      () =>
        client.chat.postMessage({
          channel: dmChannel,
          text: 'Welcome! Please pick your batch.',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '*Welcome!* Please select your batch to get access.' } },
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Select Batch' }, action_id: 'open_batch_form' },
              ],
            },
          ],
        }),
      { label: 'chat.postMessage (welcome)' }
    );
  } catch (error) {
    console.error('[handler-error] member_joined_channel', error?.data?.error || error?.message || error);
  }
});

// Action: open_batch_form
slackApp.action('open_batch_form', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body?.trigger_id,
    view: {
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
            action_id: 'batch',
            options: [
              { text: { type: 'plain_text', text: 'Batch 2' }, value: 'batch2' },
              { text: { type: 'plain_text', text: 'Batch 3' }, value: 'batch3' },
            ],
          },
        },
      ],
    },
  });
});

// View submission
slackApp.view('batch_form_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const user = body?.user?.id;
    const selected = view?.state?.values?.batch_block?.batch?.selected_option?.value;
    const map = {
      batch2: process.env.BATCH2_CHANNEL_ID,
      batch3: process.env.BATCH3_CHANNEL_ID,
    };
    const target = map[selected];
    if (!target) return;

    try {
      await client.conversations.invite({ channel: target, users: user });
    } catch (e) {
      // continue to DM regardless; specific errors handled below if needed
      logger?.warn?.('invite error', e?.data?.error || e?.message || e);
    }

    const { channel: im } = await client.conversations.open({ users: user });
    if (im?.id) {
      await client.chat.postMessage({ channel: im.id, text: "You're in! I’ve added you to your batch channel 🎉" });
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// --- Express wrapper for Render ---
const server = express();
server.use(express.json());

// Health
server.get('/', (_req, res) => res.status(200).send('OK'));
server.get('/health', (_req, res) => res.status(200).send('healthy'));

// Slack URL verification + relay to Bolt
server.post('/slack/events', async (req, res) => {
  if (req.body?.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }
  try {
    await slackApp.processEvent(req, res);
  } catch (err) {
    console.error('processEvent error', err);
    if (!res.headersSent) res.status(200).end();
  }
});

// Start HTTP server for Render
server.listen(port, () => {
  console.log(`⚡️ Batch Router Bot is running on port ${port}. Endpoint: /slack/events`);
});

// Global error traps
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
