import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';

// Validate required envs early for clearer boot failures
const requiredEnv = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'LOBBY_CHANNEL_ID',
  'BATCH2_CHANNEL_ID',
  'BATCH3_CHANNEL_ID',
  'BATCH4_CHANNEL_ID',
];

const missing = requiredEnv.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
}

const port = Number(process.env.PORT || 3000);

// Initialize the Bolt app using default ExpressReceiver (exposes /slack/events)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel: LogLevel.INFO,
  // Using default receiver ensures /slack/events is mounted
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
      const status = err?.status || err?.data?.response_metadata?.messages;
      console.error(`[retry] ${label || 'op'} failed (attempt ${attempt + 1}/${retries + 1})`, {
        error: slackErr,
        status,
      });
      // Respect Slack rate limit header if present
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
app.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    const { user: joinedUserId, channel: joinedChannelId, channel_type } = event;
    console.log(`[event] member_joined_channel user=${joinedUserId} channel=${joinedChannelId} type=${channel_type}`);

    if (joinedChannelId !== process.env.LOBBY_CHANNEL_ID) {
      logger.debug('Join event not in lobby, ignoring');
      return;
    }

    // Filter out bot users
    const userInfo = await withRetry(
      () => client.users.info({ user: joinedUserId }),
      { label: 'users.info' }
    );
    const isBot = Boolean(userInfo?.user?.is_bot);
    if (isBot) {
      console.log(`[skip] Joined user is a bot (${joinedUserId})`);
      return;
    }

    // Open DM and send welcome message with button
    const imOpen = await withRetry(
      () => client.conversations.open({ users: joinedUserId }),
      { label: 'conversations.open' }
    );
    const dmChannel = imOpen?.channel?.id;
    if (!dmChannel) {
      console.error('Failed to open DM channel');
      return;
    }

    await withRetry(
      () =>
        client.chat.postMessage({
          channel: dmChannel,
          text: 'Welcome! Please select your batch below 👇',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Welcome! Please select your batch below 👇' },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Select Batch' },
                  action_id: 'open_batch_form',
                  value: 'open',
                },
              ],
            },
          ],
        }),
      { label: 'chat.postMessage (welcome)' }
    );

    console.log(`[dm] Sent welcome button to user=${joinedUserId}`);
  } catch (error) {
    console.error('[handler-error] member_joined_channel', { error: error?.data?.error || error?.message || error });
  }
});

// Action: open_batch_form
app.action('open_batch_form', async ({ ack, body, client }) => {
  await ack();
  try {
    const triggerId = body?.trigger_id;
    const userId = body?.user?.id;
    console.log(`[action] open_batch_form by user=${userId}`);

    await withRetry(
      () =>
        client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'batch_form_submit',
            title: { type: 'plain_text', text: 'Choose Batch' },
            submit: { type: 'plain_text', text: 'Confirm' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type: 'input',
                block_id: 'batch_choice',
                label: { type: 'plain_text', text: 'Select your batch' },
                element: {
                  type: 'radio_buttons',
                  action_id: 'batch_selection',
                  options: [
                    {
                      text: { type: 'plain_text', text: 'Batch 2' },
                      value: 'batch2',
                    },
                    {
                      text: { type: 'plain_text', text: 'Batch 3' },
                      value: 'batch3',
                    },
                    {
                      text: { type: 'plain_text', text: 'Batch 4' },
                      value: 'batch4',
                    },
                  ],
                },
              },
            ],
          },
        }),
      { label: 'views.open (batch modal)' }
    );
  } catch (error) {
    console.error('[handler-error] open_batch_form', { error: error?.data?.error || error?.message || error });
  }
});

// View submission: batch_form_submit
app.view('batch_form_submit', async ({ ack, body, view, client }) => {
  await ack();
  const userId = body?.user?.id;
  console.log(`[view] batch_form_submit by user=${userId}`);

  try {
    const selected = view?.state?.values?.batch_choice?.batch_selection?.selected_option?.value;
    if (!selected) {
      console.error('No selection made in modal');
      return;
    }

    const map = {
      batch2: process.env.BATCH2_CHANNEL_ID,
      batch3: process.env.BATCH3_CHANNEL_ID,
      batch4: process.env.BATCH4_CHANNEL_ID,
    };

    const targetChannel = map[selected];
    if (!targetChannel) {
      console.error(`Unknown selection ${selected}`);
      return;
    }

    console.log(`[invite] Inviting user=${userId} to channel=${targetChannel} (${selected})`);

    // Try inviting user to the private channel
    try {
      await withRetry(
        () => client.conversations.invite({ channel: targetChannel, users: userId }),
        { label: 'conversations.invite' }
      );
      // On success, DM confirmation
      const { channel: dmChannel } = await withRetry(
        () => client.conversations.open({ users: userId }),
        { label: 'conversations.open (post-invite)' }
      );
      await withRetry(
        () =>
          client.chat.postMessage({
            channel: dmChannel?.id || dmChannel,
            text: `You’ve been added to your private ${selected.replace('batch', 'Batch ')} channel 🎉`,
          }),
        { label: 'chat.postMessage (success DM)' }
      );
    } catch (err) {
      const code = err?.data?.error || err?.code || 'unknown_error';
      console.warn('[invite-error]', code);

      const { channel: dmChannel } = await withRetry(
        () => client.conversations.open({ users: userId }),
        { label: 'conversations.open (error DM)' }
      );

      let msg;
      if (code === 'already_in_channel') {
        msg = "You're already in that channel.";
      } else if (code === 'not_in_channel') {
        msg = '⚠️ Couldn’t add you automatically. Please ask an admin to add me to that private channel first.';
      } else if (code === 'missing_scope') {
        msg = 'I need additional permissions. Please contact an admin.';
      } else {
        msg = `Something went wrong: ${code}`;
      }

      await withRetry(
        () => client.chat.postMessage({ channel: dmChannel?.id || dmChannel, text: msg }),
        { label: 'chat.postMessage (error DM)' }
      );
    }
  } catch (error) {
    console.error('[handler-error] batch_form_submit', { error: error?.data?.error || error?.message || error });
  }
});

// Start the app
(async () => {
  try {
    await app.start(port);
    console.log(`⚡️ Batch Router Bot is running on port ${port}. Endpoint: /slack/events`);
  } catch (err) {
    console.error('Failed to start app', err);
    process.exit(1);
  }
})();


