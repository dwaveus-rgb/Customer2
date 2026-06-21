const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token TEXT NOT NULL UNIQUE,
        channel_id VARCHAR(255) NOT NULL,
        server_id VARCHAR(255) NOT NULL,
        personality VARCHAR(255) DEFAULT 'friendly',
        is_active INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id SERIAL PRIMARY KEY,
        bot_id INTEGER,
        bot_name VARCHAR(255),
        message TEXT,
        channel_id VARCHAR(255),
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(255),
        bot_id INTEGER,
        data JSONB,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);

    const defaults = {
      topic: 'what is the best discord server and why',
      ai_api_key: process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || '',
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
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, value]
      );
    }

    console.log('[DB] PostgreSQL initialized');
  } finally {
    client.release();
  }
}

initDB().catch(err => {
  console.error('[DB] Init error:', err.message);
  console.error('[DB] Make sure DATABASE_URL is set in your environment');
});

module.exports = {
  pool,

  getSetting: async (key) => {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows[0]?.value || null;
  },

  setSetting: async (key, value) => {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
  },

  getAllSettings: async () => {
    const res = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    for (const row of res.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  },

  addBot: async (name, token, channelId, serverId, personality) => {
    const res = await pool.query(
      'INSERT INTO bots (name, token, channel_id, server_id, personality) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, token, channelId, serverId, personality || 'friendly']
    );
    return { lastInsertRowid: res.rows[0].id };
  },

  removeBot: async (id) => {
    await pool.query('DELETE FROM bots WHERE id = $1', [id]);
  },

  getBots: async () => {
    const res = await pool.query('SELECT * FROM bots ORDER BY id');
    return res.rows;
  },

  getBot: async (id) => {
    const res = await pool.query('SELECT * FROM bots WHERE id = $1', [id]);
    return res.rows[0] || null;
  },

  updateBot: async (id, fields) => {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await pool.query(`UPDATE bots SET ${setClause} WHERE id = $${keys.length + 1}`, [...values, id]);
  },

  logChat: async (botId, botName, message, channelId) => {
    await pool.query(
      'INSERT INTO chat_logs (bot_id, bot_name, message, channel_id) VALUES ($1, $2, $3, $4)',
      [botId, botName, message, channelId]
    );
    await pool.query(
      'DELETE FROM chat_logs WHERE id NOT IN (SELECT id FROM chat_logs ORDER BY timestamp DESC LIMIT 500)'
    );
  },

  getChatLogs: async (limit = 100) => {
    const res = await pool.query('SELECT * FROM chat_logs ORDER BY timestamp DESC LIMIT $1', [limit]);
    return res.rows;
  },

  logEvent: async (type, botId, eventData) => {
    await pool.query(
      'INSERT INTO analytics (event_type, bot_id, data) VALUES ($1, $2, $3)',
      [type, botId, JSON.stringify(eventData)]
    );
  },

  getAnalytics: async () => {
    const totalRes = await pool.query('SELECT COUNT(*) as count FROM chat_logs');
    const totalMessages = parseInt(totalRes.rows[0].count);

    const activeRes = await pool.query('SELECT COUNT(*) as count FROM bots WHERE is_active = 1');
    const activeBots = parseInt(activeRes.rows[0].count);

    const totalRes2 = await pool.query('SELECT COUNT(*) as count FROM bots');
    const totalBots = parseInt(totalRes2.rows[0].count);

    const recentRes = await pool.query('SELECT * FROM chat_logs ORDER BY timestamp DESC LIMIT 20');
    const recentLogs = recentRes.rows;

    const botCountsRes = await pool.query(
      'SELECT bot_name, COUNT(*) as count FROM chat_logs GROUP BY bot_name ORDER BY count DESC'
    );
    const messagesByBot = botCountsRes.rows;

    return { totalMessages, activeBots, totalBots, recentLogs, messagesByBot };
  }
};
