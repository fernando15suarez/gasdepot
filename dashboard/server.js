// rigs-dashboard — read-only Gas Town status page.
//
// Designed to run as a sibling container of `gastown`. All state queries run
// via `docker exec ${GT_TARGET_CONTAINER} ...`:
//   - gt status --json        → rig/agent state
//   - bd ready --json,
//     bd list --status … --json → beads buckets
//   - tmux capture-pane …     → live agent screen snapshots
//
// Nothing is persisted here. Auth is a single shared token; if
// DASHBOARD_AUTH_TOKEN is unset, anyone reaching the port can view.

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3338', 10);
const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || '';
const TARGET_CONTAINER = process.env.GT_TARGET_CONTAINER || 'gastown';
const TARGET_USER = process.env.GT_TARGET_USER || 'gastown';
const TMUX_SOCKET = process.env.TMUX_SOCKET_PATH || '/tmp/tmux-1000/default';
const POLL_INTERVAL_MS = parseInt(process.env.DASHBOARD_POLL_MS || '5000', 10);

const app = express();
app.set('trust proxy', 'loopback');

function authOk(req) {
  if (!AUTH_TOKEN) return true;
  const t = req.query.token || req.get('x-dashboard-token');
  return t && t === AUTH_TOKEN;
}

function requireAuth(req, res, next) {
  if (authOk(req)) return next();
  res.status(401).type('text/plain').send('Unauthorized');
}

function spawnCmd(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function dockerExec(argv, opts) {
  return spawnCmd('docker', ['exec', '-u', TARGET_USER, TARGET_CONTAINER, ...argv], opts);
}

async function gtStatus() {
  const r = await dockerExec(['gt', 'status', '--json', '--fast']);
  if (r.code !== 0) return { error: r.stderr.trim() || `gt status exited ${r.code}` };
  try { return JSON.parse(r.stdout); }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

async function bdJson(args) {
  const r = await dockerExec(['bd', ...args, '--json']);
  if (r.code !== 0) return { error: r.stderr.trim() || `bd exited ${r.code}` };
  try {
    const v = JSON.parse(r.stdout);
    return Array.isArray(v) ? v : [];
  } catch (e) { return { error: 'parse: ' + e.message }; }
}

async function bdReady() {
  const v = await bdJson(['ready']);
  return Array.isArray(v) ? v : [];
}

async function bdInProgress() {
  const v = await bdJson(['list', '--status', 'in_progress']);
  return Array.isArray(v) ? v : [];
}

async function bdRecentClosed(limit = 10) {
  const v = await bdJson(['list', '--status', 'closed']);
  if (!Array.isArray(v)) return [];
  return v
    .slice()
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, limit);
}

async function capturePane(session, lines = 50) {
  if (!/^[A-Za-z0-9._-]+$/.test(session)) return null;
  const args = ['tmux', '-S', TMUX_SOCKET, 'capture-pane', '-p', '-S', `-${lines}`, '-t', session];
  const r = await dockerExec(args, { timeoutMs: 3000 });
  if (r.code !== 0) return null;
  return r.stdout.replace(/\s+$/g, '');
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusDot(running, hasWork) {
  if (running && hasWork) return 'green';
  if (running) return 'yellow';
  return 'red';
}

function flattenAgents(status) {
  const all = [];
  if (status && Array.isArray(status.agents)) {
    for (const a of status.agents) all.push({ ...a, rig: '_town' });
  }
  if (status && Array.isArray(status.rigs)) {
    for (const rig of status.rigs) {
      if (Array.isArray(rig.agents)) {
        for (const a of rig.agents) all.push({ ...a, rig: rig.name });
      }
    }
  }
  return all;
}

async function snapshot() {
  const [status, ready, inprog, recent] = await Promise.all([
    gtStatus(),
    bdReady(),
    bdInProgress(),
    bdRecentClosed(),
  ]);
  const agents = flattenAgents(status);
  const panes = {};
  await Promise.all(agents.slice(0, 24).map(async (a) => {
    if (!a.session || !a.running) return;
    const pane = await capturePane(a.session, 12);
    if (pane) panes[a.session] = pane;
  }));
  return {
    status,
    beads: { ready, in_progress: inprog, recent_closed: recent },
    panes,
    generated_at: new Date().toISOString(),
  };
}

function renderBeadRow(b) {
  const id = escHtml(b.id);
  const title = escHtml((b.title || '').slice(0, 120));
  const prio = b.priority != null ? `P${b.priority}` : '';
  const assignee = escHtml(b.assignee || '');
  return `
    <li class="bead">
      <span class="bead-id">${id}</span>
      ${prio ? `<span class="prio prio-${escHtml(String(b.priority))}">${escHtml(prio)}</span>` : ''}
      <span class="bead-title">${title}</span>
      ${assignee ? `<span class="bead-assignee">${assignee}</span>` : ''}
    </li>`;
}

function renderAgentRow(a, panes) {
  const dot = statusDot(a.running, a.has_work);
  const session = escHtml(a.session || '');
  const name = escHtml(a.name || '');
  const role = escHtml(a.role || '');
  const pane = panes[a.session];
  const paneHtml = pane
    ? `<pre class="pane">${escHtml(pane)}</pre>`
    : '';
  const work = a.has_work ? '<span class="work-flag">hooked</span>' : '';
  return `
    <li class="agent">
      <span class="dot dot-${dot}" title="${a.running ? 'running' : 'stopped'}"></span>
      <span class="agent-name">${name}</span>
      <span class="agent-role">${role}</span>
      ${session ? `<span class="agent-session">${session}</span>` : ''}
      ${work}
      ${paneHtml}
    </li>`;
}

function renderHTML(snap) {
  const status = snap.status || {};
  const townAgents = (status.agents || []);
  const rigs = status.rigs || [];
  const beads = snap.beads || { ready: [], in_progress: [], recent_closed: [] };
  const panes = snap.panes || {};
  const errBanner = status.error
    ? `<div class="err">gt status error: ${escHtml(status.error)}</div>`
    : '';

  const townHtml = `
    <section class="rig">
      <h2>Town · ${escHtml(status.name || 'gastown')}</h2>
      <ul class="agents">${townAgents.map((a) => renderAgentRow(a, panes)).join('')}</ul>
    </section>`;

  const rigsHtml = rigs.map((r) => `
    <section class="rig">
      <h2>${escHtml(r.name)} <span class="rig-counts">${(r.polecats || []).length} polecats</span></h2>
      <ul class="agents">${(r.agents || []).map((a) => renderAgentRow(a, panes)).join('')}</ul>
    </section>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gas Town · rigs dashboard</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <h1>Gas Town</h1>
  <span class="updated" id="updated">last update: ${escHtml(snap.generated_at)}</span>
</header>
${errBanner}
<main>
  ${townHtml}
  ${rigsHtml}
  <section class="beads">
    <h2>Beads · in_progress (${beads.in_progress.length})</h2>
    <ul class="bead-list">${beads.in_progress.map(renderBeadRow).join('') || '<li class="empty">none</li>'}</ul>
  </section>
  <section class="beads">
    <h2>Beads · ready (${beads.ready.length})</h2>
    <ul class="bead-list">${beads.ready.slice(0, 30).map(renderBeadRow).join('') || '<li class="empty">none</li>'}</ul>
  </section>
  <section class="beads">
    <h2>Beads · recently closed</h2>
    <ul class="bead-list">${beads.recent_closed.map(renderBeadRow).join('') || '<li class="empty">none</li>'}</ul>
  </section>
</main>
<footer>auto-refreshes every ${Math.round(POLL_INTERVAL_MS / 1000)}s · read-only</footer>
<script src="/app.js"></script>
</body>
</html>`;
}

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok\n');
});

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  return requireAuth(req, res, next);
});

app.get('/style.css', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

app.get('/app.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.get('/', async (_req, res) => {
  try {
    const snap = await snapshot();
    res.type('html').send(renderHTML(snap));
  } catch (e) {
    res.status(500).type('text/plain').send('snapshot error: ' + e.message);
  }
});

app.get('/snapshot.json', async (_req, res) => {
  try {
    const snap = await snapshot();
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/pane/:agent', async (req, res) => {
  const session = req.params.agent;
  const linesRaw = parseInt(req.query.lines || '50', 10);
  const lines = Math.max(5, Math.min(500, isNaN(linesRaw) ? 50 : linesRaw));
  const pane = await capturePane(session, lines);
  if (pane == null) {
    return res.status(404).type('text/plain').send(`no pane for ${session}`);
  }
  res.type('text/plain').send(pane);
});

app.get('/events', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  req.on('close', () => { closed = true; });

  async function tick() {
    if (closed) return;
    try {
      const snap = await snapshot();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    if (!closed) setTimeout(tick, POLL_INTERVAL_MS);
  }
  tick();
});

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`rigs-dashboard listening on :${PORT} target=${TARGET_CONTAINER} auth=${AUTH_TOKEN ? 'on' : 'off'}`);
});
