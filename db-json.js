const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const dbPath = path.join(dataDir, 'config.json');

function load() {
  if (fs.existsSync(dbPath)) {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }
  return { bots: [], settings: {} };
}

function save(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

let data = load();

const defaults = {
  topic: 'what is the best discord server and why',
  ai_api_key: process.env.AI_API_KEY || '',
  min_delay: '8000',
  max_delay: '25000',
  typing_min: '3000',
  typing_max: '8000',
  max_length: '200',
  topic_change_interval: '30',
  admin_password: process.env.ADMIN_PASSWORD || 'admin',
  auto_reply: '1',
  chat_in_all_channels: '0',
  theme: 'dark'
};

for (const [key, value] of Object.entries(defaults)) {
  if (!data.settings[key]) data.settings[key] = value;
}
save(data);

let nextBotId = data.bots.length > 0 ? Math.max(...data.bots.map(b => b.id)) + 1 : 1;

module.exports = {
  getSetting: async (key) => data.settings[key],
  setSetting: async (key, value) => { data.settings[key] = value; save(data); },
  getAllSettings: async () => ({ ...data.settings }),
  addBot: async (name, token, channelId, serverId, personality) => {
    const existing = data.bots.find(b => b.token === token);
    if (existing) throw new Error('Token already exists');
    const bot = { id: nextBotId++, name, token, channel_id: channelId, server_id: serverId, personality: personality || 'friendly', is_active: 0, created_at: new Date().toISOString() };
    data.bots.push(bot);
    save(data);
    return { lastInsertRowid: bot.id };
  },
  removeBot: async (id) => { data.bots = data.bots.filter(b => b.id !== id); save(data); },
  getBots: async () => [...data.bots],
  getBot: async (id) => data.bots.find(b => b.id === id) || null,
  updateBot: async (id, fields) => { const bot = data.bots.find(b => b.id === id); if (bot) { Object.assign(bot, fields); save(data); } }
};
