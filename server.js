const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data dir and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
['users.json', 'clips.json'].forEach(f => {
  const fp = path.join(DATA_DIR, f);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, '[]');
});

app.use(express.json());
app.use(express.static('public'));

// API key middleware for n8n/external integrations
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!process.env.CLIPCASH_API_KEY) return next(); // skip if not configured
  if (key !== process.env.CLIPCASH_API_KEY) {
    return res.status(401).json({ error: 'API key invalida' });
  }
  next();
}

// Webhook URL for n8n (registration → Google Sheets)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// Fire-and-forget POST to n8n webhook
function notifyN8n(data) {
  if (!N8N_WEBHOOK_URL) return;
  fetch(N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {}); // silently ignore errors
}

// Helper: read/write JSON
function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ===== AUTH / USERS =====

// Register
app.post('/api/register', (req, res) => {
  const { name, email, tiktok, instagram, youtube, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });

  const users = readJSON('users.json');
  if (users.find(u => u.email === email)) {
    return res.status(409).json({ error: 'Email ja cadastrado' });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    tiktok: tiktok || '',
    instagram: instagram || '',
    youtube: youtube || '',
    role: role || 'clipper',
    createdAt: new Date().toISOString(),
    balance: 0,
    pending: 0,
    totalEarned: 0,
  };

  users.push(user);
  writeJSON('users.json', users);

  // Send to n8n → Google Sheets (async, non-blocking)
  notifyN8n({ ...user, userId: user.id });

  res.json({ ok: true, user });
});

// Login (simple email-based)
app.post('/api/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatorio' });

  const users = readJSON('users.json');
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

  res.json({ ok: true, user });
});

// Get user
app.get('/api/users/:id', (req, res) => {
  const users = readJSON('users.json');
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  res.json(user);
});

// ===== CLIPS =====

// Submit clip
app.post('/api/clips', (req, res) => {
  const { userId, campaignId, songName, platform, videoUrl, handle } = req.body;
  if (!userId || !videoUrl || !platform || !songName) {
    return res.status(400).json({ error: 'Campos obrigatorios: userId, videoUrl, platform, songName' });
  }

  // Validate URL format
  const validPlatforms = {
    tiktok: /tiktok\.com/i,
    reels: /instagram\.com\/reel/i,
    shorts: /youtube\.com\/shorts|youtu\.be/i,
  };

  if (validPlatforms[platform] && !validPlatforms[platform].test(videoUrl)) {
    return res.status(400).json({ error: `URL invalida para ${platform}` });
  }

  const clips = readJSON('clips.json');
  const clip = {
    id: crypto.randomUUID(),
    userId,
    campaignId: campaignId || 'kenny-comp-1',
    songName,
    platform,
    videoUrl,
    handle: handle || '',
    views: 0,
    status: 'pending', // pending, approved, rejected
    submittedAt: new Date().toISOString(),
  };

  clips.push(clip);
  writeJSON('clips.json', clips);
  res.json({ ok: true, clip });
});

// Get clips by user
app.get('/api/clips/user/:userId', (req, res) => {
  const clips = readJSON('clips.json');
  const userClips = clips.filter(c => c.userId === req.params.userId);
  res.json(userClips);
});

// Get all clips for a campaign
app.get('/api/clips/campaign/:campaignId', (req, res) => {
  const clips = readJSON('clips.json');
  const campaignClips = clips.filter(c => c.campaignId === req.params.campaignId);
  res.json(campaignClips);
});

// Update clip views (admin)
app.patch('/api/clips/:id', (req, res) => {
  const clips = readJSON('clips.json');
  const idx = clips.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Clip nao encontrado' });

  const { views, status } = req.body;
  if (views !== undefined) {
    clips[idx].views = views;
    clips[idx].lastViewsUpdate = new Date().toISOString();
  }
  if (status) clips[idx].status = status;

  writeJSON('clips.json', clips);
  res.json({ ok: true, clip: clips[idx] });
});

// ===== N8N INTEGRATION =====

// Get all approved clips (for n8n workflow)
app.get('/api/clips/approved', requireApiKey, (req, res) => {
  const clips = readJSON('clips.json');
  const approved = clips.filter(c => c.status === 'approved');
  res.json(approved);
});

// Bulk update views (for n8n workflow)
app.patch('/api/clips/bulk-views', requireApiKey, (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'Body deve conter { updates: [{ id, views }] }' });
  }

  const clips = readJSON('clips.json');
  const now = new Date().toISOString();
  let updated = 0;

  updates.forEach(({ id, views }) => {
    const idx = clips.findIndex(c => c.id === id);
    if (idx !== -1 && typeof views === 'number') {
      clips[idx].views = views;
      clips[idx].lastViewsUpdate = now;
      updated++;
    }
  });

  writeJSON('clips.json', clips);
  res.json({ ok: true, updated, total: updates.length });
});

// ===== ADMIN =====

// Get all clips with user names for admin panel
app.get('/api/admin/clips/:campaignId', (req, res) => {
  const clips = readJSON('clips.json');
  const users = readJSON('users.json');
  const campaignClips = clips.filter(c => c.campaignId === req.params.campaignId);
  const enriched = campaignClips.map(c => {
    const user = users.find(u => u.id === c.userId);
    return { ...c, userName: user ? user.name : 'Desconhecido', userEmail: user ? user.email : '' };
  });
  enriched.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json(enriched);
});

// ===== RANKING =====

app.get('/api/ranking/:campaignId', (req, res) => {
  const clips = readJSON('clips.json');
  const users = readJSON('users.json');
  const campaignClips = clips.filter(c => c.campaignId === req.params.campaignId && c.status !== 'rejected');

  // Aggregate by user
  const userStats = {};
  campaignClips.forEach(clip => {
    if (!userStats[clip.userId]) {
      const user = users.find(u => u.id === clip.userId);
      userStats[clip.userId] = {
        userId: clip.userId,
        name: user ? user.name : 'Desconhecido',
        totalViews: 0,
        clipCount: 0,
        bestClipViews: 0,
        bestClipUrl: '',
      };
    }
    userStats[clip.userId].totalViews += clip.views;
    userStats[clip.userId].clipCount += 1;
    if (clip.views > userStats[clip.userId].bestClipViews) {
      userStats[clip.userId].bestClipViews = clip.views;
      userStats[clip.userId].bestClipUrl = clip.videoUrl;
    }
  });

  const ranking = Object.values(userStats).sort((a, b) => b.totalViews - a.totalViews);
  res.json(ranking);
});

// ===== STATS =====

app.get('/api/stats/:campaignId', (req, res) => {
  const clips = readJSON('clips.json');
  const users = readJSON('users.json');
  const campaignClips = clips.filter(c => c.campaignId === req.params.campaignId);

  const totalClips = campaignClips.length;
  const totalViews = campaignClips.reduce((sum, c) => sum + c.views, 0);
  const uniqueParticipants = new Set(campaignClips.map(c => c.userId)).size;
  const byPlatform = {
    tiktok: campaignClips.filter(c => c.platform === 'tiktok').length,
    reels: campaignClips.filter(c => c.platform === 'reels').length,
    shorts: campaignClips.filter(c => c.platform === 'shorts').length,
  };

  res.json({ totalClips, totalViews, uniqueParticipants, byPlatform });
});

// Start
app.listen(PORT, () => {
  console.log(`ClipCash rodando em http://localhost:${PORT}`);
});
