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

const { __test } = require('../server');
const { buildDockerExecArgs } = __test;

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
