## IIT Patna Admission Bot

Routes new members from the public lobby channel to their selected private batch channel via a modal.

### Tech
- Node 18+
- @slack/bolt
- dotenv

### Environment variables
Create a `.env` with the following keys (example values omitted):

```
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
LOBBY_CHANNEL_ID=
BATCH2_CHANNEL_ID=
BATCH3_CHANNEL_ID=
BATCH4_CHANNEL_ID=
PORT=3000
```

### Slack app setup
- Add bot scopes: `chat:write`, `im:write`, `users:read`, `groups:write`, `groups:read`, `channels:read`.
- Interactivity: Enabled; Request URL: `https://YOUR-APP-NAME.onrender.com/slack/events`.
- Event Subscriptions: Enabled; Request URL: `https://YOUR-APP-NAME.onrender.com/slack/events`; Bot Events: `member_joined_channel`.
- Install/Reinstall the app after adding scopes.

### Channel prep
- Get IDs for lobby (starts with C…) and private batch channels (start with G…).
- Add the bot to each private batch channel once (required for inviting users).

### Run locally (optional)
1. `cp .env.example .env` and fill values (or create `.env` with the keys above)
2. `npm install`
3. `npm start` and then test by joining the lobby channel.

### Deploy on Render
- Create Web Service
  - Build: `npm install`
  - Start: `npm start`
- Add env vars exactly as above.
- In Slack app settings, set Interactivity and Event Subscriptions URLs to `https://YOUR-APP-NAME.onrender.com/slack/events`.

### Troubleshooting
- `missing_scope`: add scope, reinstall the app.
- `not_in_channel`: bot must be a member of that private channel.
- No DM on join: ensure server is running and event subscription is enabled; bot must be in the lobby channel.

### Project structure
```
iit-patna-admission-bot/
  app.js
  package.json
  .env.example (see keys above)
  README.md
```


