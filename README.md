### admission-bot

A production-ready Slack bot that welcomes users who join `#program_announcement`, collects their full name and batch number (2 or 3) via DM, and invites them to the appropriate batch channel.

#### What it does
- When any user joins the channel with ID in `ANNOUNCE_CHANNEL_ID`, the bot DMs them to ask:
  - Full name
  - Batch number (2 or 3 only)
- After a valid batch reply:
  - If 2 → invites the user to `BATCH2_CHANNEL_ID`
  - If 3 → invites the user to `BATCH3_CHANNEL_ID`
- If inviting fails (already_in_channel, not_in_channel, missing_scope, channel_not_found, restricted_action), the bot DMs a fallback message that a moderator will help.
- Conversation state per user is kept in memory: `{ step: 'askName' | 'askBatch', name?: string }`.

#### Tech
- Node.js (ES modules), Express, `@slack/bolt` v3
- Render Web Service deploy
- Slack Events API (no Socket Mode)

---

### Slack App Configuration

1) Create a Slack app with a Bot User.
2) Add bot token scopes:
   - `chat:write`
   - `im:write`
   - `im:history`
   - `users:read`
   - `channels:read`
   - `groups:read`
   - `channels:manage`
   - `groups:write`
3) Event Subscriptions:
   - Request URL: `https://YOUR-RENDER-URL/slack/events`
   - Subscribe to bot events:
     - `member_joined_channel`
     - `message.im`
4) Optional OAuth & Permissions:
   - Redirect URL: `https://YOUR-RENDER-URL/slack/oauth_redirect`
5) Reinstall/Update the app after adding scopes/events.
6) Invite the bot to the channels:
   - `#program_announcement` (the announce channel)
   - `#batch-2`
   - `#batch-3`

How to get channel IDs: Slack channel → Channel details → View channel ID.

---

### Environment Variables

Create `.env` (see `.env.example`):
- `SLACK_SIGNING_SECRET`: Slack app signing secret
- `SLACK_BOT_TOKEN`: Bot token (xoxb-…)
- `SLACK_CLIENT_ID`: (Optional install flow)
- `SLACK_CLIENT_SECRET`: (Optional install flow)
- `SLACK_REDIRECT_URL`: e.g. `https://YOUR-RENDER-URL/slack/oauth_redirect`
- `ANNOUNCE_CHANNEL_ID`: Channel ID of `#program_announcement`
- `BATCH2_CHANNEL_ID`: Channel ID of batch 2 channel
- `BATCH3_CHANNEL_ID`: Channel ID of batch 3 channel
- `PORT`: Provided by Render

---

### Local Development

1) Install deps:
```
npm install
```
2) Set env vars in `.env`.
3) Start server:
```
npm start
```
4) Healthcheck: GET `/` → `admission-bot up`

---

### Deploy to Render (Web Service)
- New → Web Service → Node
- Build: `npm install`
- Start: `npm start`
- Add environment variables from above
- After deploy, set Slack Event Request URL to `https://<your-service>/slack/events`

---

### Testing & Common Errors
- `not_in_channel`: Bot must already be a member of the destination channel
- `already_in_channel`: Safe to ignore
- `missing_scope`: Ensure `channels:manage` (public) or `groups:write` (private)
- `channel_not_found`: Verify channel ID is correct
- `restricted_action`: Ask a workspace admin or moderator for assistance

---

### Notes
- DMs are sent via `conversations.open` then `chat.postMessage`.
- The bot only accepts batch `2` or `3`. Invalid replies trigger a brief re-ask.
- Production-safe: try/catch around handlers; logs include context.


