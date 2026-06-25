# Chatting Bots Admin

Multi-bot Discord selfbot system powered by OpenRouter AI. Run multiple user accounts that auto-chat in a Discord channel with humanized responses.

## What It Does

- Connects to Discord using **user tokens** (not bot tokens)
- Multiple accounts chat in the same channel automatically
- AI generates context-aware replies based on the topic and recent messages
- Simulates typing before sending messages
- Configurable personality, talking style, and chat behavior
- Web dashboard to manage everything

## Requirements

- **Node.js 18+** (tested on Node.js 24)
- **PostgreSQL database** (Railway, Supabase, Neon, or any PostgreSQL host)
- **OpenRouter API key** (free tier available at https://openrouter.ai)
- **Discord user tokens** (the tokens for your alt accounts)

## Setup Guide

### Step 1: Get a PostgreSQL Database

1. Go to https://supabase.com (free tier) or https://neon.tech (free tier)
2. Create a new project
3. Copy the **connection string** (it looks like `postgresql://postgres:password@host:5432/postgres`)
4. Save it somewhere — you'll need it in Step 3

### Step 2: Get an OpenRouter API Key

1. Go to https://openrouter.ai
2. Sign up / log in
3. Go to **Keys** page
4. Create a new API key
5. Copy it — it starts with `sk-or-v1-`

### Step 3: Get Discord User Tokens

> **Warning:** Using user tokens (selfbots) violates Discord's Terms of Service. Your accounts could be banned. Use alt accounts at your own risk.

1. Open Discord in **Chrome** (browser, not the app)
2. Press `F12` to open Developer Tools
3. Go to the **Network** tab
4. Type a message in any channel and send it
5. In the Network tab, find the request to `messages`
6. Click on it, go to **Headers** tab
7. Find `Authorization` in the Request Headers
8. Copy the value — that's your user token

Repeat for each account you want to add.

### Step 4: Deploy on Railway

1. Fork this repo to your GitHub account
2. Go to https://railway.app
3. Click **New Project** > **Deploy from GitHub repo**
4. Select your forked repo
5. Add these **Environment Variables**:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your PostgreSQL connection string from Step 1 |
| `AI_API_KEY` | Your OpenRouter API key from Step 2 |
| `PORT` | `3000` |

6. Railway will auto-deploy. Wait for it to finish.

### Step 5: Configure via Dashboard

1. Open your Railway app URL (something like `https://your-app.up.railway.app`)
2. You'll see the dashboard

#### Settings Tab (do this first):

1. Paste your **OpenRouter API Key** (if you didn't set `AI_API_KEY` env var)
2. Set **Server / Guild ID** — right-click your Discord server name > Copy Server ID
3. Set **Channel ID** — right-click the channel > Copy Channel ID
4. Customize the **Talking Style** (default is Gen Z texting style)
5. Click **Save Settings**

> To get IDs: Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click.

#### Bots Tab:

1. Enter a **Bot Name** (anything, just for display)
2. Paste the **User Token** from Step 3
3. Pick a **Personality**
4. Click **Add Bot**
5. Click **Start** next to the bot
6. Repeat for each account

#### Dashboard Tab:

- See which bots are online/offline
- Change the **Topic** that bots discuss
- **Start All / Stop All** buttons

## Configuration Reference

### Chat Behavior (Settings Tab)

| Setting | Default | What It Does |
|---------|---------|--------------|
| Topic | `what is the best discord server and why` | What bots talk about |
| Min Delay | `8000` (8s) | Minimum time between messages |
| Max Delay | `25000` (25s) | Maximum time between messages |
| Typing Duration Min | `3000` (3s) | How long "typing..." shows before sending |
| Typing Duration Max | `8000` (8s) | Max typing duration |
| Max Message Length | `200` | Character limit for bot messages |
| Topic Change Interval | `30` (min) | Auto-change topic every N minutes |

### Talking Style (Custom Prompt)

The custom prompt is injected into every AI request. Examples:

**Gen Z texting (default):**
```
talk like gen z. use abbreviations like ngl, fr, no cap, lowkey. lowercase everything. short 1-2 sentences. never use emojis. be a little unhinged.
```

**Gamer:**
```
talk like a gamer. use terms like gg, diff, carry, throw, clutch. be competitive. react to everything like its a ranked match.
```

**Chill:**
```
super chill and laid back. use words like vibe, chill, relax. short messages. agree with people. never start arguments.
```

**Toxic:**
```
be slightly toxic but funny. roast people playfully. use words like mid, trash, cope, seethe. keep it lighthearted.
```

### Personality Options

- **Friendly** — warm, positive, agreeable
- **Funny** — tries to be humorous, makes jokes
- **Chill** — laid back, goes with the flow
- **Nerdy** — uses technical language, overthinks things
- **Sarcastic** — ironic, dry humor
- **Hype** — enthusiastic, uses caps, very energetic
- **Quiet** — rarely speaks, short one-word replies

## Running Locally

```bash
# Clone the repo
git clone https://github.com/your-username/Customer2.git
cd Customer2

# Install dependencies
npm install

# Create .env file
copy .env.example .env
# Edit .env with your DATABASE_URL, AI_API_KEY, PORT

# Start
npm start
```

Dashboard opens at `http://localhost:3000`.

## How It Works

1. **Bot Manager** connects each account to Discord via WebSocket (gateway)
2. On a timer (min_delay to max_delay), each bot:
   - Simulates typing for a random duration
   - Sends the topic + recent chat history to OpenRouter AI
   - AI generates a contextual reply
   - Bot sends the reply to the channel
3. All bots share the same recent messages for context
4. A 3-second global cooldown prevents bots from spamming simultaneously

## Troubleshooting

### Bots connect but don't send messages

- Check OpenRouter API key is valid (Settings tab)
- Check Server ID and Channel ID are set correctly
- Check Railway logs for `401: Unauthorized` errors

### `401: Unauthorized` on chat

- Your Discord token might be invalid or expired — get a fresh one
- Discord may have flagged the token — try a different account

### `OpenRouter Error: 401 User not found`

- Your OpenRouter API key is invalid or expired
- Go to https://openrouter.ai/keys and generate a new one

### Bot shows offline

- Token might be wrong — double-check the full token
- Check Railway logs for the specific error message

### Database errors

- Make sure `DATABASE_URL` is set and correct
- Make sure the database allows connections from external IPs (Supabase/Neon do this by default)

## Tech Stack

- **discord.js v14** — WebSocket gateway connection
- **OpenAI SDK** — OpenRouter API client (compatible API)
- **Express** — web dashboard server
- **PostgreSQL** — stores bots, settings
- **Railway** — hosting

## License

For personal use only. Using selfbots violates Discord ToS.
