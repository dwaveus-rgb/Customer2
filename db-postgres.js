const { Pool } = require('pg');

let dbUrl = process.env.DATABASE_URL || '';
try {
  const url = new URL(dbUrl);
  dbUrl = url.toString();
} catch (e) {}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

let initPromise = null;

async function ensureTables() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let attempts = 0;
    while (attempts < 5) {
      try {
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
              channel_id VARCHAR(255) NOT NULL DEFAULT '',
              server_id VARCHAR(255) NOT NULL DEFAULT '',
              personality VARCHAR(255) DEFAULT 'friendly',
              is_active INTEGER DEFAULT 0,
              created_at TIMESTAMP DEFAULT NOW()
            );
          `);

          const defaults = {
            topic: 'what is the best discord server and why',
            ai_api_key: process.env.AI_API_KEY || '',
            min_delay: '3000',
            max_delay: '5000',
            typing_min: '1500',
            typing_max: '2500',
            max_length: '200',
            topic_change_interval: '30',
            auto_reply: '1',
            chat_in_all_channels: '0',
            theme: 'dark',
            custom_prompt: 'talk like gen z. use abbreviations like ngl, fr, no cap, lowkey, highkey, ion, deadass, bet, slay, bussin. lowercase everything. short 1-2 sentence messages. never use emojis. have opinions and be a little unhinged. react to what others say with energy. say things like "thats crazy", "no bc ur right", "ion think abt it like that", "ok but have u considered", "bestie ur so real for that".',
            reaction_chance: '20',
            reply_chance: '80',
            reply_delay_min: '200',
            reply_delay_max: '4000',
            follow_up_delay_min: '2000',
            follow_up_delay_max: '6000',
            off_topic_tolerance: '5',
            redirect_cooldown: '120',
            idle_kick_minutes: '30',
            typing_pause_ms: '500'
          };

          for (const [key, value] of Object.entries(defaults)) {
            await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
          }
          console.log('[DB] PostgreSQL tables ready');
        } finally {
          client.release();
        }
        return;
      } catch (err) {
        attempts++;
        console.error(`[DB] Init attempt ${attempts} failed: ${err.message}`);
        if (attempts < 5) {
          await new Promise(r => setTimeout(r, 3000));
          initPromise = null;
        } else {
          console.error('[DB] All init attempts failed, will retry on next query');
          initPromise = null;
        }
      }
    }
  })();
  return initPromise;
}

module.exports = {
  pool,
  ensureTables,
  getSetting: async (key) => {
    try {
      await ensureTables();
      const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return res.rows[0]?.value ?? null;
    } catch (err) {
      console.error('[DB] getSetting error:', err.message);
      return null;
    }
  },
  setSetting: async (key, value) => {
    try {
      await ensureTables();
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
    } catch (err) {
      console.error('[DB] setSetting error:', err.message);
    }
  },
  getAllSettings: async () => {
    try {
      await ensureTables();
      const res = await pool.query('SELECT key, value FROM settings');
      const s = {};
      for (const r of res.rows) s[r.key] = r.value;
      return s;
    } catch (err) {
      console.error('[DB] getAllSettings error:', err.message);
      return {};
    }
  },
  addBot: async (name, token, channelId, serverId, personality) => {
    try {
      await ensureTables();
      const res = await pool.query('INSERT INTO bots (name, token, channel_id, server_id, personality) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, token, channelId, serverId, personality || 'friendly']);
      return { lastInsertRowid: res.rows[0].id };
    } catch (err) {
      console.error('[DB] addBot error:', err.message);
      throw err;
    }
  },
  removeBot: async (id) => {
    try {
      await ensureTables();
      await pool.query('DELETE FROM bots WHERE id = $1', [id]);
    } catch (err) {
      console.error('[DB] removeBot error:', err.message);
    }
  },
  getBots: async () => {
    try {
      await ensureTables();
      const res = await pool.query('SELECT * FROM bots ORDER BY id');
      return res.rows;
    } catch (err) {
      console.error('[DB] getBots error:', err.message);
      return [];
    }
  },
  getBot: async (id) => {
    try {
      await ensureTables();
      const res = await pool.query('SELECT * FROM bots WHERE id = $1', [id]);
      return res.rows[0] || null;
    } catch (err) {
      console.error('[DB] getBot error:', err.message);
      return null;
    }
  },
  updateBot: async (id, fields) => {
    try {
      await ensureTables();
      const keys = Object.keys(fields);
      const values = Object.values(fields);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      await pool.query(`UPDATE bots SET ${set} WHERE id = $${keys.length + 1}`, [...values, id]);
    } catch (err) {
      console.error('[DB] updateBot error:', err.message);
    }
  }
};
