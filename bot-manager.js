require('./user-token-patch');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const GeminiChat = require('./gemini');
const db = require('./db');

const DISCORD_API = 'https://discord.com/api/v10';

function buildSuperProps() {
  const props = {
    os: 'windows',
    browser: 'chrome',
    device: '',
    system_locale: 'en-US',
    browser_version: '131.0.0.0',
    os_version: '10',
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: 361469,
    client_event_source: null
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

async function rawFetch(token, method, path, body) {
  const headers = {
    'Authorization': token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'X-Super-Properties': buildSuperProps(),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'UTC',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': 'https://discord.com/channels/@me',
    'Origin': 'https://discord.com'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${DISCORD_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[rawFetch] ${method} ${path} => ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`${res.status}: ${res.statusText} - ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

class BotManager {
  constructor() {
    this.bots = new Map();
    this.gemini = null;
    this.recentMessages = [];
    this.maxRecent = 15;
    this.isRunning = false;
    this.cooldowns = new Map();
    this.globalLastMessage = 0;
    this.ready = false;
  }

  async init() {
    let key = await db.getSetting('ai_api_key');
    if (!key && process.env.AI_API_KEY) {
      key = process.env.AI_API_KEY;
      await db.setSetting('ai_api_key', key);
      console.log('[BotManager] Loaded AI_API_KEY from env var');
    }
    this.gemini = new GeminiChat(key || '');
    this.ready = true;
    console.log('[BotManager] Initialized, AI key:', key ? key.slice(0, 8) + '...' : 'NOT SET');
  }

  async updateGeminiKey() {
    let key = await db.getSetting('ai_api_key');
    if (!key && process.env.AI_API_KEY) {
      key = process.env.AI_API_KEY;
      await db.setSetting('ai_api_key', key);
    }
    if (key && this.gemini) {
      this.gemini.updateKey(key);
      console.log('[BotManager] AI key updated:', key.slice(0, 8) + '...');
    } else {
      console.warn('[BotManager] No AI key found in DB or env');
    }
  }

  async startBot(botData) {
    if (this.bots.has(botData.id) || this.starting?.has(botData.id)) {
      console.log(`[BotManager] Bot "${botData.name}" already running or starting`);
      return;
    }
    if (!this.starting) this.starting = new Set();
    this.starting.add(botData.id);

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
      ]
    });

    client.once(Events.ClientReady, async () => {
      console.log(`[BotManager] ${client.user.tag} is online!`);
      await db.updateBot(botData.id, { is_active: 1 });
      this.starting?.delete(botData.id);

      this.bots.set(botData.id, { client, data: botData });
      this.cooldowns.set(botData.id, 0);
      this.scheduleActivity(botData.id);
    });

    setTimeout(async () => {
      if (!this.bots.has(botData.id)) {
        console.error(`[BotManager] Bot "${botData.name}" timed out waiting for READY event`);
        this.starting?.delete(botData.id);
        try { client.destroy(); } catch (e) {}
        await db.updateBot(botData.id, { is_active: 0 });
      }
    }, 30000);

    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (message.channel.id !== botData.channel_id) return;

      this.recentMessages.push({
        sender: message.author.username,
        text: message.content,
        botId: null
      });
      if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
    });

    client.on(Events.Error, (err) => {
      console.error(`[BotManager] WebSocket error for ${botData.name}:`, err.message);
    });

    client.on(Events.Debug, (msg) => {
      console.log(`[BotManager] Debug ${botData.name}: ${msg}`);
    });

    try {
      console.log(`[BotManager] Attempting login for "${botData.name}"...`);
      await client.login(botData.token);
      console.log(`[BotManager] Login call succeeded for "${botData.name}", waiting for READY...`);
    } catch (err) {
      console.error(`[BotManager] Failed to start "${botData.name}": ${err.message}`);
      console.error(`[BotManager] Stack: ${err.stack}`);
      this.starting?.delete(botData.id);
      await db.updateBot(botData.id, { is_active: 0 });
    }
  }

  async stopBot(botId) {
    const entry = this.bots.get(botId);
    if (!entry) return;

    entry.client.destroy();
    this.bots.delete(botId);
    this.cooldowns.delete(botId);
    await db.updateBot(botId, { is_active: 0 });
    console.log(`[BotManager] ${entry.data.name} stopped`);
  }

  async stopAll() {
    for (const [id] of this.bots) {
      await this.stopBot(id);
    }
  }

  scheduleActivity(botId) {
    const runChat = async () => {
      if (!this.bots.has(botId)) return;

      const entry = this.bots.get(botId);
      const botData = entry.data;
      const client = entry.client;

      const minCooldown = parseInt(await db.getSetting('min_delay') || '5000');
      const maxCooldown = parseInt(await db.getSetting('max_delay') || '15000');
      const now = Date.now();
      const botCooldown = this.cooldowns.get(botId) || 0;

      if (now < botCooldown) {
        const waitTime = botCooldown - now;
        setTimeout(runChat, waitTime + 1000);
        return;
      }

      const globalMinGap = 3000;
      if (now - this.globalLastMessage < globalMinGap) {
        setTimeout(runChat, globalMinGap + 1000);
        return;
      }

      try {
        const typingDuration = this.randomDelay(
          parseInt(await db.getSetting('typing_min') || '3000'),
          parseInt(await db.getSetting('typing_max') || '8000')
        );

        const topic = await db.getSetting('topic') || 'general conversation';
        const maxLen = parseInt(await db.getSetting('max_length') || '200');

        const reply = await this.gemini.generateReply(
          botData.name,
          botData.personality,
          topic,
          this.recentMessages.slice(-10),
          maxLen
        );

        if (reply && reply.length > 0) {
          await this.simulateTyping(botData.token, botData.channel_id, typingDuration);

          await rawFetch(botData.token, 'POST', `/channels/${botData.channel_id}/messages`, { content: reply });

          this.globalLastMessage = Date.now();
          const cooldownTime = Date.now() + this.randomDelay(minCooldown, maxCooldown);
          this.cooldowns.set(botId, cooldownTime);

          this.recentMessages.push({
            sender: botData.name,
            text: reply,
            botId: botId
          });
          if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

          console.log(`[BotManager] ${botData.name}: ${reply}`);
        }
      } catch (err) {
        console.error(`[BotManager] Chat error for ${botData.name}: ${err.message}`);
      }

      if (this.bots.has(botId)) {
        const nextDelay = this.randomDelay(
          parseInt(await db.getSetting('min_delay') || '5000'),
          parseInt(await db.getSetting('max_delay') || '15000')
        );
        setTimeout(runChat, nextDelay);
      }
    };

    const initialDelay = this.randomDelay(5000, 15000);
    setTimeout(runChat, initialDelay);
  }

  async simulateTyping(token, channelId, duration) {
    try {
      await rawFetch(token, 'POST', `/channels/${channelId}/typing`);
      let remaining = duration;
      while (remaining > 10000) {
        await new Promise(r => setTimeout(r, 10000));
        remaining -= 10000;
        try { await rawFetch(token, 'POST', `/channels/${channelId}/typing`); } catch (e) { return; }
      }
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, remaining));
      }
    } catch (e) {}
  }

  randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async startAll() {
    const bots = await db.getBots();
    for (let i = 0; i < bots.length; i++) {
      setTimeout(() => this.startBot(bots[i]), i * 3000);
    }
    this.isRunning = true;
  }

  getActiveBots() {
    const active = [];
    for (const [id, entry] of this.bots) {
      active.push({ id, name: entry.data.name, tag: entry.client.user?.tag });
    }
    return active;
  }

  async sendManualMessage(botId, message) {
    const entry = this.bots.get(botId);
    if (!entry) throw new Error('Bot not running');

    await rawFetch(entry.data.token, 'POST', `/channels/${entry.data.channel_id}/messages`, { content: message });
  }
}

module.exports = new BotManager();
