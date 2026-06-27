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

class MessageQueue {
  constructor(botManager) {
    this.bm = botManager;
    this.queue = [];
    this.processing = false;
    this.lastSenderId = null;
    this.currentBotTyping = null;
    this.typingAbort = null;
    this.lastSendTime = 0;
    this.holdQueue = false;
    this.sentMessageIds = new Map();
  }

  enqueue(task) {
    this.queue.push(task);
    this.processQueue().catch(err => {
      console.error('[Queue] processQueue error:', err.message);
      this.processing = false;
    });
  }

  async pauseCurrentTyping() {
    if (this.typingAbort) {
      this.typingAbort.abort();
      this.typingAbort = null;
      this.currentBotTyping = null;
    }
  }

  clearQueue(filterFn) {
    if (filterFn) {
      this.queue = this.queue.filter(task => !filterFn(task));
    } else {
      this.queue = [];
    }
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        if (this.holdQueue) {
          await this.delay(500);
          continue;
        }

        const task = this.queue[0];

        if (task.type !== 'bot') {
          this.queue.shift();
          continue;
        }

        if (task.senderId === this.lastSenderId) {
          const otherIdx = this.queue.findIndex(t => t.type === 'bot' && t.senderId !== this.lastSenderId);
          if (otherIdx > 0) {
            const other = this.queue.splice(otherIdx, 1)[0];
            this.queue.unshift(other);
            console.log(`[Queue] Swapped ${task.senderName} with ${other.senderName} for turn-taking`);
            continue;
          }
        }

        const perMsgDelaySec = parseInt(await db.getSetting('per_message_delay') || '10');
        const perMsgDelayMs = Math.max(1000, perMsgDelaySec * 1000);
        const now = Date.now();
        if (!task.isMemberReply) {
          const waitMs = perMsgDelayMs - (now - this.lastSendTime);
          if (waitMs > 0) {
            await this.delay(waitMs);
          }
        }

        this.queue.shift();
        await this.sendBotTask(task);
      }
    } finally {
      this.processing = false;
    }
  }

  async sendBotTask(task) {
    const liveChannelId = await db.getSetting('channel_id');
    if (!liveChannelId) return;

    const charLen = task.content.length;
    const wordCount = task.content.split(/\s+/).length;
    const smartTypingMs = Math.min(Math.max(800 + charLen * 10 + wordCount * 60, 1200), 2500);
    const jitter = this.bm.randomDelay(-200, 200);
    const typingDuration = Math.max(1200, smartTypingMs + jitter);

    const abort = new AbortController();
    this.currentBotTyping = task.senderId;
    this.typingAbort = abort;

    try {
      console.log(`[Queue] ${task.senderName} typing (${typingDuration}ms)...`);
      await this.simulateTypingWithAbort(task.token, liveChannelId, typingDuration, abort.signal);
    } catch (e) {
      if (e.name === 'AbortError') {
        console.log(`[Queue] ${task.senderName} typing aborted`);
        this.currentBotTyping = null;
        this.typingAbort = null;
        this.lastSenderId = task.senderId;
        return;
      }
      this.currentBotTyping = null;
      this.typingAbort = null;
      return;
    }

    this.currentBotTyping = null;
    this.typingAbort = null;

    const content = task.content;
    const body = { content };
    if (task.replyToId) {
      const senderIds = this.sentMessageIds.get(task.senderId);
      const isOwnMessage = senderIds && senderIds.has(task.replyToId);
      if (!isOwnMessage) {
        const replyChance = parseInt(await db.getSetting('reply_chance') || '80');
        if (Math.random() * 100 < replyChance) {
          body.message_reference = { message_id: task.replyToId };
        }
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await rawFetch(task.token, 'POST', `/channels/${liveChannelId}/messages`, body);
        if (response && response.id) {
          if (!this.sentMessageIds.has(task.senderId)) {
            this.sentMessageIds.set(task.senderId, new Set());
          }
          this.sentMessageIds.get(task.senderId).add(response.id);
          const ids = this.sentMessageIds.get(task.senderId);
          if (ids.size > 100) {
            const first = ids.values().next().value;
            ids.delete(first);
          }
        }
        this.lastSenderId = task.senderId;
        this.lastSendTime = Date.now();
        this.bm.recentMessages.push({ sender: task.senderName, text: content, botId: task.senderId, timestamp: Date.now() });
        if (this.bm.recentMessages.length > this.bm.maxRecent) this.bm.recentMessages.shift();
        console.log(`[Queue] ${task.senderName}: ${content}`);
        return;
      } catch (err) {
        console.error(`[Queue] Failed to send ${task.senderName} (attempt ${attempt + 1}):`, err.message);
        if (attempt === 0) await this.delay(1500);
      }
    }

    this.lastSenderId = task.senderId;
    this.lastSendTime = Date.now();
  }

  simulateTypingWithAbort(token, channelId, duration, signal) {
    return new Promise(async (resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        await rawFetch(token, 'POST', `/channels/${channelId}/typing`);
        let remaining = duration;
        while (remaining > 10000) {
          if (signal.aborted) break;
          await new Promise(r => setTimeout(r, 10000));
          remaining -= 10000;
          try { await rawFetch(token, 'POST', `/channels/${channelId}/typing`); } catch (e) { break; }
        }
        if (!signal.aborted && remaining > 0) {
          await new Promise(r => setTimeout(r, remaining));
        }
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    });
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

class BotManager {
  constructor() {
    this.bots = new Map();
    this.gemini = null;
    this.recentMessages = [];
    this.maxRecent = 20;
    this.isRunning = false;
    this.cooldowns = new Map();
    this.ready = false;
    this.repliedMessages = new Set();
    this.lastMemberMessage = 0;
    this.msgQueue = new MessageQueue(this);
    this.processingMember = false;
    this.latestMemberMsg = null;
  }

  async loadApiKeys() {
    const keys = [];
    const primary = process.env.AI_API_KEY;
    if (primary) keys.push(primary);
    for (let i = 2; i <= 10; i++) {
      const envKey = process.env[`AI_API_KEY_${i}`];
      if (envKey && !keys.includes(envKey)) keys.push(envKey);
    }
    const fallback = process.env.AI_API_KEY_FALLBACK;
    if (fallback && !keys.includes(fallback)) keys.push(fallback);
    return keys;
  }

  async init() {
    const keys = await this.loadApiKeys();
    this.gemini = new GeminiChat(keys);
    this.ready = true;
    console.log('[BotManager] Initialized, keys loaded:', keys.length);
  }

  async updateGeminiKeys() {
    const keys = await this.loadApiKeys();
    if (this.gemini) this.gemini.updateKeys(keys);
    console.log('[BotManager] API keys updated:', keys.length);
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
      const liveChannelId = await db.getSetting('channel_id');
      if (!liveChannelId || message.channel.id !== liveChannelId) return;

      if (!message.author.bot) {
        const firstBotId = [...this.bots.keys()][0];
        if (botData.id !== firstBotId) return;

        this.lastMemberMessage = Date.now();

        this.repliedMessages.add(message.id);
        if (this.repliedMessages.size > 500) {
          const first = this.repliedMessages.values().next().value;
          this.repliedMessages.delete(first);
        }

        const msgData = {
          sender: message.author.username,
          text: message.content,
          botId: null,
          id: message.id,
          timestamp: Date.now()
        };
        this.recentMessages.push(msgData);
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

        this.latestMemberMsg = { message, liveChannelId };
        this.processMemberQueue();
        return;
      }

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

  async processMemberQueue() {
    if (this.processingMember) return;
    this.processingMember = true;

    try {
      while (this.latestMemberMsg) {
        const { message, liveChannelId } = this.latestMemberMsg;
        this.latestMemberMsg = null;
        await this.handleMemberMessage(message, liveChannelId);
      }
    } finally {
      this.processingMember = false;
    }
  }

  async handleMemberMessage(message, channelId) {
    if (!this.gemini) return;

    try {
      await this.msgQueue.pauseCurrentTyping();
      this.msgQueue.clearQueue(task => task.type === 'bot');
      this.msgQueue.lastSenderId = 'member';
      this.msgQueue.lastSendTime = 0;

      const reactionChance = parseInt(await db.getSetting('reaction_chance') || '20');
      this.scheduleReaction(message, channelId, reactionChance).catch(() => {});

      const botEntries = [...this.bots.entries()];
      if (botEntries.length === 0) return;

      const topic = await db.getSetting('topic') || 'general conversation';
      const customPrompt = await db.getSetting('custom_prompt') || '';
      const maxLen = parseInt(await db.getSetting('max_length') || '200');
      const minLen = parseInt(await db.getSetting('min_length') || '10');

      const lastSender = this.msgQueue.lastSenderId;
      let eligibleBots = botEntries;
      if (lastSender && lastSender !== 'member') {
        const filtered = botEntries.filter(([id]) => String(id) !== String(lastSender));
        if (filtered.length > 0) eligibleBots = filtered;
      }
      const firstBotIdx = Math.floor(Math.random() * eligibleBots.length);
      const firstBotData = eligibleBots[firstBotIdx][1].data;

      const replyDelayMin = Math.max(200, parseInt(await db.getSetting('reply_delay_min') || '200'));
      const replyDelayMax = Math.max(replyDelayMin + 100, parseInt(await db.getSetting('reply_delay_max') || '500'));
      await this.delay(this.randomDelay(replyDelayMin, replyDelayMax));

      if (!this.bots.has(firstBotData.id)) return;

      const firstReply = await this.gemini.generateReplyToMessage(
        firstBotData.name, firstBotData.personality, topic, customPrompt,
        message.author.username, message.content,
        this.recentMessages.slice(-10), maxLen, minLen
      );

      if (firstReply && firstReply.length > 0 && !this.isDuplicateMessage(firstReply)) {
        this.msgQueue.holdQueue = true;
        this.msgQueue.enqueue({
          type: 'bot',
          senderId: firstBotData.id,
          senderName: firstBotData.name,
          token: firstBotData.token,
          content: firstReply,
          replyToId: message.id,
          isMemberReply: true
        });

        await this.delay(this.randomDelay(300, 600));

        if (botEntries.length > 1) {
          const availableFollowUps = botEntries.filter(([id]) => id !== firstBotData.id);
          if (availableFollowUps.length > 0) {
            const followUpData = availableFollowUps[Math.floor(Math.random() * availableFollowUps.length)][1].data;

            const followUpDelayMin = Math.max(300, parseInt(await db.getSetting('follow_up_delay_min') || '300'));
            const followUpDelayMax = Math.max(followUpDelayMin + 100, parseInt(await db.getSetting('follow_up_delay_max') || '800'));
            await this.delay(this.randomDelay(followUpDelayMin, followUpDelayMax));

            if (this.bots.has(followUpData.id)) {
              const followReply = await this.gemini.generateFollowUp(
                followUpData.name, followUpData.personality, topic, customPrompt,
                message.author.username, message.content,
                this.recentMessages.slice(-10), maxLen, minLen
              );

              if (followReply && followReply.length > 0 && !this.isDuplicateMessage(followReply)) {
                this.msgQueue.enqueue({
                  type: 'bot',
                  senderId: followUpData.id,
                  senderName: followUpData.name,
                  token: followUpData.token,
                  content: followReply,
                  replyToId: message.id,
                  isMemberReply: true
                });
              }
            }
          }
        }

        await this.delay(300);
        this.msgQueue.lastSendTime = 0;
        this.msgQueue.holdQueue = false;
      } else {
        this.msgQueue.holdQueue = false;
      }
    } catch (err) {
      console.error(`[BotManager] Message handling error: ${err.message}`);
      this.msgQueue.holdQueue = false;
      this.msgQueue.lastSendTime = 0;
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

      const minCooldown = Math.max(2000, parseInt(await db.getSetting('min_delay') || '3000'));
      const maxCooldown = Math.max(minCooldown + 1000, parseInt(await db.getSetting('max_delay') || '5000'));
      const now = Date.now();
      const botCooldown = this.cooldowns.get(botId) || 0;

      if (now < botCooldown) {
        setTimeout(runChat, botCooldown - now + 500);
        return;
      }

      const timeSinceMemberMsg = now - this.lastMemberMessage;
      if (this.lastMemberMessage > 0 && timeSinceMemberMsg < 5000) {
        setTimeout(runChat, 5000 - timeSinceMemberMsg + 500);
        return;
      }

      if (this.msgQueue.holdQueue) {
        setTimeout(runChat, 1000);
        return;
      }

      if (this.processingMember) {
        setTimeout(runChat, 1000);
        return;
      }

      const lastSender = this.msgQueue.lastSenderId;
      if (lastSender && String(lastSender) === String(botId)) {
        setTimeout(runChat, this.randomDelay(1000, 2000));
        return;
      }

      try {
        const topic = await db.getSetting('topic') || 'general conversation';
        const maxLen = parseInt(await db.getSetting('max_length') || '200');
        const minLen = parseInt(await db.getSetting('min_length') || '10');
        const customPrompt = await db.getSetting('custom_prompt') || '';

        const reply = await this.gemini.generateReply(
          botData.name, botData.personality, topic,
          this.recentMessages.slice(-10), maxLen, minLen, customPrompt
        );

        if (!reply || reply.length === 0 || this.isDuplicateMessage(reply)) {
          if (this.bots.has(botId)) {
            setTimeout(runChat, this.randomDelay(minCooldown, maxCooldown));
          }
          return;
        }

        if (!this.msgQueue.holdQueue && !this.processingMember) {
          this.msgQueue.enqueue({
            type: 'bot',
            senderId: botData.id,
            senderName: botData.name,
            token: botData.token,
            content: reply
          });
          const cooldownTime = Date.now() + this.randomDelay(minCooldown, maxCooldown);
          this.cooldowns.set(botId, cooldownTime);
        }
      } catch (err) {
        console.error(`[BotManager] Chat error for ${botData.name}:`, err.message);
      }

      if (this.bots.has(botId)) {
        const nextDelay = this.randomDelay(minCooldown, maxCooldown);
        setTimeout(runChat, nextDelay);
      }
    };

    const initialDelay = this.randomDelay(1000, 3000);
    console.log(`[BotManager] scheduleActivity started for ${botId}, initial delay ${initialDelay}ms`);
    setTimeout(runChat, initialDelay);
  }

  async scheduleReaction(message, channelId, reactionChance) {
    if (Math.random() * 100 > reactionChance) return;
    if (message.author.bot) return;
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
    this.msgQueue.clearQueue();
    this.msgQueue.holdQueue = false;
    this.processingMember = false;
    this.latestMemberMsg = null;
    const ids = [...this.bots.keys()];
    for (const id of ids) {
      await this.stopBot(id);
    }
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
    const liveChannelId = await db.getSetting('channel_id');
    await rawFetch(entry.data.token, 'POST', `/channels/${liveChannelId}/messages`, { content: message });
  }
}

module.exports = new BotManager();
