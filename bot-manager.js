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
    this.processingMessage = false;
    this.offTopicStart = null;
    this.lastRedirectTime = 0;
    this.repliedMessages = new Set();
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

      // Start idle topic kickstarter for this bot
      this.scheduleIdleKick(botData.id);
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
      if (message.author.bot) return;

      const msgData = {
        sender: message.author.username,
        text: message.content,
        botId: null,
        id: message.id
      };
      this.recentMessages.push(msgData);
      if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

      // Only first bot in the bots map processes member messages (prevents duplicate handling)
      const firstBotId = [...this.bots.keys()][0];
      if (botData.id !== firstBotId) return;

      await this.handleMemberMessage(message, botData.channel_id);
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.channel.id !== botData.channel_id) return;
      if (!message.author.bot) return;
      if (message.author.id === client.user.id) return;

      const msgData = {
        sender: message.author.username,
        text: message.content,
        botId: 'other',
        id: message.id
      };
      this.recentMessages.push(msgData);
      if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
    });

    client.on(Events.Error, (err) => {
      console.error(`[BotManager] WebSocket error for ${botData.name}:`, err.message);
    });

    client.on(Events.Debug, (msg) => {
      if (msg.includes('Heartbeat') || msg.includes('Ready')) return;
      console.log(`[BotManager] Debug ${botData.name}: ${msg}`);
    });

    try {
      console.log(`[BotManager] Attempting login for "${botData.name}"...`);
      await client.login(botData.token);
      console.log(`[BotManager] Login call succeeded for "${botData.name}", waiting for READY...`);
    } catch (err) {
      console.error(`[BotManager] Failed to start "${botData.name}": ${err.message}`);
      this.starting?.delete(botData.id);
      await db.updateBot(botData.id, { is_active: 0 });
    }
  }

  async handleMemberMessage(message, channelId) {
    if (this.processingMessage) return;
    this.processingMessage = true;

    try {
      const topic = await db.getSetting('topic') || 'general conversation';
      const customPrompt = await db.getSetting('custom_prompt') || '';
      const maxLen = parseInt(await db.getSetting('max_length') || '200');
      const reactionChance = parseInt(await db.getSetting('reaction_chance') || '20');
      const replyDelayMin = parseInt(await db.getSetting('reply_delay_min') || '2000');
      const replyDelayMax = parseInt(await db.getSetting('reply_delay_max') || '8000');
      const followUpDelayMin = parseInt(await db.getSetting('follow_up_delay_min') || '5000');
      const followUpDelayMax = parseInt(await db.getSetting('follow_up_delay_max') || '15000');
      const offTopicTolerance = parseInt(await db.getSetting('off_topic_tolerance') || '5') * 60000;
      const redirectCooldown = parseInt(await db.getSetting('redirect_cooldown') || '120') * 1000;

      // Random chance to react to the message
      this.scheduleReaction(message, channelId, reactionChance);

      // Pick first responder
      const botEntries = [...this.bots.entries()];
      if (botEntries.length === 0) return;

      const firstBotIdx = 0;
      const firstBotEntry = botEntries[firstBotIdx];
      const firstBotData = firstBotEntry[1].data;

      // First responder replies after short delay
      const replyDelay = this.randomDelay(replyDelayMin, replyDelayMax);
      await this.delay(replyDelay);

      if (!this.bots.has(firstBotData.id)) return;

      const firstReply = await this.gemini.generateReplyToMessage(
        firstBotData.name, firstBotData.personality, topic, customPrompt,
        message.author.username, message.content,
        this.recentMessages.slice(-10), maxLen
      );

      if (firstReply && firstReply.length > 0) {
        const typingDuration = this.randomDelay(
          parseInt(await db.getSetting('typing_min') || '3000'),
          parseInt(await db.getSetting('typing_max') || '8000')
        );
        await this.simulateTyping(firstBotData.token, channelId, typingDuration);
        await rawFetch(firstBotData.token, 'POST', `/channels/${channelId}/messages`, { content: firstReply });
        this.globalLastMessage = Date.now();
        this.recentMessages.push({ sender: firstBotData.name, text: firstReply, botId: firstBotData.id });
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
        console.log(`[BotManager] ${firstBotData.name}: ${firstReply}`);
      }

      // Follow-up bot(s) respond to first bot's reply
      if (botEntries.length > 1 && firstReply) {
        const followUpIdx = 1;
        if (followUpIdx < botEntries.length) {
          const followUpEntry = botEntries[followUpIdx];
          const followUpData = followUpEntry[1].data;

          const followDelay = this.randomDelay(followUpDelayMin, followUpDelayMax);
          await this.delay(followDelay);

          if (!this.bots.has(followUpData.id)) return;

          const followReply = await this.gemini.generateFollowUp(
            followUpData.name, followUpData.personality, topic, customPrompt,
            firstBotData.name, firstReply,
            this.recentMessages.slice(-10), maxLen
          );

          if (followReply && followReply.length > 0) {
            const typingDuration = this.randomDelay(
              parseInt(await db.getSetting('typing_min') || '3000'),
              parseInt(await db.getSetting('typing_max') || '8000')
            );
            await this.simulateTyping(followUpData.token, channelId, typingDuration);
            await rawFetch(followUpData.token, 'POST', `/channels/${channelId}/messages`, { content: followReply });
            this.globalLastMessage = Date.now();
            this.recentMessages.push({ sender: followUpData.name, text: followReply, botId: followUpData.id });
            if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
            console.log(`[BotManager] ${followUpData.name}: ${followReply}`);
          }
        }
      }

      // Topic tracking: check if conversation is off-topic
      const recentTexts = this.recentMessages.slice(-5);
      const isOnTopic = await this.gemini.checkOnTopic(message.content, topic);
      if (!isOnTopic) {
        if (!this.offTopicStart) this.offTopicStart = Date.now();
      } else {
        this.offTopicStart = null;
      }

      // Redirect if off-topic too long
      if (this.offTopicStart && (Date.now() - this.offTopicStart > offTopicTolerance)) {
        const sinceLastRedirect = Date.now() - this.lastRedirectTime;
        if (sinceLastRedirect > redirectCooldown) {
          const redirectBotEntry = botEntries[Math.floor(Math.random() * botEntries.length)];
          const redirectBot = redirectBotEntry[1].data;

          const redirectDelay = this.randomDelay(replyDelayMin, replyDelayMax);
          await this.delay(redirectDelay);

          if (this.bots.has(redirectBot.id)) {
            const redirectMsg = await this.gemini.generateRedirect(
              redirectBot.name, redirectBot.personality, topic, customPrompt,
              this.recentMessages.slice(-10), maxLen
            );

            if (redirectMsg && redirectMsg.length > 0) {
              const typingDuration = this.randomDelay(
                parseInt(await db.getSetting('typing_min') || '3000'),
                parseInt(await db.getSetting('typing_max') || '8000')
              );
              await this.simulateTyping(redirectBot.token, channelId, typingDuration);
              await rawFetch(redirectBot.token, 'POST', `/channels/${channelId}/messages`, { content: redirectMsg });
              this.globalLastMessage = Date.now();
              this.recentMessages.push({ sender: redirectBot.name, text: redirectMsg, botId: redirectBot.id });
              if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
              console.log(`[BotManager] ${redirectBot.name} (redirect): ${redirectMsg}`);
              this.lastRedirectTime = Date.now();
              this.offTopicStart = null;
            }
          }
        }
      }
    } catch (err) {
      console.error(`[BotManager] Message handling error: ${err.message}`);
    } finally {
      this.processingMessage = false;
    }
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
    } catch (err) {
      // Reactions may fail silently, that's fine
    }
  }

  async scheduleIdleKick(botId) {
    const runIdleKick = async () => {
      if (!this.bots.has(botId)) return;

      const idleMinutes = parseInt(await db.getSetting('idle_kick_minutes') || '30');
      const lastMsg = this.recentMessages[this.recentMessages.length - 1];
      const timeSinceLastMsg = lastMsg ? Date.now() - (lastMsg.timestamp || Date.now()) : 0;

      if (timeSinceLastMsg < idleMinutes * 60000 && this.recentMessages.length > 0) {
        if (this.bots.has(botId)) {
          setTimeout(runIdleKick, 60000);
        }
        return;
      }

      const entry = this.bots.get(botId);
      if (!entry) return;

      const topic = await db.getSetting('topic') || 'general conversation';
      const customPrompt = await db.getSetting('custom_prompt') || '';
      const maxLen = parseInt(await db.getSetting('max_length') || '200');

      try {
        const starter = await this.gemini.generateTopicStarter(
          entry.data.name, entry.data.personality, topic, customPrompt
        );
        if (starter && starter.length > 0) {
          const typingDuration = this.randomDelay(
            parseInt(await db.getSetting('typing_min') || '3000'),
            parseInt(await db.getSetting('typing_max') || '8000')
          );
          await this.simulateTyping(entry.data.token, entry.data.channel_id, typingDuration);
          await rawFetch(entry.data.token, 'POST', `/channels/${entry.data.channel_id}/messages`, { content: starter });
          this.globalLastMessage = Date.now();
          this.recentMessages.push({ sender: entry.data.name, text: starter, botId: entry.data.id });
          if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();
          console.log(`[BotManager] ${entry.data.name} (idle kick): ${starter}`);
        }
      } catch (err) {
        console.error(`[BotManager] Idle kick error for ${entry.data.name}: ${err.message}`);
      }

      if (this.bots.has(botId)) {
        setTimeout(runIdleKick, randomDelay(300000, 600000));
      }
    };

    setTimeout(runIdleKick, this.randomDelay(60000, 180000));
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

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = new BotManager();
