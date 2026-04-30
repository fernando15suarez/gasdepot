// Tests for dashboard/server.js argument-building helpers.
//
// These run without binding the HTTP port (server.js only calls app.listen
// when invoked as the main module). They cover the regressions the runtime
// integration would have caught — but won't, since the dashboard image isn't
// built in CI and there's no easy way to spin up a docker-in-docker harness
// for a unit test.

const test = require('node:test');
const assert = require('node:assert/strict');

// Force defaults to known values BEFORE require so module-scope env reads
// resolve to our fixtures. (Production overrides via real env still work.)
delete process.env.GT_TARGET_USER;
delete process.env.GT_TARGET_CONTAINER;
delete process.env.GT_TARGET_WORKDIR;
process.env.DASHBOARD_AUTH_TOKEN = 'test-token-xyz';

const http = require('node:http');

const { app, __test } = require('../server');
const { buildDockerExecArgs, snapshot, setDockerExecForTest, resetSnapshotCacheForTest } = __test;

// Tiny HTTP helper for the routing tests below — node:test has nothing
// fancier than fetch in newer node, but we want this to run on node 18+.
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, host: '127.0.0.1', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('docker exec includes -w so gt/bd land inside a Gas Town workspace', () => {
  // Regression: PR #17 originally shipped without -w. `gt status` and `bd`
  // both refuse to run outside a workspace, so the dashboard's snapshot.json
  // returned `{"status":{"error":"not in a Gas Town workspace ..."}}`.
  const args = buildDockerExecArgs(['gt', 'status', '--json', '--fast']);
  const wIdx = args.indexOf('-w');
  assert.notStrictEqual(wIdx, -1, '-w must be present');
  assert.strictEqual(args[wIdx + 1], '/gastown/repos/hq', '-w must point at a GT workspace');
});

test('docker exec preserves user, container, and command tail', () => {
  const args = buildDockerExecArgs(['bd', 'ready', '--json']);
  // Shape: ['exec', '-u', <user>, '-w', <workdir>, <container>, 'bd', 'ready', '--json']
  assert.strictEqual(args[0], 'exec');
  assert.strictEqual(args[1], '-u');
  assert.strictEqual(args[2], 'gastown');
  assert.strictEqual(args[3], '-w');
  assert.strictEqual(args[4], '/gastown/repos/hq');
  assert.strictEqual(args[5], 'gastown');
  assert.deepStrictEqual(args.slice(6), ['bd', 'ready', '--json']);
});

test('overrides flow through (env var customization works)', () => {
  const args = buildDockerExecArgs(['tmux', 'capture-pane'], {
    user: 'alt-user',
    workdir: '/somewhere/else',
    container: 'alt-container',
  });
  assert.deepStrictEqual(args, [
    'exec',
    '-u', 'alt-user',
    '-w', '/somewhere/else',
    'alt-container',
    'tmux', 'capture-pane',
  ]);
});

test('omitting workdir skips the -w flag', () => {
  // Defensive: if a future caller explicitly opts out of cwd, builder respects it.
  const args = buildDockerExecArgs(['echo', 'hi'], { workdir: '' });
  assert.strictEqual(args.includes('-w'), false);
});

test('snapshot coalesces concurrent callers into one bd-query bundle', async () => {
  // Regression (ga-312): every SSE client used to drive its own snapshot
  // pipeline, so N tabs × 4 bd queries / poll piled lock pressure on
  // dolt-server and pushed gt-bot's `gt mail send` past its 30s timeout.
  // After coalesce + cache, concurrent snapshot() calls share a single
  // in-flight pipeline (and reuse its result for the rest of the poll
  // window), so the underlying bd-query bundle runs exactly once.
  resetSnapshotCacheForTest();
  let calls = 0;
  setDockerExecForTest(async (argv) => {
    calls++;
    const bin = argv[0];
    if (bin === 'gt') {
      return { code: 0, stdout: JSON.stringify({ name: 'gastown', agents: [], rigs: [] }), stderr: '' };
    }
    if (bin === 'bd') {
      return { code: 0, stdout: JSON.stringify([]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    const results = await Promise.all([snapshot(), snapshot(), snapshot(), snapshot(), snapshot()]);
    // The 4 bd-bundle queries (gt status + bd ready + bd list in_progress +
    // bd list closed) — no pane captures since the stubbed status has no
    // running agents.
    assert.strictEqual(calls, 4, `expected 1 coalesced query bundle (4 dockerExec calls), got ${calls}`);
    // All 5 callers see the SAME snapshot object (object identity, not just shape).
    for (const r of results) assert.strictEqual(r, results[0]);
    // Shape is preserved — auth gate, /, /snapshot.json, and the SSE renderer
    // all rely on this layout.
    assert.ok('status' in results[0] && 'beads' in results[0] && 'panes' in results[0] && 'generated_at' in results[0]);
  } finally {
    setDockerExecForTest(null);
    resetSnapshotCacheForTest();
  }
});

test('static assets are public — /style.css and /app.js bypass auth', async () => {
  // Regression: the page <link>s and <script>s reference these without
  // threading the auth token, so gating them returned 401 to the browser
  // and the operator saw an unstyled page on his phone.
  await withServer(async (port) => {
    const css = await get(port, '/style.css');
    assert.strictEqual(css.status, 200, '/style.css must be reachable without a token');
    assert.match(css.body, /:root|body|font/, 'CSS body should be present');

    const js = await get(port, '/app.js');
    assert.strictEqual(js.status, 200, '/app.js must be reachable without a token');
    assert.match(js.body, /EventSource|applySnapshot|snapshot/, 'JS body should be present');
  });
});

test('healthz stays public', async () => {
  await withServer(async (port) => {
    const r = await get(port, '/healthz');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /ok/);
  });
});

test('live data stays gated — /snapshot.json requires the token', async () => {
  await withServer(async (port) => {
    const noToken = await get(port, '/snapshot.json');
    assert.strictEqual(noToken.status, 401, 'no token must 401');

    const wrongToken = await get(port, '/snapshot.json?token=wrong');
    assert.strictEqual(wrongToken.status, 401, 'wrong token must 401');
  });
});
