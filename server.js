const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory OAuth state store (state -> { userId, expiresAt })
const oauthStates = new Map();
function cleanOauthStates() {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (val.expiresAt < now) oauthStates.delete(key);
  }
}
const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

// Ensure data dir and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
['users.json', 'clips.json'].forEach(f => {
  const fp = path.join(DATA_DIR, f);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, '[]');
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// API key middleware for n8n/external integrations
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
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

// Helper: popup HTML that fires postMessage and closes itself
function closePopupHTML(data) {
  return `<!DOCTYPE html><html><body><script>
    try { window.opener.postMessage(${JSON.stringify({ type: 'tiktok_oauth', ...data })}, '*'); } catch(e) {}
    window.close();
  <\/script><p>Fechando...</p></body></html>`;
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
  const { name, email, tiktok, instagram, youtube, role, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha obrigatorios' });

  const users = readJSON('users.json');
  if (users.find(u => u.email === email)) {
    return res.status(409).json({ error: 'Email ja cadastrado' });
  }

  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
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

  const { passwordHash: _, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

// Admin credentials
const ADMIN_EMAILS = ['guilhermebonaparte15@gmail.com', 'mauriciopamplona2609@hotmail.com']; // stored lowercase
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update('Donos@Clipcash2026').digest('hex');

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });

  const inputHash = crypto.createHash('sha256').update(password).digest('hex');

  // Admin login
  if (ADMIN_EMAILS.includes(email.toLowerCase()) && inputHash === ADMIN_PASSWORD_HASH) {
    return res.json({ ok: true, user: {
      id: 'admin-' + email,
      name: 'Admin',
      email,
      role: 'admin',
      isAdmin: true,
      balance: 0,
      pending: 0,
      totalEarned: 0,
    }});
  }

  const users = readJSON('users.json');
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

  if (user.passwordHash && user.passwordHash !== inputHash) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }

  const { passwordHash, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

// Get user
app.get('/api/users/:id', (req, res) => {
  const users = readJSON('users.json');
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  res.json(user);
});

// ===== TIKTOK OAUTH =====

// Initiate TikTok OAuth — redirects popup to TikTok auth page
app.get('/auth/tiktok', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId obrigatorio');

  const users = readJSON('users.json');
  if (!users.find(u => u.id === userId)) {
    return res.status(404).send('Usuario nao encontrado');
  }

  cleanOauthStates();
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    scope: 'user.info.basic',
    response_type: 'code',
    redirect_uri: 'https://clipcash.club/auth/tiktok/callback',
    state,
  });

  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

// TikTok OAuth callback — exchanges code for token, saves verified TikTok data
app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state) {
    return res.send(closePopupHTML({ ok: false, error: error || 'Autorizacao negada' }));
  }

  const stateData = oauthStates.get(state);
  if (!stateData || stateData.expiresAt < Date.now()) {
    return res.send(closePopupHTML({ ok: false, error: 'Estado invalido ou expirado' }));
  }
  oauthStates.delete(state);

  const { userId } = stateData;

  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY || '',
        client_secret: process.env.TIKTOK_CLIENT_SECRET || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://clipcash.club/auth/tiktok/callback',
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.send(closePopupHTML({ ok: false, error: 'Falha ao obter token do TikTok' }));
    }

    const userRes = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    const tiktokUser = userData?.data?.user;

    if (!tiktokUser?.open_id) {
      return res.send(closePopupHTML({ ok: false, error: 'Nao foi possivel obter dados do TikTok' }));
    }

    const users = readJSON('users.json');
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) {
      return res.send(closePopupHTML({ ok: false, error: 'Usuario nao encontrado' }));
    }

    users[idx].tiktokId = tiktokUser.open_id;
    users[idx].tiktokUsername = tiktokUser.username || tiktokUser.display_name;
    users[idx].tiktokVerified = true;
    users[idx].tiktok = '@' + (tiktokUser.username || tiktokUser.display_name);
    writeJSON('users.json', users);

    return res.send(closePopupHTML({
      ok: true,
      tiktokUsername: users[idx].tiktokUsername,
      tiktokId: users[idx].tiktokId,
      userId,
    }));

  } catch (e) {
    console.error('TikTok OAuth error:', e);
    return res.send(closePopupHTML({ ok: false, error: 'Erro interno do servidor' }));
  }
});

// ===== ACCOUNT VERIFICATION =====

// Map from clip platform key to user profile key
const PLATFORM_KEY = { tiktok: 'tiktok', reels: 'instagram', shorts: 'youtube' };
const PLATFORM_LABEL = { tiktok: 'TikTok', reels: 'Instagram Reels', shorts: 'YouTube Shorts' };

// Submit screenshot to verify account ownership
app.post('/api/verify/screenshot', (req, res) => {
  const { userId, platform, handle, profileLink, screenshot } = req.body;

  if (!userId || !platform || !handle || !profileLink || !screenshot) {
    return res.status(400).json({ error: 'Campos obrigatorios: userId, platform, handle, profileLink, screenshot' });
  }
  if (!['tiktok', 'instagram', 'youtube'].includes(platform)) {
    return res.status(400).json({ error: 'Plataforma invalida' });
  }

  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return res.status(404).json({ error: 'Usuario nao encontrado' });

  const cleanHandle = handle.replace(/^@/, '').trim().toLowerCase();
  if (!cleanHandle) return res.status(400).json({ error: 'Handle invalido' });

  // Save screenshot file
  const filename = `${userId}-${platform}.jpg`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
  try {
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'Erro ao salvar screenshot' });
  }

  // Update user — pending approval
  users[idx][platform + 'Handle'] = cleanHandle;
  users[idx][platform + 'ProfileLink'] = profileLink;
  users[idx][platform + 'Verified'] = false;
  users[idx][platform + 'VerificationStatus'] = 'pending';
  users[idx][platform + 'SubmittedAt'] = new Date().toISOString();
  users[idx][platform + 'Screenshot'] = filename;

  writeJSON('users.json', users);
  res.json({ ok: true, status: 'pending', user: users[idx] });
});

// Serve screenshots (admin only)
app.get('/api/screenshots/:filename', requireApiKey, (req, res) => {
  const fp = path.join(SCREENSHOTS_DIR, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Nao encontrado' });
  res.sendFile(fp);
});

// List pending verifications (admin)
app.get('/api/admin/verifications', requireApiKey, (req, res) => {
  const users = readJSON('users.json');
  const pending = [];
  users.forEach(u => {
    ['tiktok', 'instagram', 'youtube'].forEach(platform => {
      if (u[platform + 'VerificationStatus'] === 'pending') {
        pending.push({
          userId: u.id,
          userName: u.name,
          userEmail: u.email,
          platform,
          handle: u[platform + 'Handle'],
          screenshot: u[platform + 'Screenshot'],
          profileLink: u[platform + 'ProfileLink'] || '',
          submittedAt: u[platform + 'SubmittedAt'],
        });
      }
    });
  });
  res.json(pending);
});

// Approve or reject a verification (admin)
app.post('/api/admin/verifications/:userId/:platform/:action', requireApiKey, (req, res) => {
  const { userId, platform, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acao invalida' });
  if (!['tiktok', 'instagram', 'youtube'].includes(platform)) return res.status(400).json({ error: 'Plataforma invalida' });

  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return res.status(404).json({ error: 'Usuario nao encontrado' });

  if (action === 'approve') {
    users[idx][platform + 'Verified'] = true;
    users[idx][platform + 'VerificationStatus'] = 'approved';
    users[idx][platform + 'VerifiedAt'] = new Date().toISOString();
    // Keep legacy fields in sync
    const handle = users[idx][platform + 'Handle'];
    if (platform === 'tiktok') { users[idx].tiktok = '@' + handle; users[idx].tiktokUsername = handle; }
    if (platform === 'instagram') users[idx].instagram = '@' + handle;
    if (platform === 'youtube') users[idx].youtube = '@' + handle;
  } else {
    users[idx][platform + 'Verified'] = false;
    users[idx][platform + 'VerificationStatus'] = 'rejected';
    users[idx][platform + 'Handle'] = null;
  }

  writeJSON('users.json', users);
  res.json({ ok: true });
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

  // Validate that the user has a verified account for this platform
  // and that the submitted handle matches
  const profileKey = PLATFORM_KEY[platform]; // 'tiktok' | 'instagram' | 'youtube'
  if (profileKey) {
    const users = readJSON('users.json');
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

    const verifiedHandle = user[profileKey + 'Handle'];
    const verificationStatus = user[profileKey + 'VerificationStatus'];

    if (verificationStatus === 'pending') {
      return res.status(403).json({
        error: `Sua conta de ${PLATFORM_LABEL[platform]} esta aguardando aprovacao. Aguarde a revisao.`,
      });
    }
    if (verificationStatus !== 'approved' || !verifiedHandle) {
      return res.status(403).json({
        error: `Voce precisa verificar sua conta de ${PLATFORM_LABEL[platform]} antes de enviar clipes`,
        needsVerification: true,
        platform: profileKey,
      });
    }

    const submittedHandle = (handle || '').replace(/^@/, '').trim().toLowerCase();
    if (submittedHandle !== verifiedHandle.toLowerCase()) {
      return res.status(403).json({
        error: `O @ enviado nao corresponde a sua conta verificada (@${verifiedHandle})`,
      });
    }

    // For TikTok, also validate the URL contains the verified handle
    if (platform === 'tiktok' && !videoUrl.toLowerCase().includes('@' + verifiedHandle.toLowerCase())) {
      return res.status(400).json({
        error: `O link do TikTok deve conter seu @${verifiedHandle}`,
      });
    }
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
