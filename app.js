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

// --- Existing listeners ---
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

slackApp.action('open_batch_form', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
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
            { text: { type: "plain_text", text: "Batch 3" }, value: "batch3" }
          ]
        }
      }]
    }
  });
});

slackApp.view('batch_form_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const user = body.user.id;
    const selected = view.state.values.batch_block.batch.selected_option?.value;
    const map = {
      batch2: process.env.BATCH2_CHANNEL_ID,
      batch3: process.env.BATCH3_CHANNEL_ID
    };
    const target = map[selected];
    if (!target) return;

    try { await client.conversations.join({ channel: target }); } catch (_) {}
    await client.conversations.invite({ channel: target, users: user });

    const { channel: im } = await client.conversations.open({ users: user });
    await client.chat.postMessage({ channel: im.id, text: "✅ You're in! Added to your batch channel." });
  } catch (e) { logger.error(e); }
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`✅ Server live on port ${port}`));
