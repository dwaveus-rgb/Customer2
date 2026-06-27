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

const REACTION_EMOJIS = [
  '👍', '😂', '❤️', '🔥', '💯', '💀', '😭', '🤣',
  '😎', '🤔', '👀', '😮', '🙌', '😤', '🫡', '🤡',
  '✋', '🤝', '💅', '🧠', '📈', '📉', '⚡', '🎯'
];

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
    this.maxRecent = 20;
    this.isRunning = false;
    this.cooldowns = new Map();
    this.globalLastMessage = 0;
    this.ready = false;
    this.offTopicStart = null;
    this.lastRedirectTime = 0;
    this.repliedMessages = new Set();
    this.lastMemberMessage = 0;
    this.isHandlingMember = false;
    this.lastTimerBotId = null;
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
      if (message.channel.id !== botData.channel_id) return;

      // Member message — only first bot by Map key order processes it
      if (!message.author.bot) {
        const firstBotId = [...this.bots.keys()][0];
        if (botData.id !== firstBotId) return;

        this.isHandlingMember = true;
        this.lastMemberMessage = Date.now();

        const msgData = {
          sender: message.author.username,
          text: message.content,
          botId: null,
          id: message.id,
          timestamp: Date.now()
        };
        this.recentMessages.push(msgData);
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

        await this.handleMemberMessage(message, botData.channel_id);
        return;
      }

      // Other bot message
      if (message.author.id === client.user.id) return;
      const firstBotId = [...this.bots.keys()][0];
      if (botData.id !== firstBotId) return;

      const msgData = {
        sender: message.author.username,
        text: message.content,
        botId: 'other',
        id: message.id,
        timestamp: Date.now()
      };
      this.recentMessages.push(msgData);
      if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
    });

    client.on(Events.Error, (err) => {
      console.error(`[BotManager] WebSocket error for ${botData.name}:`, err.message);
    });

    try {
      console.log(`[BotManager] Attempting login for "${botData.name}"...`);
      await client.login(botData.token);
    } catch (err) {
      console.error(`[BotManager] Failed to start "${botData.name}": ${err.message}`);
      this.starting?.delete(botData.id);
      await db.updateBot(botData.id, { is_active: 0 });
    }
  }

  async handleMemberMessage(message, channelId) {
    if (this.repliedMessages.has(message.id)) return;
    this.repliedMessages.add(message.id);
    if (this.repliedMessages.size > 500) {
      const first = this.repliedMessages.values().next().value;
      this.repliedMessages.delete(first);
    }
    if (!this.gemini) return;

    try {
      const topic = await db.getSetting('topic') || 'general conversation';
      const customPrompt = await db.getSetting('custom_prompt') || '';
      const maxLen = parseInt(await db.getSetting('max_length') || '200');
      const reactionChance = parseInt(await db.getSetting('reaction_chance') || '20');
      const replyDelayMin = parseInt(await db.getSetting('reply_delay_min') || '2000');
      const replyDelayMax = parseInt(await db.getSetting('reply_delay_max') || '8000');
      const followUpDelayMin = parseInt(await db.getSetting('follow_up_delay_min') || '5000');
      const followUpDelayMax = parseInt(await db.getSetting('follow_up_delay_max') || '15000');

      this.scheduleReaction(message, channelId, reactionChance).catch(() => {});

      const botEntries = [...this.bots.entries()];
      if (botEntries.length === 0) return;

      // Pick first responder — exclude the bot that just posted via timer to avoid self-reply
      let eligibleBots = botEntries;
      if (this.lastTimerBotId) {
        const filtered = botEntries.filter(([id]) => id !== this.lastTimerBotId);
        if (filtered.length > 0) eligibleBots = filtered;
      }
      const firstBotIdx = Math.floor(Math.random() * eligibleBots.length);
      const firstBotData = eligibleBots[firstBotIdx][1].data;

      const replyDelay = this.randomDelay(replyDelayMin, replyDelayMax);
      await this.delay(replyDelay);

      if (!this.bots.has(firstBotData.id)) return;

      const firstReply = await this.gemini.generateReplyToMessage(
        firstBotData.name, firstBotData.personality, topic, customPrompt,
        message.author.username, message.content,
        this.recentMessages.slice(-10), maxLen
      );

      if (firstReply && firstReply.length > 0 && !this.isDuplicateMessage(firstReply)) {
        const typingDuration = this.randomDelay(
          parseInt(await db.getSetting('typing_min') || '3000'),
          parseInt(await db.getSetting('typing_max') || '8000')
        );
        await this.simulateTyping(firstBotData.token, channelId, typingDuration);
        await rawFetch(firstBotData.token, 'POST', `/channels/${channelId}/messages`, { content: firstReply });
        this.globalLastMessage = Date.now();
        this.recentMessages.push({ sender: firstBotData.name, text: firstReply, botId: firstBotData.id, timestamp: Date.now() });
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
        console.log(`[BotManager] ${firstBotData.name}: ${firstReply}`);
      }

      // Follow-up bot responds to the member's message
      if (botEntries.length > 1) {
        const availableFollowUps = botEntries.filter(([id]) => id !== firstBotData.id && id !== this.lastTimerBotId);
        if (availableFollowUps.length > 0) {
          const followUpData = availableFollowUps[Math.floor(Math.random() * availableFollowUps.length)][1].data;

          const followDelay = this.randomDelay(followUpDelayMin, followUpDelayMax);
          await this.delay(followDelay);

          if (!this.bots.has(followUpData.id)) return;

          const followReply = await this.gemini.generateFollowUp(
            followUpData.name, followUpData.personality, topic, customPrompt,
            message.author.username, message.content,
            this.recentMessages.slice(-10), maxLen
          );

          if (followReply && followReply.length > 0 && !this.isDuplicateMessage(followReply)) {
            const typingDuration = this.randomDelay(
              parseInt(await db.getSetting('typing_min') || '3000'),
              parseInt(await db.getSetting('typing_max') || '8000')
            );
            await this.simulateTyping(followUpData.token, channelId, typingDuration);
            await rawFetch(followUpData.token, 'POST', `/channels/${channelId}/messages`, { content: followReply });
            this.globalLastMessage = Date.now();
            this.recentMessages.push({ sender: followUpData.name, text: followReply, botId: followUpData.id, timestamp: Date.now() });
            if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
            console.log(`[BotManager] ${followUpData.name}: ${followReply}`);
          }
        }
      }
    } catch (err) {
      console.error(`[BotManager] Message handling error: ${err.message}`);
    } finally {
      this.isHandlingMember = false;
      this.lastTimerBotId = null;
    }
  }

  isDuplicateMessage(text) {
    const recent = this.recentMessages.slice(-5);
    const lower = text.toLowerCase().trim();
    for (const msg of recent) {
      const msgLower = msg.text.toLowerCase().trim();
      if (msgLower === lower) return true;
      if (lower.length > 20 && msgLower.includes(lower)) return true;
      if (msgLower.length > 20 && lower.includes(msgLower)) return true;
    }
    return false;
  }

  scheduleActivity(botId) {
    const runChat = async () => {
      if (!this.bots.has(botId)) return;

      const entry = this.bots.get(botId);
      const botData = entry.data;

      const minCooldown = parseInt(await db.getSetting('min_delay') || '15000');
      const maxCooldown = parseInt(await db.getSetting('max_delay') || '45000');
      const now = Date.now();
      const botCooldown = this.cooldowns.get(botId) || 0;

      if (now < botCooldown) {
        setTimeout(runChat, botCooldown - now + 1000);
        return;
      }

      // Pause timer chat for 60 seconds after a member message
      const timeSinceMemberMsg = now - this.lastMemberMessage;
      if (timeSinceMemberMsg < 60000) {
        setTimeout(runChat, 60000 - timeSinceMemberMsg + 5000);
        return;
      }

      // Don't send while handling a member message
      if (this.isHandlingMember) {
        setTimeout(runChat, 5000);
        return;
      }

      // Global gap: at least 10 seconds between ANY bot messages
      const globalMinGap = 10000;
      if (now - this.globalLastMessage < globalMinGap) {
        setTimeout(runChat, globalMinGap + 2000);
        return;
      }

      try {
        const typingDuration = this.randomDelay(
          parseInt(await db.getSetting('typing_min') || '3000'),
          parseInt(await db.getSetting('typing_max') || '8000')
        );

        const topic = await db.getSetting('topic') || 'general conversation';
        const maxLen = parseInt(await db.getSetting('max_length') || '200');
        const customPrompt = await db.getSetting('custom_prompt') || '';

        const reply = await this.gemini.generateReply(
          botData.name, botData.personality, topic,
          this.recentMessages.slice(-10), maxLen, customPrompt
        );

        if (!reply || reply.length === 0 || this.isDuplicateMessage(reply)) {
          if (this.bots.has(botId)) {
            setTimeout(runChat, this.randomDelay(minCooldown, maxCooldown));
          }
          return;
        }

        await this.simulateTyping(botData.token, botData.channel_id, typingDuration);
        await rawFetch(botData.token, 'POST', `/channels/${botData.channel_id}/messages`, { content: reply });

        this.globalLastMessage = Date.now();
        this.lastTimerBotId = botId;
        const cooldownTime = Date.now() + this.randomDelay(minCooldown, maxCooldown);
        this.cooldowns.set(botId, cooldownTime);

        this.recentMessages.push({ sender: botData.name, text: reply, botId: botData.id, timestamp: Date.now() });
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
        console.log(`[BotManager] ${botData.name}: ${reply}`);
      } catch (err) {
        console.error(`[BotManager] Chat error for ${botData.name}: ${err.message}`);
      }

      if (this.bots.has(botId)) {
        const nextDelay = this.randomDelay(minCooldown, maxCooldown);
        setTimeout(runChat, nextDelay);
      }
    };

    const initialDelay = this.randomDelay(15000, 30000);
    setTimeout(runChat, initialDelay);
  }

  async scheduleReaction(message, channelId, reactionChance) {
    if (Math.random() * 100 > reactionChance) return;
    const botEntries = [...this.bots.entries()];
    if (botEntries.length === 0) return;

    const reactionDelay = this.randomDelay(2000, 10000);
    await this.delay(reactionDelay);

    const [botId, entry] = botEntries[Math.floor(Math.random() * botEntries.length)];
    if (!this.bots.has(botId)) return;

    const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
    try {
      const encodedEmoji = encodeURIComponent(emoji);
      await rawFetch(entry.data.token, 'PUT', `/channels/${channelId}/messages/${message.id}/reactions/${encodedEmoji}/@me`);
      console.log(`[BotManager] ${entry.data.name} reacted ${emoji} to ${message.author.username}`);
    } catch (err) {}
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
    const ids = [...this.bots.keys()];
    for (const id of ids) {
      await this.stopBot(id);
    }
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

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
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
