require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const botManager = require('./bot-manager');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/settings', async (req, res) => {
  const settings = await db.getAllSettings();
  res.json(settings);
});

app.put('/api/settings', async (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    await db.setSetting(key, value);
  }
  if (settings.ai_api_key) await botManager.updateGeminiKey();
  res.json({ success: true });
});

app.get('/api/bots', async (req, res) => {
  const bots = await db.getBots();
  const active = botManager.getActiveBots();
  const activeIds = active.map(b => b.id);
  res.json(bots.map(b => ({
    ...b,
    token: '••••••' + b.token.slice(-4),
    is_running: activeIds.includes(b.id),
    tag: active.find(a => a.id === b.id)?.tag
  })));
});

app.post('/api/bots', async (req, res) => {
  const { name, token, channel_id, server_id, personality } = req.body;
  if (!name || !token || !channel_id || !server_id) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const result = await db.addBot(name, token, channel_id, server_id, personality);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/bots/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await botManager.stopBot(id);
  await db.removeBot(id);
  res.json({ success: true });
});

app.post('/api/bots/:id/start', async (req, res) => {
  const id = parseInt(req.params.id);
  const bot = await db.getBot(id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  try {
    await botManager.startBot(bot);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id);
  await botManager.stopBot(id);
  res.json({ success: true });
});

app.post('/api/bots/start-all', async (req, res) => {
  await botManager.startAll();
  res.json({ success: true });
});

app.post('/api/bots/stop-all', async (req, res) => {
  await botManager.stopAll();
  res.json({ success: true });
});

app.post('/api/bots/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  const { message } = req.body;
  try {
    await botManager.sendManualMessage(id, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  try {
    await botManager.init();
  } catch (err) {
    console.error('[Server] BotManager init failed (continuing anyway):', err.message);
  }

  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await botManager.stopAll();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await botManager.stopAll();
    process.exit(0);
  });

  app.listen(PORT, () => {
    console.log(`[Server] Dashboard: http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
