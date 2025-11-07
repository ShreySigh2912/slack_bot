# ⚠️ SLACK APP SETUP REQUIRED - DM Concierge Feature

## 🚨 IMPORTANT: You MUST update your Slack app configuration for the new DM feature to work!

---

## ✅ Step-by-Step Checklist

### **Step 1: Add Event Subscription** ⏰ 2 minutes

1. Go to: https://api.slack.com/apps
2. Select your app: **admission-bot**
3. Navigate to: **Event Subscriptions** (left sidebar)
4. Scroll to: **Subscribe to bot events**
5. Click: **"Add Bot User Event"**
6. Search for and add: **`message.im`**
7. Click: **"Save Changes"** (bottom of page)

**What it does**: Allows bot to receive direct messages from users

---

### **Step 2: Reinstall App** ⏰ 1 minute

**⚠️ CRITICAL**: Adding new events requires reinstalling the app!

1. Navigate to: **OAuth & Permissions** (left sidebar)
2. Scroll to top
3. Click: **"Reinstall App"** button
4. Review permissions
5. Click: **"Allow"**

**What it does**: Grants the app permission to receive DM events

---

### **Step 3: Verify Deployment** ⏰ 2-3 minutes

1. Go to: https://dashboard.render.com
2. Find your service: **slack-bot-1-5oui**
3. Check: **Latest Deployment** status
4. Should show: Commit `ef1ca83` - "feat: Add DM concierge..."
5. Wait for: ✅ **Deploy live**

**What to look for in logs**:
```
🚀 ========================================
✅  Slack Bot is RUNNING on port 10000
🚀 ========================================

📋 Features enabled:
   ✓ Member join → Batch selection
   ✓ DM concierge → Help menu
   ✓ Batch access modal
```

---

### **Step 4: Test the Feature** ⏰ 2 minutes

#### Test 1: Send DM
1. Open Slack
2. Find your bot in the Apps section
3. Send a message: **"hello"** or **"hi"**
4. **Expected**: Bot replies with help menu (two buttons)

#### Test 2: Click "Batch Access"
1. Click: **"🎓 Batch Access"**
2. **Expected**: Modal opens with Batch 2/3 options
3. Select a batch
4. Click: **"Confirm"**
5. **Expected**: Invited to selected batch channel

#### Test 3: Click "Nothing"
1. Send another DM: **"hey"**
2. Click: **"Nothing"**
3. **Expected**: Bot replies: "No problem! If you need anything later, just say hi. 👋"

#### Test 4: Existing Flow (Verify unchanged)
1. Join the lobby channel (LOBBY_CHANNEL_ID)
2. **Expected**: Bot DMs welcome with "Select Batch" button
3. Click button → Modal opens
4. **Expected**: Works exactly as before

---

## 📊 Current Configuration

### **Bot Token Scopes** (Should already have these)
- ✅ `chat:write`
- ✅ `im:write`
- ✅ `im:history`
- ✅ `users:read`
- ✅ `channels:read`
- ✅ `groups:read`
- ✅ `channels:manage`
- ✅ `groups:write`

### **Event Subscriptions**
- ✅ `member_joined_channel` (existing)
- ⚠️ `message.im` ← **YOU NEED TO ADD THIS**

---

## 🔗 Quick Links

- **Slack App Settings**: https://api.slack.com/apps
- **Render Dashboard**: https://dashboard.render.com
- **GitHub Repo**: https://github.com/ShreySigh2912/slack_bot
- **Latest Commit**: https://github.com/ShreySigh2912/slack_bot/commit/ef1ca83

---

## 🐛 Troubleshooting

### Problem: Bot doesn't respond to DMs

**Diagnosis**: Run this in Slack:
```
/invite @your-bot-name
(then send a DM)
```

**Solutions**:
1. ❌ **Event not added**: Go to Event Subscriptions → Add `message.im`
2. ❌ **App not reinstalled**: Go to OAuth & Permissions → Reinstall App
3. ❌ **Render not deployed**: Check Render dashboard for deployment status
4. ❌ **Wrong file**: Make sure you're using `app.js` not `index.js`

### Problem: "Missing scope" error

**Fix**: 
1. Go to OAuth & Permissions
2. Add missing scope (check logs for which one)
3. Reinstall App

### Problem: Modal doesn't open

**Possible causes**:
- Invalid trigger_id (expired after 3 seconds)
- Wrong action_id
- Slack API error

**Check Render logs** for error messages.

---

## 📋 Summary

**What Changed**:
- ✅ Code updated in `app.js`
- ✅ Pushed to GitHub
- ✅ Render will auto-deploy
- ⚠️ **YOU NEED TO**: Add `message.im` event subscription
- ⚠️ **YOU NEED TO**: Reinstall Slack app

**Files Modified**:
- `app.js` - Main implementation
- `DM_CONCIERGE_FEATURE.md` - Complete documentation

**Commits**:
- `ef1ca83` - feat: Add DM concierge with interactive help menu
- `3c368c1` - Fix: Slack URL verification with proper JSON response

**Next Actions**:
1. ⬜ Add `message.im` event subscription
2. ⬜ Reinstall Slack app
3. ⬜ Wait for Render deployment
4. ⬜ Test by sending DM to bot
5. ⬜ Verify help menu appears
6. ⬜ Test both buttons work

---

## ⏱️ Total Time Estimate

- Add event: **2 minutes**
- Reinstall app: **1 minute**
- Render deploy: **2-3 minutes** (automatic)
- Testing: **2 minutes**
- **Total: ~7-8 minutes** from now to fully working

---

**Status**: 🟡 Waiting for Slack app configuration (Steps 1-2 above)

Once you complete Steps 1-2, the feature will be live! 🚀
