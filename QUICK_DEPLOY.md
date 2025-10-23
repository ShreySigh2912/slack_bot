# Quick Deploy Checklist ✅

## Immediate Steps to Fix Slack URL Verification

### 1. Deploy to Render (Option A: Git Push)
```bash
cd /Users/shreysingh/admission_bot/slack_bot
git add index.js DEPLOY_FIX.md QUICK_DEPLOY.md
git commit -m "Fix: Slack URL verification with proper JSON response"
git push origin main
```

Wait 2-3 minutes for Render to rebuild and deploy.

### 2. Verify in Slack
1. Go to: https://api.slack.com/apps
2. Select your app: **admission-bot**
3. Navigate to: **Event Subscriptions**
4. Request URL should be: `https://slack-bot-1-5oui.onrender.com/slack/events`
5. Click **"Retry"** or **Save Changes**
6. ✅ You should see: **"Verified"**

### 3. Check Render Logs
Go to: https://dashboard.render.com → Your service → Logs

Look for:
```
✅ URL verification challenge received: <challenge>
```

---

## Alternative: Manual Render Deploy (Option B)

If Git push doesn't trigger auto-deploy:

1. Go to: https://dashboard.render.com
2. Find your service: **slack-bot-1-5oui**
3. Click: **"Manual Deploy"** → **"Deploy latest commit"**
4. Wait for build to complete
5. Follow steps 2-3 above

---

## Environment Variables to Check in Render

Make sure these are set (Dashboard → Service → Environment):

| Variable | Example | Where to Find |
|----------|---------|---------------|
| `SLACK_SIGNING_SECRET` | `abc123...` | Slack App → Basic Information |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack App → OAuth & Permissions |
| `ANNOUNCE_CHANNEL_ID` | `C01234567` | Slack channel → View details |
| `BATCH2_CHANNEL_ID` | `C02345678` | Slack channel → View details |
| `BATCH3_CHANNEL_ID` | `C03456789` | Slack channel → View details |
| `PORT` | (auto-set) | Render provides this |

---

## Testing After Deploy

### Test 1: URL Verification
Render logs should show:
```
📥 Received Slack request: type = "url_verification"
✅ URL verification challenge received: ...
```

### Test 2: Healthcheck
```bash
curl https://slack-bot-1-5oui.onrender.com/
```
Expected: `admission-bot up`

### Test 3: End-to-End Flow
1. Join `#program_announcement` channel with a test user
2. Bot should DM: "Welcome! What is your full name?"
3. Reply with name
4. Bot asks: "Which batch are you in? 2 or 3?"
5. Reply with `2` or `3`
6. Bot invites you to the correct batch channel

---

## What Was Fixed?

### Before (Broken)
- Slack sent URL verification challenge
- Server didn't respond with proper JSON format
- Slack showed error: "Your request URL didn't respond with the value of the challenge parameter"

### After (Fixed) ✅
```javascript
// When Slack sends URL verification:
if (body.type === 'url_verification') {
  return res.status(200).json({ challenge: body.challenge });
}
```

### Key Changes:
1. **Explicit JSON response** for URL verification
2. **Raw body middleware** (`express.raw()`) for signature verification
3. **Immediate acknowledgment** of events (prevents retries)
4. **Async event processing** with Bolt handlers
5. **Enhanced logging** with emojis for debugging

---

## Expected Timeline

- **Deploy**: 2-3 minutes (Render build)
- **Slack verification**: Instant (click Retry)
- **Testing**: 1-2 minutes (join channel, test DM flow)
- **Total**: ~5 minutes from push to working bot

---

## Success Indicators

✅ Render logs show: `admission-bot is RUNNING on port XXXX`  
✅ Slack Event Subscriptions shows: **Verified**  
✅ Healthcheck responds: `admission-bot up`  
✅ Bot sends DM when user joins channel  
✅ Bot collects name and batch correctly  
✅ Bot invites user to correct batch channel  

---

## Need Help?

### Check Render Logs
```
Dashboard → Service → Logs (top right)
```

### Check Slack Event Subscriptions
```
https://api.slack.com/apps → Your App → Event Subscriptions
```

### Common Issues

**Issue**: "Invalid signature"  
**Fix**: Check `SLACK_SIGNING_SECRET` in Render environment variables

**Issue**: "Not receiving events"  
**Fix**: Enable `member_joined_channel` and `message.im` in Event Subscriptions

**Issue**: "Cannot invite to channel"  
**Fix**: Invite the bot to all three channels first

---

**Ready to deploy!** 🚀
