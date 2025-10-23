# Slack URL Verification Fix - Deployment Guide

## Problem
Slack was showing the error:
> "Your request URL didn't respond with the value of the challenge parameter."

## Solution
The server now explicitly handles Slack's URL verification challenge and responds with JSON format: `{ "challenge": "<value>" }`

## What Changed

### Fixed `/slack/events` Endpoint
- **Explicitly handles URL verification**: When Slack sends `type: "url_verification"`, the server immediately responds with `{ "challenge": "<challenge_value>" }` in JSON format
- **Proper event processing**: Event callbacks are acknowledged immediately and processed asynchronously by Bolt
- **Raw body parsing**: Uses `express.raw()` to preserve the raw body for Slack's signature verification
- **Enhanced logging**: All events are logged with emoji indicators for easy debugging

### Key Code Changes in `index.js`
1. **URL Verification** (lines 62-67):
   ```javascript
   if (body.type === 'url_verification') {
     return res.status(200).json({ challenge: body.challenge });
   }
   ```

2. **Event Processing** (lines 70-101):
   - Acknowledges immediately with 200 OK
   - Processes events asynchronously with Bolt handlers
   - Logs success/errors for debugging

3. **Comprehensive logging**:
   - 📥 = Incoming request
   - ✅ = Success/verification
   - 📩 = Event callback
   - ❌ = Error
   - ℹ️ = Info

## Deploy to Render

### Step 1: Commit and Push
```bash
git add index.js
git commit -m "Fix Slack URL verification with JSON response"
git push origin main
```

### Step 2: Render Auto-Deploy
- If you have auto-deploy enabled, Render will automatically rebuild
- Wait 2-3 minutes for deployment to complete

### Step 3: Verify in Slack
1. Go to https://api.slack.com/apps → Your App → Event Subscriptions
2. The Request URL field should now show: `https://slack-bot-1-5oui.onrender.com/slack/events`
3. Click "Retry" or re-enter the URL and save
4. You should see: ✅ "Verified"

### Step 4: Check Render Logs
```
📥 Received Slack request: type = "url_verification"
✅ URL verification challenge received: <challenge_string>
```

## Testing Locally

### 1. Start the server
```bash
npm start
```

You should see:
```
🚀 ========================================
✅  admission-bot is RUNNING on port 3000
🚀 ========================================

📍 Slack Events URL: https://slack-bot-1-5oui.onrender.com/slack/events
🔍 Healthcheck: GET http://localhost:3000/

✨ Ready to receive Slack events!
   - URL verification will respond with JSON
   - Events will be processed by Bolt handlers
```

### 2. Test URL verification locally
```bash
curl -X POST http://localhost:3000/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test123"}'
```

Expected response:
```json
{"challenge":"test123"}
```

### 3. Test healthcheck
```bash
curl http://localhost:3000/
```

Expected: `admission-bot up`

## Environment Variables Required

Make sure these are set in Render:
- `SLACK_SIGNING_SECRET` - From Slack App Basic Information
- `SLACK_BOT_TOKEN` - Starts with `xoxb-`
- `ANNOUNCE_CHANNEL_ID` - Channel where users join
- `BATCH2_CHANNEL_ID` - Batch 2 destination channel
- `BATCH3_CHANNEL_ID` - Batch 3 destination channel
- `PORT` - Automatically set by Render

## Troubleshooting

### Issue: "Invalid signature"
- **Cause**: `SLACK_SIGNING_SECRET` is incorrect or missing
- **Fix**: Copy the correct signing secret from Slack App → Basic Information

### Issue: "Not receiving events"
- **Cause**: Event subscriptions not configured
- **Fix**: Enable events in Slack App → Event Subscriptions:
  - `member_joined_channel`
  - `message.im`

### Issue: "Bot not responding to DMs"
- **Cause**: Missing bot scopes
- **Fix**: Add these scopes in Slack App → OAuth & Permissions:
  - `chat:write`, `im:write`, `im:history`, `users:read`
  - `channels:read`, `groups:read`, `channels:manage`, `groups:write`

### Issue: "Already in channel" errors
- **Cause**: Bot is not a member of destination channels
- **Fix**: Invite the bot to all three channels:
  - `#program_announcement` (or your ANNOUNCE_CHANNEL_ID)
  - `#batch-2` (or your BATCH2_CHANNEL_ID)
  - `#batch-3` (or your BATCH3_CHANNEL_ID)

## Logs to Look For

### Successful URL Verification
```
📥 Received Slack request: type = "url_verification"
✅ URL verification challenge received: 3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P
```

### Successful Event Processing
```
📥 Received Slack request: type = "event_callback"
📩 Event callback received: event_type = "member_joined_channel"
✅ Event processed successfully
```

### User Flow
```
📩 Event callback received: event_type = "member_joined_channel"
✅ Event processed successfully
📩 Event callback received: event_type = "message"
✅ Event processed successfully
```

## Architecture Notes

- **Express server**: Manual setup for full control over URL verification
- **Slack Bolt**: Used for event handling (`app.event`, `app.message`)
- **Raw body middleware**: Required for Slack's signature verification
- **Asynchronous processing**: Events acknowledged immediately, processed async
- **In-memory state**: `dmState` Map tracks user conversation flow
- **No database**: Simple deployment, state doesn't persist across restarts

## Next Steps

1. ✅ Deploy the fixed code
2. ✅ Verify URL in Slack Event Subscriptions
3. ✅ Test by joining the announcement channel
4. ✅ Verify DM conversation flow works
5. ✅ Confirm user gets invited to correct batch channel

## Success Criteria

- [ ] Slack Event Subscriptions shows "✅ Verified"
- [ ] Render logs show URL verification success
- [ ] New users joining announcement channel receive DM
- [ ] Bot collects name and batch correctly
- [ ] Users are invited to correct batch channel
- [ ] No Slack retry loops in logs

---

**Deployment completed successfully!** 🎉
