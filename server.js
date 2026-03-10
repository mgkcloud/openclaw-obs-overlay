#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server v5
 * 
 * Fallout terminal + iMessage bubbles + Tamagotchi pet with sentiment-driven emotions.
 * SSE with bulletproof reconnect. Green monochrome on transparent.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { exec: execCb } = require('child_process');

const PORT = parseInt(process.env.PORT || '3456');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const MAX_EVENTS = 200;
const DASHBOARD_INTERVAL = 60000;

const bus = new EventEmitter();
bus.setMaxListeners(50);
const recentEvents = [];

// --- Current pet emotion state (server-side) ---
let petEmotion = 'idle';
let petEmotionTs = Date.now();

// --- Simple keyword sentiment analyzer ---
function analyzeSentiment(text, role) {
  const lower = text.toLowerCase();
  
  // Positive patterns
  const happy = /(\bdone\b|✅|shipped|fixed|success|profit|\+\$|winning|crushed|nailed|perfect|excellent|great|awesome|hell yes|let'?s go|boom|🔥|💰|🚀)/;
  const excited = /(holy shit|incredible|breakthrough|massive|insane|record|best ever|new high|crushing it|moon|10x|100x)/;
  const proud = /(deployed|launched|built|created|completed|delivered|graduated|milestone|achievement)/;
  const thinking = /(analyzing|checking|looking|searching|reading|scanning|investigating|researching|hmm|let me)/;
  const working = /(running|processing|spawning|building|installing|compiling|fetching|writing|editing)/;
  
  // Negative patterns  
  const angry = /(fuck|shit|damn|wtf|broken|crashed|failed|wipeout|bleeding|lost \$|destroyed|-\$[5-9]\d|-\$\d{2,})/;
  const worried = /(warning|alert|critical|emergency|⚠️|🚨|low balance|halted|blocked|stale|timeout)/;
  const sad = /(sorry|apologize|my bad|mistake|regression|bug|error|wrong|unfortunately|issue)/;
  const confused = /(weird|strange|unexpected|doesn'?t make sense|no idea|confused|unclear|huh\??)/;
  const sleepy = /(heartbeat_ok|no changes|all good|nothing|quiet|idle)/;

  // Priority order (most specific first)
  if (excited.test(lower)) return 'ecstatic';
  if (angry.test(lower)) return role === 'user' ? 'scared' : 'sorry';
  if (worried.test(lower)) return 'worried';
  if (sad.test(lower)) return 'sorry';
  if (confused.test(lower)) return 'confused';
  if (proud.test(lower)) return 'proud';
  if (happy.test(lower)) return 'happy';
  if (working.test(lower)) return 'working';
  if (thinking.test(lower)) return 'thinking';
  if (sleepy.test(lower)) return 'sleepy';
  
  // Default based on role
  if (role === 'user') return 'attentive';
  return 'idle';
}

let dashboardData = null;
let dashboardLastUpdate = 0;

function refreshDashboard() {
  execCb('ssh hermes "cat /home/ubuntu/trading/fund_truth.json" 2>/dev/null', { timeout: 15000 }, (err, stdout) => {
    if (err || !stdout) return;
    try { dashboardData = JSON.parse(stdout); dashboardLastUpdate = Date.now(); bus.emit('dashboard', dashboardData); } catch {}
  });
}
refreshDashboard();
setInterval(refreshDashboard, DASHBOARD_INTERVAL);

function inferChannel(filePath) {
  const parts = filePath.split(path.sep);
  const agentIdx = parts.indexOf('agents');
  const agentName = agentIdx >= 0 ? parts[agentIdx + 1] : '?';
  const filename = path.basename(filePath, '.jsonl');
  const topicMatch = filename.match(/topic-(\d+)/);
  if (topicMatch) return `${agentName}/t${topicMatch[1]}`;
  return `${agentName}/${filename.slice(0, 6)}`;
}

function parseMessage(line, channel) {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'message') return null;
    const msg = entry.message;
    if (!msg) return null;
    const role = msg.role;
    const timestamp = entry.timestamp || new Date().toISOString();

    let text = '';
    let hasToolCall = false;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) text += block.text;
        else if (block.type === 'toolCall') { hasToolCall = true; text += `${block.name}(...)`; }
      }
    }
    if (!text) return null;
    text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const isPrimary = (role === 'user' || role === 'assistant') && !hasToolCall;
    if (!isPrimary && text.length > 120) text = text.slice(0, 117) + '...';

    // Analyze sentiment for primary messages
    let sentiment = null;
    if (isPrimary) {
      sentiment = analyzeSentiment(text, role);
      petEmotion = sentiment;
      petEmotionTs = Date.now();
    }

    const roleTag = { user: 'USER', assistant: 'GG', toolCall: 'TOOL', toolResult: 'RES', system: 'SYS' }[role] || 'MSG';
    const roleClass = { user: 'user', assistant: 'assistant', toolCall: 'tool', toolResult: 'tool-result', system: 'system' }[role] || 'other';

    return { id: entry.id || Math.random().toString(36).slice(2), channel, role: roleClass, roleTag, text, timestamp, ts: Date.now(), primary: isPrimary, sentiment };
  } catch { return null; }
}

const fileOffsets = new Map();
const watchers = new Map();

function tailFile(filePath) {
  const channel = inferChannel(filePath);
  try { fileOffsets.set(filePath, fs.statSync(filePath).size); } catch { fileOffsets.set(filePath, 0); }
  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType !== 'change') return;
    const offset = fileOffsets.get(filePath) || 0;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size <= offset) return;
    const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      fileOffsets.set(filePath, stat.size);
      for (const line of buffer.split('\n').filter(Boolean)) {
        const evt = parseMessage(line, channel);
        if (evt) { recentEvents.push(evt); if (recentEvents.length > MAX_EVENTS) recentEvents.shift(); bus.emit('event', evt); }
      }
    });
  });
  watchers.set(filePath, watcher);
}

function scanSessions() {
  try {
    for (const agent of fs.readdirSync(SESSIONS_DIR)) {
      const sessDir = path.join(SESSIONS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
        const filePath = path.join(sessDir, file);
        if (!watchers.has(filePath)) {
          try { if (Date.now() - fs.statSync(filePath).mtimeMs < 86400000) tailFile(filePath); } catch {}
        }
      }
    }
  } catch {}
}
scanSessions();
setInterval(scanSessions, 30000);

// Decay pet emotion back to idle after 30s of no messages
setInterval(() => {
  if (Date.now() - petEmotionTs > 30000 && petEmotion !== 'idle' && petEmotion !== 'sleepy') {
    petEmotion = 'idle';
    bus.emit('emotion', { emotion: 'idle' });
  }
  if (Date.now() - petEmotionTs > 120000 && petEmotion !== 'sleepy') {
    petEmotion = 'sleepy';
    bus.emit('emotion', { emotion: 'sleepy' });
  }
}, 5000);

// Monotonic sequence number for SSE dedup
let sseSeq = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Aggressive no-cache on everything
  const noCacheHeaders = {
    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*'
  };

  if (url.pathname === '/events') {
    res.writeHead(200, { ...noCacheHeaders, 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    
    // Send current state
    res.write(`event: emotion\ndata: ${JSON.stringify({ emotion: petEmotion })}\n\n`);
    if (dashboardData) res.write(`event: dashboard\ndata: ${JSON.stringify(dashboardData)}\n\n`);
    for (const evt of recentEvents.slice(-15)) {
      sseSeq++;
      res.write(`id: ${sseSeq}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
    
    const h1 = (evt) => { sseSeq++; try { res.write(`id: ${sseSeq}\ndata: ${JSON.stringify(evt)}\n\n`); } catch {} };
    const h2 = (d) => { try { res.write(`event: dashboard\ndata: ${JSON.stringify(d)}\n\n`); } catch {} };
    const h3 = (d) => { try { res.write(`event: emotion\ndata: ${JSON.stringify(d)}\n\n`); } catch {} };
    bus.on('event', h1); bus.on('dashboard', h2); bus.on('emotion', h3);
    
    // Keepalive every 10s (more frequent to detect dead connections faster)
    const ka = setInterval(() => {
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { clearInterval(ka); }
    }, 10000);
    
    req.on('close', () => { bus.off('event', h1); bus.off('dashboard', h2); bus.off('emotion', h3); clearInterval(ka); });
    return;
  }
  if (url.pathname === '/dashboard') {
    res.writeHead(200, { ...noCacheHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dashboardData || {})); return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { ...noCacheHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, watching: watchers.size, buffered: recentEvents.length, emotion: petEmotion })); return;
  }
  // Main page - always fresh
  res.writeHead(200, { ...noCacheHeaders, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(OVERLAY_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OBS Overlay v5 :: http://localhost:${PORT} :: ${watchers.size} sessions`);
});

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>OPENCLAW TERMINAL v5</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: transparent;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    color: #33ff33;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    font-size: 13px;
  }

  /* ===== TOP-LEFT: DASHBOARD ===== */
  #dashboard {
    position: fixed;
    top: 16px;
    left: 16px;
    width: 44%;
    max-height: 38%;
    overflow: hidden;
    line-height: 1.5;
    font-size: 12px;
  }
  .fund-pnl-big { font-family: 'VT323', monospace; font-size: 36px; line-height: 1.1; }
  .dim { color: #1a8c1a; }
  .bright { color: #55ff55; }
  .warn { color: #ff5555; }
  .ok { color: #33ff33; }
  .separator { color: #1a6e1a; letter-spacing: 2px; }
  .bar { display: inline-block; letter-spacing: -1px; }
  .bot-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ===== TOP-RIGHT: STATUS ===== */
  #topRight {
    position: fixed; top: 16px; right: 16px;
    text-align: right; font-size: 11px; color: #1a8c1a;
  }
  #topRight .title { color: #33ff33; font-size: 14px; letter-spacing: 2px; }

  /* ===== BOTTOM-LEFT: TAMAGOTCHI PET ===== */
  #petContainer {
    position: fixed;
    bottom: 16px;
    left: 16px;
    width: 180px;
    height: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
  }

  #petMood {
    font-size: 9px;
    color: #1a8c1a;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 4px;
    transition: color 0.3s;
  }

  #petBody {
    position: relative;
    width: 80px;
    height: 80px;
  }

  /* The pet is drawn with pure CSS - a little ghost/blob creature */
  .pet-sprite {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 56px;
    filter: drop-shadow(0 0 8px rgba(51, 255, 51, 0.4));
    transition: transform 0.3s ease, filter 0.3s ease;
  }

  /* Emotion-driven animations */
  .pet-sprite.idle { animation: petBob 3s ease-in-out infinite; }
  .pet-sprite.happy { animation: petBounce 0.6s ease-in-out infinite; filter: drop-shadow(0 0 12px rgba(51, 255, 51, 0.7)); }
  .pet-sprite.ecstatic { animation: petSpin 0.8s ease-in-out infinite; filter: drop-shadow(0 0 20px rgba(51, 255, 51, 0.9)); }
  .pet-sprite.sad, .pet-sprite.sorry { animation: petDroop 2s ease-in-out infinite; filter: drop-shadow(0 0 6px rgba(51, 255, 51, 0.2)); }
  .pet-sprite.scared { animation: petShake 0.3s ease-in-out infinite; }
  .pet-sprite.worried { animation: petWobble 1.5s ease-in-out infinite; filter: drop-shadow(0 0 8px rgba(255, 85, 85, 0.4)); }
  .pet-sprite.thinking { animation: petTilt 2s ease-in-out infinite; }
  .pet-sprite.working { animation: petPulse 1s ease-in-out infinite; filter: drop-shadow(0 0 12px rgba(51, 255, 51, 0.6)); }
  .pet-sprite.proud { animation: petGrow 1.5s ease-in-out infinite; filter: drop-shadow(0 0 16px rgba(51, 255, 51, 0.8)); }
  .pet-sprite.attentive { animation: petPerk 1s ease-in-out infinite; }
  .pet-sprite.confused { animation: petConfused 1.2s ease-in-out infinite; }
  .pet-sprite.sleepy { animation: petSleep 4s ease-in-out infinite; opacity: 0.5; }

  /* Sleep Zs */
  .zzz {
    position: absolute;
    top: -10px;
    right: -5px;
    font-size: 14px;
    color: #1a8c1a;
    opacity: 0;
  }
  .pet-sprite.sleepy .zzz { animation: petZzz 3s ease-in-out infinite; }

  @keyframes petBob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
  }
  @keyframes petBounce {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(-14px) scale(1.05); }
  }
  @keyframes petSpin {
    0% { transform: rotate(0deg) scale(1.1); }
    25% { transform: rotate(5deg) translateY(-10px) scale(1.15); }
    50% { transform: rotate(0deg) translateY(-16px) scale(1.1); }
    75% { transform: rotate(-5deg) translateY(-10px) scale(1.15); }
    100% { transform: rotate(0deg) scale(1.1); }
  }
  @keyframes petDroop {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(4px) rotate(-5deg); }
  }
  @keyframes petShake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-6px); }
    75% { transform: translateX(6px); }
  }
  @keyframes petWobble {
    0%, 100% { transform: rotate(0deg); }
    25% { transform: rotate(-8deg); }
    75% { transform: rotate(8deg); }
  }
  @keyframes petTilt {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(15deg) translateY(-3px); }
  }
  @keyframes petPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }
  @keyframes petGrow {
    0%, 100% { transform: scale(1) translateY(0); }
    50% { transform: scale(1.15) translateY(-8px); }
  }
  @keyframes petPerk {
    0%, 100% { transform: translateY(0) scale(1); }
    30% { transform: translateY(-8px) scale(1.03); }
    60% { transform: translateY(-3px) scale(1); }
  }
  @keyframes petConfused {
    0%, 100% { transform: rotate(0deg); }
    20% { transform: rotate(10deg); }
    40% { transform: rotate(-10deg); }
    60% { transform: rotate(5deg); }
    80% { transform: rotate(-3deg); }
  }
  @keyframes petSleep {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(2px) scale(0.97); }
  }
  @keyframes petZzz {
    0% { opacity: 0; transform: translate(0, 0) scale(0.5); }
    30% { opacity: 1; }
    100% { opacity: 0; transform: translate(15px, -30px) scale(1.2); }
  }

  /* Pet emotion label styling */
  #petMood.happy, #petMood.ecstatic, #petMood.proud { color: #33ff33; }
  #petMood.worried, #petMood.scared { color: #ff5555; }
  #petMood.working { color: #55ff55; }

  #petStats {
    font-size: 8px;
    color: #1a6e1a;
    margin-top: 4px;
    text-align: center;
  }

  /* ===== BOTTOM-RIGHT: ACTIVITY LOG ===== */
  #feed {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 52%;
    max-height: 54%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
  }

  .entry {
    padding: 1px 0;
    animation: fadeIn 0.3s ease-out;
    opacity: 1;
    transition: opacity 3s ease-out;
    font-size: 11px;
    color: #1a8c1a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .entry .tag { color: #1a6e1a; }
  .entry .msg-text { color: #1a7a1a; }
  .entry.fading { opacity: 0; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .bubble-wrap {
    display: flex;
    margin: 4px 0;
    animation: bubbleIn 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    opacity: 1;
    transition: opacity 3s ease-out;
  }
  .bubble-wrap.fading { opacity: 0; }
  .bubble-wrap.from-user { justify-content: flex-end; }
  .bubble-wrap.from-assistant { justify-content: flex-start; }

  .bubble {
    position: relative;
    max-width: 80%;
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.4;
    word-wrap: break-word;
    white-space: normal;
    border-radius: 16px;
  }
  .bubble.user-bubble {
    background: #33ff33;
    color: #0a0f0a;
    border-bottom-right-radius: 4px;
  }
  .bubble.assistant-bubble {
    background: #0d2b0d;
    color: #33ff33;
    border-bottom-left-radius: 4px;
  }
  .bubble.user-bubble::after {
    content: '';
    position: absolute;
    bottom: -1px;
    right: -10px;
    width: 12px;
    height: 18px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='18'%3E%3Cpath d='M0,0 C0,0 0,14 10,18 C5,14 2,8 2,0 Z' fill='%2333ff33'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
  }
  .bubble.assistant-bubble::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: -10px;
    width: 12px;
    height: 18px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='18'%3E%3Cpath d='M12,0 C12,0 12,14 2,18 C7,14 10,8 10,0 Z' fill='%230d2b0d'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
  }
  .bubble-meta {
    font-size: 9px;
    margin-top: 2px;
    padding: 0 4px;
  }
  .bubble-wrap.from-user .bubble-meta { text-align: right; color: #1a6e1a; }
  .bubble-wrap.from-assistant .bubble-meta { text-align: left; color: #1a6e1a; }
  @keyframes bubbleIn {
    from { transform: translateY(12px) scale(0.95); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }

  /* CRT scanlines */
  #crt {
    position: fixed; inset: 0; pointer-events: none; z-index: 100;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 0, 0, 0.04) 2px, rgba(0, 0, 0, 0.04) 4px);
  }
  @keyframes flicker { 0% { opacity: 0.98; } 50% { opacity: 1; } 100% { opacity: 0.98; } }
  body { animation: flicker 4s infinite; }
</style>
</head>
<body>

<div id="topRight">
  <div class="title">OPENCLAW v5</div>
  <div id="connStatus">CONNECTING...</div>
  <div id="eventCount">0 EVENTS</div>
</div>

<div id="dashboard">
  <div id="dashContent">AWAITING DATA...</div>
</div>

<!-- TAMAGOTCHI PET -->
<div id="petContainer">
  <div id="petMood">IDLE</div>
  <div id="petBody">
    <div id="petSprite" class="pet-sprite idle">
      🐙
      <span class="zzz">Z</span>
    </div>
  </div>
  <div id="petStats">
    <span id="petUptime">UPTIME 0M</span> | <span id="petMsgs">0 MSG</span>
  </div>
</div>

<div id="feed"></div>
<div id="crt"></div>

<script>
const feed = document.getElementById('feed');
const petSprite = document.getElementById('petSprite');
const petMoodEl = document.getElementById('petMood');
const MAX_VISIBLE = 16;
const FADE_MS = 60000;
let total = 0;
const t0 = Date.now();
let lastEventId = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;

// ===== Emotion faces =====
const EMOTION_FACES = {
  idle:      '🐙',
  happy:     '🐙',
  ecstatic:  '🐙',
  proud:     '🐙',
  working:   '🐙',
  thinking:  '🐙',
  attentive: '🐙',
  worried:   '😰',
  scared:    '🙀',
  sorry:     '😿',
  sad:       '😿',
  confused:  '🤔',
  sleepy:    '😴',
};

const EMOTION_LABELS = {
  idle:      'CHILLIN',
  happy:     'HAPPY',
  ecstatic:  'LET\'S GOOO',
  proud:     'SHIPPED IT',
  working:   'BUILDING...',
  thinking:  'HMMM...',
  attentive: 'LISTENING',
  worried:   'UH OH',
  scared:    'OH NO',
  sorry:     'MY BAD',
  sad:       'SORRY',
  confused:  'HUH?',
  sleepy:    'ZZZ...',
};

function setPetEmotion(emotion) {
  const e = emotion || 'idle';
  petSprite.className = 'pet-sprite ' + e;
  petSprite.childNodes[0].textContent = EMOTION_FACES[e] || '🐙';
  petMoodEl.textContent = EMOTION_LABELS[e] || e.toUpperCase();
  petMoodEl.className = e;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function pnl(v) { return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2); }
function pc(v) { return v >= 0 ? 'ok' : 'warn'; }
function wrBar(wr, w) {
  const f = Math.round(wr / 100 * w);
  return '<span class="bar">' + '|'.repeat(f) + '<span class="dim">' + '.'.repeat(w - f) + '</span></span>';
}

function updateDashboard(data) {
  if (!data || !data.fund) return;
  const f = data.fund;
  const t = data.generated_at ? new Date(data.generated_at) : new Date();
  const utc = t.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' });

  let h = '';
  h += 'FUND OVERVIEW ' + utc + ' UTC<br>';
  h += '<div class="fund-pnl-big ' + pc(f.pnl) + '">' + pnl(f.pnl) + '</div>';
  h += f.trades + 'T ' + (f.win_rate||0).toFixed(1) + '%WR | BE: ' + (f.breakeven_wr||0).toFixed(1) + '%<br>';
  h += '24H: <span class="' + pc(f.daily_pnl||0) + '">' + pnl(f.daily_pnl||0) + '</span> (' + (f.daily_trades||0) + 'T)<br>';
  h += '<div class="separator">- - - - - - - - - - - - - - -</div>';

  const bots = data.bots || {};
  const active = Object.entries(bots)
    .filter(([_, b]) => b.trades > 0 || (b.status && b.status !== 'dead'))
    .sort((a, b) => Math.abs(b[1].pnl||0) - Math.abs(a[1].pnl||0));

  for (const [name, b] of active) {
    const st = b.status === 'active' ? 'LIVE' : b.status === 'paper' ? 'PAPER' : 'DEAD';
    const wr = b.win_rate || 0;
    h += '<div class="bot-line">' + name.toUpperCase() + ' [' + st + '] ';
    h += '<span class="' + pc(b.pnl) + '">' + pnl(b.pnl) + '</span> ';
    h += wr.toFixed(1) + '% ' + wrBar(wr, 10) + ' ' + (b.trades||0) + 'T';
    if (b.daily_pnl) h += ' 24h:<span class="' + pc(b.daily_pnl) + '">' + pnl(b.daily_pnl) + '</span>';
    h += '</div>';
  }

  document.getElementById('dashContent').innerHTML = h;
}

function addEntry(evt) {
  // Update pet on primary messages
  if (evt.sentiment) setPetEmotion(evt.sentiment);

  if (evt.primary) {
    const wrap = document.createElement('div');
    const isUser = evt.role === 'user';
    wrap.className = 'bubble-wrap ' + (isUser ? 'from-user' : 'from-assistant');
    wrap.dataset.ts = evt.ts || Date.now();
    const col = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (isUser ? 'user-bubble' : 'assistant-bubble');
    bubble.textContent = evt.text;
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const t = new Date(evt.timestamp);
    meta.textContent = (isUser ? 'USER' : 'GG') + ' ' + t.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', hour12: false });
    col.appendChild(bubble);
    col.appendChild(meta);
    wrap.appendChild(col);
    feed.appendChild(wrap);
  } else {
    const el = document.createElement('div');
    el.className = 'entry';
    el.dataset.ts = evt.ts || Date.now();
    const t = new Date(evt.timestamp);
    const ts = t.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
    el.innerHTML = '<span class="tag">[' + ts + ' ' + esc(evt.roleTag || '?') + ']</span> <span class="msg-text">' + esc(evt.text) + '</span>';
    feed.appendChild(el);
  }

  total++;
  document.getElementById('eventCount').textContent = total + ' EVENTS';
  document.getElementById('petMsgs').textContent = total + ' MSG';

  while (feed.children.length > MAX_VISIBLE) {
    const old = feed.firstElementChild;
    old.style.opacity = '0';
    setTimeout(() => old.remove(), 300);
  }
}

// Fade + cleanup + uptime
setInterval(() => {
  const now = Date.now();
  for (const el of feed.children) {
    const age = now - parseInt(el.dataset.ts || '0');
    if (age > FADE_MS && !el.classList.contains('fading')) el.classList.add('fading');
  }
  for (const el of [...feed.children]) {
    if (now - parseInt(el.dataset.ts || '0') > 120000 && el.classList.contains('fading')) el.remove();
  }
  const m = Math.floor((now - t0) / 60000);
  const upStr = m < 60 ? m + 'M' : Math.floor(m/60) + 'H' + (m%60) + 'M';
  document.getElementById('petUptime').textContent = 'UPTIME ' + upStr;
}, 5000);

// ===== BULLETPROOF SSE =====
function resetHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  // If no data in 30s, assume dead and force reconnect
  heartbeatTimer = setTimeout(() => {
    console.warn('[SSE] No data in 30s, forcing reconnect');
    if (window._es) { window._es.close(); window._es = null; }
    connect();
  }, 30000);
}

function connect() {
  if (window._es) { try { window._es.close(); } catch {} }
  
  // Add cache-buster to SSE URL
  const url = '/events?_t=' + Date.now();
  const es = new EventSource(url);
  window._es = es;

  es.onopen = () => {
    document.getElementById('connStatus').textContent = 'CONNECTED';
    document.getElementById('connStatus').style.color = '#33ff33';
    reconnectDelay = 1000;
    resetHeartbeat();
  };

  es.onmessage = (e) => {
    resetHeartbeat();
    if (e.lastEventId) lastEventId = e.lastEventId;
    try { addEntry(JSON.parse(e.data)); } catch {}
  };

  es.addEventListener('dashboard', (e) => {
    resetHeartbeat();
    try { updateDashboard(JSON.parse(e.data)); } catch {}
  });

  es.addEventListener('emotion', (e) => {
    resetHeartbeat();
    try { setPetEmotion(JSON.parse(e.data).emotion); } catch {}
  });

  es.onerror = () => {
    document.getElementById('connStatus').textContent = 'RECONNECTING...';
    document.getElementById('connStatus').style.color = '#ff5555';
    es.close();
    window._es = null;
    // Exponential backoff capped at 10s
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  };
}

// Also reconnect on visibility change (tab becomes visible again)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    console.log('[SSE] Tab visible, checking connection');
    if (!window._es || window._es.readyState === EventSource.CLOSED) connect();
  }
});

// Periodic health check - if EventSource is CLOSED, reconnect
setInterval(() => {
  if (!window._es || window._es.readyState === EventSource.CLOSED) {
    console.log('[SSE] Health check: reconnecting');
    connect();
  }
}, 15000);

connect();
</script>
</body>
</html>`;
