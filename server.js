#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server v7
 * 
 * Two visual layers:
 * 1. Fallout New Vegas terminal: green mono text for tools/system/dashboard
 * 2. iOS iMessage bubbles: blue (user sent) + gray (assistant received)
 * 
 * Tamagotchi pet in bottom-left with sentiment-driven emotions.
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

let petEmotion = 'idle';
let petEmotionTs = Date.now();

function analyzeSentiment(text, role) {
  const lower = text.toLowerCase();
  if (/(\bholy shit|incredible|breakthrough|massive|insane|record|best ever|crushing it|moon|10x)/.test(lower)) return 'ecstatic';
  if (/(fuck|shit|damn|wtf|broken|crashed|failed|wipeout|bleeding|lost \$|destroyed|-\$[5-9]\d|-\$\d{2,})/.test(lower)) return role === 'user' ? 'scared' : 'sorry';
  if (/(warning|alert|critical|emergency|⚠️|🚨|low balance|halted|blocked)/.test(lower)) return 'worried';
  if (/(sorry|apologize|my bad|mistake|regression|bug|error|wrong)/.test(lower)) return 'sorry';
  if (/(weird|strange|unexpected|doesn'?t make sense|confused|unclear)/.test(lower)) return 'confused';
  if (/(deployed|launched|built|created|completed|delivered|milestone)/.test(lower)) return 'proud';
  if (/(\bdone\b|✅|shipped|fixed|success|profit|\+\$|winning|nailed|perfect|awesome|great|🔥|💰)/.test(lower)) return 'happy';
  if (/(running|processing|spawning|building|installing|compiling|writing)/.test(lower)) return 'working';
  if (/(analyzing|checking|looking|searching|reading|scanning|hmm|let me)/.test(lower)) return 'thinking';
  if (/(heartbeat_ok|no changes|all good|nothing|quiet|idle)/.test(lower)) return 'sleepy';
  return role === 'user' ? 'attentive' : 'idle';
}

let dashboardData = null;

function refreshDashboard() {
  execCb('ssh hermes "cat /home/ubuntu/trading/fund_truth.json" 2>/dev/null', { timeout: 15000 }, (err, stdout) => {
    if (err || !stdout) return;
    try { dashboardData = JSON.parse(stdout); bus.emit('dashboard', dashboardData); } catch {}
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

// Strip OpenClaw XML context wrappers from user messages
function stripContextWrappers(text) {
  // Remove <graphiti-context>...</graphiti-context>
  text = text.replace(/<graphiti-context>[\s\S]*?<\/graphiti-context>/g, '');
  // Remove <task-ledger-context>...</task-ledger-context>
  text = text.replace(/<task-ledger-context>[\s\S]*?<\/task-ledger-context>/g, '');
  // Remove <summary ...>...</summary> blocks
  text = text.replace(/<summary[\s\S]*?<\/summary>/g, '');
  // Remove System: [...] lines
  text = text.replace(/System:\s*\[.*?\].*?\n/g, '');
  // Remove Conversation info + Sender metadata blocks (```json ... ```)
  text = text.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/g, '');
  text = text.replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/g, '');
  // Remove any remaining ```json...``` blocks
  text = text.replace(/```json[\s\S]*?```/g, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  // Collapse whitespace but keep meaningful newlines
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function parseMessage(line, channel) {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'message') return null;
    const msg = entry.message;
    if (!msg) return null;
    const role = msg.role;
    const timestamp = entry.timestamp || new Date().toISOString();

    let textParts = [];
    let toolParts = [];
    if (typeof msg.content === 'string') {
      textParts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) textParts.push(block.text);
        else if (block.type === 'toolCall') toolParts.push(`${block.name}(...)`);
        // Skip 'thinking' blocks entirely
      }
    }

    const hasText = textParts.length > 0;
    const hasToolCall = toolParts.length > 0;

    // Primary = user or assistant with actual text content (toolCalls alongside text are still primary)
    const isPrimary = (role === 'user' || role === 'assistant') && hasText;

    let text;
    if (isPrimary) {
      text = textParts.join('\n');
      if (role === 'user') text = stripContextWrappers(text);
      // Preserve newlines for display - just collapse multiple blanks
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } else if (hasToolCall) {
      text = toolParts.join(', ');
    } else if (hasText) {
      text = textParts.join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      return null;
    }

    if (!text || text.length < 2) return null;
    // Skip NO_REPLY, HEARTBEAT_OK, and internal runtime events
    if (/^(NO_REPLY|HEARTBEAT_OK)$/i.test(text.trim())) return null;
    if (/OpenClaw runtime context|^\[.*?\] OpenClaw|Internal task completion|runtime-generated.*not user-authored/i.test(text)) return null;
    // Skip heartbeat prompts, metadata-only messages
    if (/^Read HEARTBEAT\.md|^\[.*GMT.*\]\s*$/i.test(text.trim())) return null;
    // Skip messages that are just empty after context stripping
    if (text.replace(/[\s\n]/g, '').length < 3) return null;

    if (!isPrimary && text.length > 120) text = text.slice(0, 117) + '...';

    let sentiment = null;
    if (isPrimary) {
      sentiment = analyzeSentiment(text, role);
      petEmotion = sentiment;
      petEmotionTs = Date.now();
    }

    const roleTag = { user: 'USER', assistant: 'GG', toolCall: 'TOOL', toolResult: 'RES', system: 'SYS' }[role] || 'MSG';
    const roleClass = { user: 'user', assistant: 'assistant', toolCall: 'tool', toolResult: 'tool-result', system: 'system' }[role] || 'other';

    // Extract conversation label for user messages (thread context)
    let threadLabel = null;
    if (role === 'user' && typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          const labelMatch = block.text.match(/"conversation_label":\s*"([^"]+)"/);
          if (labelMatch) { threadLabel = labelMatch[1].replace(/\s*id:.*$/, '').trim(); break; }
        }
      }
    }

    return { id: entry.id || Math.random().toString(36).slice(2), channel, role: roleClass, roleTag, text, timestamp, ts: Date.now(), primary: isPrimary, sentiment, threadLabel };
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
  console.log(`  >> ${channel}`);
}

function scanSessions() {
  let added = 0;
  try {
    for (const agent of fs.readdirSync(SESSIONS_DIR)) {
      const sessDir = path.join(SESSIONS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
        const filePath = path.join(sessDir, file);
        if (!watchers.has(filePath)) {
          try { if (Date.now() - fs.statSync(filePath).mtimeMs < 86400000) { tailFile(filePath); added++; } } catch {}
        }
      }
    }
  } catch {}
  return added;
}
const initial = scanSessions();
setInterval(scanSessions, 30000);

// Pet emotion decay
setInterval(() => {
  if (Date.now() - petEmotionTs > 30000 && petEmotion !== 'idle' && petEmotion !== 'sleepy') {
    petEmotion = 'idle'; bus.emit('emotion', { emotion: 'idle' });
  }
  if (Date.now() - petEmotionTs > 120000 && petEmotion !== 'sleepy') {
    petEmotion = 'sleepy'; bus.emit('emotion', { emotion: 'sleepy' });
  }
}, 5000);

let sseSeq = 0;
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/events') {
    res.writeHead(200, { ...NO_CACHE, 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Send initial state
    res.write(`event: emotion\ndata: ${JSON.stringify({ emotion: petEmotion })}\n\n`);
    if (dashboardData) res.write(`event: dashboard\ndata: ${JSON.stringify(dashboardData)}\n\n`);
    // Replay recent events
    for (const evt of recentEvents.slice(-20)) { sseSeq++; res.write(`id: ${sseSeq}\ndata: ${JSON.stringify(evt)}\n\n`); }

    const h1 = (evt) => { sseSeq++; try { res.write(`id: ${sseSeq}\ndata: ${JSON.stringify(evt)}\n\n`); } catch {} };
    const h2 = (d) => { try { res.write(`event: dashboard\ndata: ${JSON.stringify(d)}\n\n`); } catch {} };
    const h3 = (d) => { try { res.write(`event: emotion\ndata: ${JSON.stringify(d)}\n\n`); } catch {} };
    bus.on('event', h1); bus.on('dashboard', h2); bus.on('emotion', h3);
    const ka = setInterval(() => { try { res.write(`: ka\n\n`); } catch { clearInterval(ka); } }, 10000);
    req.on('close', () => { bus.off('event', h1); bus.off('dashboard', h2); bus.off('emotion', h3); clearInterval(ka); });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { ...NO_CACHE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, watching: watchers.size, buffered: recentEvents.length, emotion: petEmotion }));
    return;
  }

  // Serve overlay HTML
  res.writeHead(200, { ...NO_CACHE, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  OBS Overlay v7 :: http://localhost:${PORT}`);
  console.log(`  ${watchers.size} sessions | Dashboard ${DASHBOARD_INTERVAL / 1000}s\n`);
});

// ============================================================
// HTML
// ============================================================
const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>OPENCLAW</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');

  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    background: transparent;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    color: #33ff33;
    overflow: hidden;
    width: 100vw; height: 100vh;
    font-size: 12px;
    animation: flicker 4s infinite;
  }
  @keyframes flicker { 0%{opacity:0.98} 50%{opacity:1} 100%{opacity:0.98} }

  /* ===== FALLOUT TERMINAL: no borders, no bg, no shadows, no icons ===== */
  .dim { color: #1a8c1a; }
  .bright { color: #55ff55; }
  .warn { color: #ff5555; }
  .ok { color: #33ff33; }

  /* Dashboard: top-left */
  #dashboard {
    position: fixed; top: 16px; left: 16px;
    width: 44%; max-height: 36%;
    overflow: hidden; line-height: 1.5;
  }
  .fund-pnl-big { font-family:'VT323',monospace; font-size:38px; line-height:1.1; }
  .separator { color:#1a6e1a; letter-spacing:2px; font-size:10px; }
  .bot-line { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px; }
  .bar { display:inline-block; letter-spacing:-1px; }

  /* Top-right: status */
  #topRight {
    position: fixed; top: 16px; right: 16px;
    text-align: right; font-size: 11px; color: #1a8c1a;
  }
  #topRight .title { color: #33ff33; font-size: 14px; letter-spacing: 2px; }

  /* ===== PET: bottom-left ===== */
  #petContainer {
    position: fixed; bottom: 16px; left: 16px;
    width: 120px; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-end;
  }
  #petMood { font-size:9px; color:#1a8c1a; text-transform:uppercase; letter-spacing:1px; margin-bottom:2px; }
  #petBody { position:relative; width:64px; height:64px; }
  .pet-sprite {
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:48px; filter:drop-shadow(0 0 6px rgba(51,255,51,0.3));
    transition: transform 0.3s, filter 0.3s;
  }
  .pet-sprite.idle { animation: petBob 3s ease-in-out infinite; }
  .pet-sprite.happy { animation: petBounce 0.6s ease-in-out infinite; filter:drop-shadow(0 0 10px rgba(51,255,51,0.6)); }
  .pet-sprite.ecstatic { animation: petSpin 0.8s ease-in-out infinite; filter:drop-shadow(0 0 16px rgba(51,255,51,0.8)); }
  .pet-sprite.sorry,.pet-sprite.sad { animation: petDroop 2s ease-in-out infinite; filter:drop-shadow(0 0 4px rgba(51,255,51,0.15)); }
  .pet-sprite.scared { animation: petShake 0.3s ease-in-out infinite; }
  .pet-sprite.worried { animation: petWobble 1.5s ease-in-out infinite; filter:drop-shadow(0 0 6px rgba(255,85,85,0.3)); }
  .pet-sprite.thinking { animation: petTilt 2s ease-in-out infinite; }
  .pet-sprite.working { animation: petPulse 1s ease-in-out infinite; filter:drop-shadow(0 0 10px rgba(51,255,51,0.5)); }
  .pet-sprite.proud { animation: petGrow 1.5s ease-in-out infinite; filter:drop-shadow(0 0 14px rgba(51,255,51,0.7)); }
  .pet-sprite.attentive { animation: petPerk 1s ease-in-out infinite; }
  .pet-sprite.confused { animation: petConfused 1.2s ease-in-out infinite; }
  .pet-sprite.sleepy { animation: petSleep 4s ease-in-out infinite; opacity:0.4; }
  .zzz { position:absolute; top:-8px; right:-2px; font-size:12px; color:#1a8c1a; opacity:0; }
  .pet-sprite.sleepy .zzz { animation: petZzz 3s ease-in-out infinite; }
  @keyframes petBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
  @keyframes petBounce { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-12px) scale(1.05)} }
  @keyframes petSpin { 0%{transform:rotate(0) scale(1.1)} 25%{transform:rotate(5deg) translateY(-8px) scale(1.15)} 50%{transform:rotate(0) translateY(-14px)} 75%{transform:rotate(-5deg) translateY(-8px) scale(1.15)} 100%{transform:rotate(0) scale(1.1)} }
  @keyframes petDroop { 0%,100%{transform:translateY(0) rotate(0)} 50%{transform:translateY(3px) rotate(-5deg)} }
  @keyframes petShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-5px)} 75%{transform:translateX(5px)} }
  @keyframes petWobble { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-7deg)} 75%{transform:rotate(7deg)} }
  @keyframes petTilt { 0%,100%{transform:rotate(0)} 50%{transform:rotate(12deg) translateY(-2px)} }
  @keyframes petPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.07)} }
  @keyframes petGrow { 0%,100%{transform:scale(1) translateY(0)} 50%{transform:scale(1.12) translateY(-6px)} }
  @keyframes petPerk { 0%,100%{transform:translateY(0) scale(1)} 30%{transform:translateY(-6px) scale(1.03)} 60%{transform:translateY(-2px)} }
  @keyframes petConfused { 0%,100%{transform:rotate(0)} 20%{transform:rotate(8deg)} 40%{transform:rotate(-8deg)} 60%{transform:rotate(4deg)} 80%{transform:rotate(-2deg)} }
  @keyframes petSleep { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(2px) scale(0.97)} }
  @keyframes petZzz { 0%{opacity:0;transform:translate(0,0) scale(0.5)} 30%{opacity:1} 100%{opacity:0;transform:translate(12px,-25px) scale(1.2)} }
  #petMood.happy,#petMood.ecstatic,#petMood.proud { color:#33ff33; }
  #petMood.worried,#petMood.scared { color:#ff5555; }
  #petStats { font-size:8px; color:#1a6e1a; margin-top:2px; }

  /* ===== FEED: bottom-right, mixed terminal lines + iOS bubbles ===== */
  #feed {
    position: fixed; bottom: 16px; right: 16px;
    width: 52%; max-height: 70vh;
    display: flex; flex-direction: column; justify-content: flex-end;
    overflow-y: auto; overflow-x: hidden;
    scrollbar-width: none;
  }
  #feed::-webkit-scrollbar { display: none; }

  /* Terminal entries (tool calls, tool results, system) — the matrix behind the chat */
  .entry {
    padding: 1px 0; font-size: 10px; color: #1a8c1a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    animation: fadeIn 0.3s ease-out;
  }
  .entry .tag { color:#1a6e1a; }
  .entry .ch { color:#145514; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }

  /* iOS iMessage bubbles */
  .imsg {
    display: flex; margin: 3px 0; padding: 0 4px;
    animation: imsgPop 0.25s cubic-bezier(0.22,1,0.36,1);
  }
  .imsg.sent { justify-content: flex-end; }
  .imsg.recv { justify-content: flex-start; }
  .imsg-col { max-width: 82%; }

  .imsg-bubble {
    padding: 8px 14px;
    font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
    font-size: 15px; line-height: 1.4;
    word-wrap: break-word; white-space: pre-wrap;
    border-radius: 18px; position: relative;
    max-width: 520px;
  }

  /* Long bubble: Twitch-style auto-scroll with top+bottom fade */
  .imsg-bubble-wrap {
    position: relative;
    max-height: 180px;
    overflow: hidden;
  }
  .imsg-bubble-wrap.scrollable::before,
  .imsg-bubble-wrap.scrollable::after {
    content: ''; position: absolute; left: 0; right: 0; height: 28px;
    pointer-events: none; z-index: 2;
  }
  .imsg-bubble-wrap.scrollable.sent-wrap::before { top:0; background: linear-gradient(to bottom, #007AFF 0%, transparent 100%); border-radius: 18px 18px 0 0; }
  .imsg-bubble-wrap.scrollable.sent-wrap::after { bottom:0; background: linear-gradient(to top, #007AFF 0%, transparent 100%); border-radius: 0 0 18px 4px; }
  .imsg-bubble-wrap.scrollable.recv-wrap::before { top:0; background: linear-gradient(to bottom, #E9E9EB 0%, transparent 100%); border-radius: 18px 18px 0 0; }
  .imsg-bubble-wrap.scrollable.recv-wrap::after { bottom:0; background: linear-gradient(to top, #E9E9EB 0%, transparent 100%); border-radius: 0 0 4px 18px; }

  .imsg-bubble-inner {
    max-height: 180px;
    overflow: hidden;
  }
  /* When scrolling, the inner div animates translateY */
  .imsg-bubble-inner.scrolling {
    animation: bubbleScroll var(--scroll-duration, 12s) linear infinite;
  }
  @keyframes bubbleScroll {
    0% { transform: translateY(0); }
    10% { transform: translateY(0); }
    90% { transform: translateY(var(--scroll-distance, -200px)); }
    100% { transform: translateY(var(--scroll-distance, -200px)); }
  }

  /* User = iOS blue, right-aligned */
  .imsg.sent .imsg-bubble {
    background: #007AFF; color: #fff;
    border-bottom-right-radius: 4px;
  }
  .imsg.sent .imsg-bubble::after {
    content: ''; position: absolute; bottom: 0; right: -8px;
    width: 12px; height: 18px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='18'%3E%3Cpath d='M0,0 C0,0 0,14 10,18 C5,14 2,8 2,0 Z' fill='%23007AFF'/%3E%3C/svg%3E") no-repeat;
  }

  /* Assistant = iOS gray, left-aligned */
  .imsg.recv .imsg-bubble {
    background: #E9E9EB; color: #000;
    border-bottom-left-radius: 4px;
  }
  .imsg.recv .imsg-bubble::after {
    content: ''; position: absolute; bottom: 0; left: -8px;
    width: 12px; height: 18px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='18'%3E%3Cpath d='M12,0 C12,0 12,14 2,18 C7,14 10,8 10,0 Z' fill='%23E9E9EB'/%3E%3C/svg%3E") no-repeat;
  }

  .imsg-meta {
    font-family: 'Share Tech Mono', monospace;
    font-size: 9px; margin-top: 1px; padding: 0 4px; color: #1a6e1a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .imsg.sent .imsg-meta { text-align: right; }
  .imsg.recv .imsg-meta { text-align: left; }

  @keyframes imsgPop {
    from { transform: translateY(8px) scale(0.95); opacity:0; }
    to { transform: translateY(0) scale(1); opacity:1; }
  }

  /* Markdown inside bubbles */
  .imsg-bubble strong { font-weight: 600; }
  .imsg-bubble em { font-style: italic; }
  .imsg-bubble del { text-decoration: line-through; opacity: 0.7; }
  .imsg-bubble .md-code {
    font-family: 'Share Tech Mono', 'SF Mono', monospace;
    font-size: 13px; padding: 1px 4px; border-radius: 4px;
  }
  .imsg.recv .md-code { background: rgba(0,0,0,0.08); }
  .imsg.sent .md-code { background: rgba(255,255,255,0.2); }
  .imsg-bubble .md-pre {
    font-family: 'Share Tech Mono', 'SF Mono', monospace;
    font-size: 12px; padding: 4px 8px; border-radius: 6px;
    margin: 4px 0; display: block; white-space: pre-wrap;
  }
  .imsg.recv .md-pre { background: rgba(0,0,0,0.06); }
  .imsg.sent .md-pre { background: rgba(255,255,255,0.15); }
  .imsg-bubble .md-li { display: block; padding-left: 8px; text-indent: -8px; }
  .imsg-bubble .md-h1 { font-size: 16px; display: block; margin: 4px 0 2px; }
  .imsg-bubble .md-h2 { font-size: 15px; display: block; margin: 3px 0 2px; }
  .imsg-bubble .md-h3 { font-size: 14px; display: block; margin: 2px 0 1px; }

  /* Nestling: JS adds .grouped to consecutive same-sender bubbles */
  .imsg.grouped { margin-top: 1px; }
  .imsg.sent.grouped .imsg-bubble { border-top-right-radius: 6px; }
  .imsg.recv.grouped .imsg-bubble { border-top-left-radius: 6px; }
  .imsg.grouped .imsg-bubble::after { display: none; }
  .imsg.grouped .imsg-meta { display: none; }

  /* Fading for old entries */
  .fading { opacity: 0.15; transition: opacity 5s ease-out; }

  /* CRT scanlines */
  #crt {
    position:fixed; inset:0; pointer-events:none; z-index:100;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
  }
</style>
</head>
<body>

<div id="topRight">
  <div class="title">OPENCLAW</div>
  <div id="connStatus" style="color:#ff5555">CONNECTING...</div>
  <div id="eventCount">0 EVENTS</div>
</div>

<div id="dashboard"><div id="dashContent">AWAITING TELEMETRY...</div></div>

<div id="petContainer">
  <div id="petMood">IDLE</div>
  <div id="petBody">
    <div id="petSprite" class="pet-sprite idle">🐙<span class="zzz">Z</span></div>
  </div>
  <div id="petStats"><span id="petUptime">UP 0M</span> | <span id="petMsgs">0</span></div>
</div>

<div id="feed"></div>
<div id="crt"></div>

<script>
const feed = document.getElementById('feed');
const MAX_VISIBLE = 24;
const FADE_AFTER = 90000;
let total = 0;
const t0 = Date.now();
let lastBubbleSender = null; // Track for nestling

const FACES = {
  idle:'🐙', happy:'🐙', ecstatic:'🐙', proud:'🐙', working:'🐙',
  thinking:'🐙', attentive:'🐙', worried:'😰', scared:'🙀',
  sorry:'😿', confused:'🤔', sleepy:'😴'
};
const LABELS = {
  idle:'CHILLIN', happy:'HAPPY', ecstatic:"LET'S GOOO", proud:'SHIPPED',
  working:'BUILDING...', thinking:'HMMM...', attentive:'LISTENING',
  worried:'UH OH', scared:'OH NO', sorry:'MY BAD',
  confused:'HUH?', sleepy:'ZZZ'
};

function setPet(e) {
  e = e || 'idle';
  const s = document.getElementById('petSprite');
  s.className = 'pet-sprite ' + e;
  s.childNodes[0].textContent = FACES[e] || '🐙';
  const m = document.getElementById('petMood');
  m.textContent = LABELS[e] || e.toUpperCase();
  m.className = e;
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// Lightweight markdown → HTML (safe: escapes first, then applies formatting)
function md(raw) {
  let s = esc(raw);
  // Code blocks
  const cbRe = new RegExp('\x60\x60\x60[\\s\\S]*?\x60\x60\x60', 'g');
  s = s.replace(cbRe, m => '<pre class="md-pre">' + m.slice(3,-3).trim() + '</pre>');
  // Inline code
  const icRe = new RegExp('\x60([^\x60\\n]+)\x60', 'g');
  s = s.replace(icRe, '<code class="md-code">$1</code>');
  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic: *text* or _text_ (but not inside words with underscores)
  s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Bullet lists: lines starting with - or *
  s = s.replace(/^([•\-\*])\s+(.+)$/gm, '<span class="md-li">$1 $2</span>');
  // Numbered lists: lines starting with 1. 2. etc
  s = s.replace(/^(\d+)\.\s+(.+)$/gm, '<span class="md-li">$1. $2</span>');
  // Headers: # ## ### (render as bold, slightly bigger)
  s = s.replace(/^#{3}\s+(.+)$/gm, '<strong class="md-h3">$1</strong>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<strong class="md-h2">$1</strong>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<strong class="md-h1">$1</strong>');
  // Emoji checkmarks: ✅ ❌ ⚠️ already render natively
  return s;
}
function pnl(v) { return (v>=0?'+':'-') + '$' + Math.abs(v).toFixed(2); }
function pc(v) { return v>=0?'ok':'warn'; }
function wrBar(wr, w) {
  const f = Math.round(wr/100*w);
  return '<span class="bar">' + '|'.repeat(f) + '<span class="dim">' + '.'.repeat(w-f) + '</span></span>';
}

function updateDash(data) {
  if (!data || !data.fund) return;
  const f = data.fund;
  const t = data.generated_at ? new Date(data.generated_at) : new Date();
  const utc = t.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
  let h = '<span class="dim">FUND</span> ' + utc + ' UTC<br>';
  h += '<div class="fund-pnl-big ' + pc(f.pnl) + '">' + pnl(f.pnl) + '</div>';
  h += f.trades + 'T ' + (f.win_rate||0).toFixed(1) + '%WR  BE:' + (f.breakeven_wr||0).toFixed(1) + '%<br>';
  h += '24H <span class="' + pc(f.daily_pnl||0) + '">' + pnl(f.daily_pnl||0) + '</span> (' + (f.daily_trades||0) + 'T)<br>';
  h += '<span class="separator">-------------------------------</span>';
  const bots = data.bots || {};
  const active = Object.entries(bots).filter(([_,b])=>b.trades>0||(b.status&&b.status!=='dead')).sort((a,b)=>Math.abs(b[1].pnl||0)-Math.abs(a[1].pnl||0));
  for (const [name,b] of active) {
    const st = b.status==='active'?'LIVE':b.status==='paper'?'PPR':'DEAD';
    const wr = b.win_rate||0;
    h += '<div class="bot-line">' + name.toUpperCase() + ' ' + st + ' <span class="' + pc(b.pnl) + '">' + pnl(b.pnl) + '</span> ' + wr.toFixed(0) + '% ' + wrBar(wr,8) + ' ' + (b.trades||0) + 'T</div>';
  }
  document.getElementById('dashContent').innerHTML = h;
}

let lastBubbleRole = null;

function addEntry(evt) {
  if (evt.sentiment) setPet(evt.sentiment);
  total++;
  document.getElementById('eventCount').textContent = total + ' EVENTS';
  document.getElementById('petMsgs').textContent = total;

  if (evt.primary) {
    // === iOS iMessage bubble ===
    const isUser = evt.role === 'user';
    const sameAsLast = lastBubbleRole === (isUser ? 'sent' : 'recv');

    // If same sender as last bubble, mark the previous one as grouped
    if (sameAsLast) {
      const prevBubbles = feed.querySelectorAll('.imsg.' + (isUser ? 'sent' : 'recv'));
      if (prevBubbles.length > 0) {
        const prev = prevBubbles[prevBubbles.length - 1];
        prev.classList.add('grouped');
      }
    }

    const row = document.createElement('div');
    row.className = 'imsg ' + (isUser ? 'sent' : 'recv');
    row.dataset.ts = evt.ts || Date.now();

    const col = document.createElement('div');
    col.className = 'imsg-col';

    // Bubble wrapper for scroll containment
    const wrap = document.createElement('div');
    wrap.className = 'imsg-bubble-wrap ' + (isUser ? 'sent-wrap' : 'recv-wrap');

    const bubble = document.createElement('div');
    bubble.className = 'imsg-bubble';

    const inner = document.createElement('div');
    inner.className = 'imsg-bubble-inner';
    inner.innerHTML = md(evt.text);

    bubble.appendChild(inner);
    wrap.appendChild(bubble);

    // Meta: compact thread + time
    const meta = document.createElement('div');
    meta.className = 'imsg-meta';
    const t = new Date(evt.timestamp);
    const timeStr = t.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',hour12:false});
    const who = isUser ? 'WILL' : 'GG';
    const thread = evt.threadLabel ? evt.threadLabel + ' · ' : (evt.channel ? evt.channel + ' · ' : '');
    meta.textContent = thread + who + ' ' + timeStr;

    col.appendChild(wrap);
    col.appendChild(meta);
    row.appendChild(col);
    feed.appendChild(row);

    // Check if bubble overflows and needs Twitch-style scroll
    requestAnimationFrame(() => {
      const scrollH = inner.scrollHeight;
      const maxH = 180;
      if (scrollH > maxH) {
        wrap.classList.add('scrollable');
        const distance = scrollH - maxH + 28; // scroll distance + fade padding
        const duration = Math.max(6, Math.min(20, distance / 20)); // ~20px/sec, clamped
        inner.style.setProperty('--scroll-distance', '-' + distance + 'px');
        inner.style.setProperty('--scroll-duration', duration + 's');
        inner.classList.add('scrolling');
      }
    });

    lastBubbleRole = isUser ? 'sent' : 'recv';
  } else {
    // === Fallout terminal line ===
    const el = document.createElement('div');
    el.className = 'entry';
    el.dataset.ts = evt.ts || Date.now();
    const t = new Date(evt.timestamp);
    const ts = t.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    el.innerHTML = '<span class="tag">[' + ts + ']</span> <span class="ch">' + esc(evt.channel||'') + '</span> ' + esc(evt.text);
    feed.appendChild(el);
    // Don't reset lastBubbleRole: terminal entries don't break bubble groups
  }

  // Trim
  while (feed.children.length > MAX_VISIBLE) feed.firstElementChild.remove();
  // Auto-scroll to bottom
  feed.scrollTop = feed.scrollHeight;
}

// Fade old + uptime
setInterval(() => {
  const now = Date.now();
  for (const el of feed.children) {
    const age = now - parseInt(el.dataset.ts||'0');
    if (age > FADE_AFTER && !el.classList.contains('fading')) el.classList.add('fading');
    if (age > 180000 && el.classList.contains('fading')) el.remove();
  }
  const m = Math.floor((now-t0)/60000);
  document.getElementById('petUptime').textContent = 'UP ' + (m<60 ? m+'M' : Math.floor(m/60)+'H'+(m%60)+'M');
}, 5000);

// ===== SSE with reconnect =====
let reconnectDelay = 1000;
let heartbeatTimer = null;

function resetHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    if (window._es) { window._es.close(); window._es = null; }
    connect();
  }, 25000);
}

function connect() {
  if (window._es) { try{window._es.close();}catch{} window._es=null; }
  const es = new EventSource('/events?t=' + Date.now());
  window._es = es;
  es.onopen = () => {
    document.getElementById('connStatus').textContent = 'LIVE';
    document.getElementById('connStatus').style.color = '#33ff33';
    reconnectDelay = 1000;
    resetHeartbeat();
  };
  es.onmessage = (e) => { resetHeartbeat(); try{addEntry(JSON.parse(e.data));}catch{} };
  es.addEventListener('dashboard', (e) => { resetHeartbeat(); try{updateDash(JSON.parse(e.data));}catch{} });
  es.addEventListener('emotion', (e) => { resetHeartbeat(); try{setPet(JSON.parse(e.data).emotion);}catch{} });
  es.onerror = () => {
    document.getElementById('connStatus').textContent = 'RECONNECTING';
    document.getElementById('connStatus').style.color = '#ff5555';
    es.close(); window._es = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*1.5, 10000);
  };
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!window._es || window._es.readyState === EventSource.CLOSED)) connect();
});
setInterval(() => { if (!window._es || window._es.readyState === EventSource.CLOSED) connect(); }, 15000);
connect();
</script>
</body>
</html>`;
