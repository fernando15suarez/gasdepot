// Asserts gtEnv() strips git env vars injected by Claude Code agent shells
// (GIT_CEILING_DIRECTORIES & friends) so they don't leak into `gt` / `git`
// subprocesses and break `git config` lookups inside `gt mail send`.

const test = require("node:test");
const assert = require("node:assert/strict");

// Pin GT_TOWN_ROOT to a real dir before requiring bot.js so gtEnv.cwd
// resolves cleanly. Must happen before the require.
process.env.GT_TOWN_ROOT = "/tmp";

const { __test } = require("../bot");
const { gtEnv, STRIPPED_GIT_VARS } = __test;

// Snapshot + restore process.env between cases so injected vars from one
// test don't bleed into the next (or back into the host shell).
function withEnv(overrides, fn) {
  const snapshot = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  }
}

test("gtEnv: strips every injected GIT_* var from forwarded env", () => {
  const injected = Object.fromEntries(STRIPPED_GIT_VARS.map((k) => [k, "leaked"]));
  withEnv(injected, () => {
    const { env } = gtEnv();
    for (const name of STRIPPED_GIT_VARS) {
      assert.equal(env[name], undefined, `${name} should be stripped from gt subprocess env`);
    }
  });
});

test("gtEnv: preserves GT_TOWN_ROOT, PATH, and arbitrary user-set vars", () => {
  withEnv({
    GT_TOWN_ROOT: "/tmp",
    PATH: "/usr/local/bin:/usr/bin",
    GIT_CEILING_DIRECTORIES: "/should/be/dropped",
    MY_CUSTOM_VAR: "keep-me",
  }, () => {
    const { env, cwd } = gtEnv();
    assert.equal(env.GT_TOWN_ROOT, "/tmp");
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.MY_CUSTOM_VAR, "keep-me");
    assert.equal(env.GIT_CEILING_DIRECTORIES, undefined);
    assert.equal(cwd, "/tmp");
  });
});

test("gtEnv: extras override forwarded env without re-introducing stripped vars", () => {
  withEnv({ GIT_CEILING_DIRECTORIES: "/leaked" }, () => {
    const { env } = gtEnv({ FOO: "bar" });
    assert.equal(env.FOO, "bar");
    assert.equal(env.GIT_CEILING_DIRECTORIES, undefined);
  });
});

test("gtEnv: STRIPPED_GIT_VARS covers the documented Claude-Code-injected set", () => {
  // Lock the list so silent removals show up as test failures. Update both
  // here and in bot.js together when adding/removing vars.
  assert.deepEqual([...STRIPPED_GIT_VARS].sort(), [
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_DIR",
    "GIT_EDITOR",
    "GIT_WORK_TREE",
  ]);
});
