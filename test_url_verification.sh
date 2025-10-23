#!/bin/bash

# Test script for Slack URL verification fix
# Run this AFTER starting the server with: npm start

echo "================================================"
echo "  Testing Slack URL Verification Fix"
echo "================================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Healthcheck
echo "Test 1: Healthcheck"
echo "-------------------"
echo "Sending: GET http://localhost:3000/"
HEALTH_RESPONSE=$(curl -s http://localhost:3000/)
if [ "$HEALTH_RESPONSE" = "admission-bot up" ]; then
    echo -e "${GREEN}✅ PASS${NC}: Healthcheck returned: $HEALTH_RESPONSE"
else
    echo -e "${RED}❌ FAIL${NC}: Expected 'admission-bot up', got: $HEALTH_RESPONSE"
fi
echo ""

# Test 2: URL Verification Challenge
echo "Test 2: URL Verification Challenge"
echo "-----------------------------------"
echo "Sending: POST /slack/events with url_verification"
CHALLENGE_RESPONSE=$(curl -s -X POST http://localhost:3000/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test_challenge_12345"}')

EXPECTED='{"challenge":"test_challenge_12345"}'
if [ "$CHALLENGE_RESPONSE" = "$EXPECTED" ]; then
    echo -e "${GREEN}✅ PASS${NC}: URL verification returned correct JSON"
    echo "Response: $CHALLENGE_RESPONSE"
else
    echo -e "${RED}❌ FAIL${NC}: URL verification response incorrect"
    echo "Expected: $EXPECTED"
    echo "Got: $CHALLENGE_RESPONSE"
fi
echo ""

# Test 3: Verify JSON Content-Type
echo "Test 3: Response Headers"
echo "------------------------"
echo "Checking Content-Type header..."
HEADERS=$(curl -s -i -X POST http://localhost:3000/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test123"}' | grep -i "content-type")

if [[ $HEADERS == *"application/json"* ]]; then
    echo -e "${GREEN}✅ PASS${NC}: Content-Type is application/json"
    echo "$HEADERS"
else
    echo -e "${YELLOW}⚠️  WARNING${NC}: Content-Type might not be application/json"
    echo "$HEADERS"
fi
echo ""

# Test 4: Invalid JSON handling
echo "Test 4: Invalid JSON Handling"
echo "------------------------------"
echo "Sending: Invalid JSON payload"
ERROR_RESPONSE=$(curl -s -X POST http://localhost:3000/slack/events \
  -H "Content-Type: application/json" \
  -d 'this is not json')

if [[ $ERROR_RESPONSE == *"error"* ]] || [[ $ERROR_RESPONSE == "" ]]; then
    echo -e "${GREEN}✅ PASS${NC}: Server handles invalid JSON gracefully"
    echo "Response: $ERROR_RESPONSE"
else
    echo -e "${YELLOW}⚠️  INFO${NC}: Response: $ERROR_RESPONSE"
fi
echo ""

# Summary
echo "================================================"
echo "  Test Summary"
echo "================================================"
echo ""
echo "If all tests passed, your server is ready for Slack!"
echo ""
echo "Next steps:"
echo "1. Deploy to Render: git push origin main"
echo "2. Go to Slack Event Subscriptions"
echo "3. Enter URL: https://slack-bot-1-5oui.onrender.com/slack/events"
echo "4. Click Save - should see ✅ Verified"
echo ""
echo "================================================"
