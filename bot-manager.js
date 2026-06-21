require('./user-token-patch');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const GeminiChat = require('./gemini');
const db = require('./db');

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
    const key = await db.getSetting('ai_api_key');
    this.gemini = new GeminiChat(key || '');
    this.ready = true;
    console.log('[BotManager] Initialized');
  }

  async updateGeminiKey() {
    const key = await db.getSetting('ai_api_key');
    if (key && this.gemini) this.gemini.updateKey(key);
  }

  async startBot(botData) {
    if (this.bots.has(botData.id)) {
      console.log(`[BotManager] Bot "${botData.name}" already running`);
      return;
    }

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
      await db.logEvent('bot_online', botData.id, { name: botData.name });

      this.bots.set(botData.id, { client, data: botData });
      this.cooldowns.set(botData.id, 0);
      this.scheduleActivity(botData.id);
    });

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

    try {
      await client.login(botData.token);
    } catch (err) {
      console.error(`[BotManager] Failed to start "${botData.name}": ${err.message}`);
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
    await db.logEvent('bot_offline', botId, { name: entry.data.name });
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
        const channel = await client.channels.fetch(botData.channel_id);
        if (!channel) return;

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
          await this.simulateTyping(channel, typingDuration);

          await channel.send(reply);

          this.globalLastMessage = Date.now();
          const cooldownTime = Date.now() + this.randomDelay(minCooldown, maxCooldown);
          this.cooldowns.set(botId, cooldownTime);

          this.recentMessages.push({
            sender: botData.name,
            text: reply,
            botId: botId
          });
          if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

          await db.logChat(botId, botData.name, reply, botData.channel_id);
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

  async simulateTyping(channel, duration) {
    try {
      await channel.sendTyping();
      let remaining = duration;
      while (remaining > 10000) {
        await new Promise(r => setTimeout(r, 10000));
        remaining -= 10000;
        try { await channel.sendTyping(); } catch (e) { return; }
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

    const channel = await entry.client.channels.fetch(entry.data.channel_id);
    if (!channel) throw new Error('Channel not found');

    await channel.send(message);
    await db.logChat(botId, entry.data.name, message, entry.data.channel_id);
  }
}

module.exports = new BotManager();
