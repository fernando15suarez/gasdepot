// Tests for the pane auto-scroll helpers in public/app.js.
//
// We deliberately avoid JSDOM (the dashboard package has zero non-prod deps —
// see ga-acv hard constraint). The helpers only touch scrollTop / scrollHeight
// / clientHeight, so a plain object stands in for an HTMLPreElement.

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldStickToBottom, stickPaneToBottom } = require('../public/app');

function makePane({ scrollTop, scrollHeight, clientHeight }) {
  return { scrollTop, scrollHeight, clientHeight };
}

test('shouldStickToBottom: true when scrolled to the bottom', () => {
  // 600px content, 200px viewport, scrolled to 400 → at-bottom.
  const pane = makePane({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 });
  assert.strictEqual(shouldStickToBottom(pane), true);
});

test('shouldStickToBottom: true within the 24px slop window', () => {
  // 23px from the bottom still counts — sub-pixel/border math.
  const pane = makePane({ scrollTop: 377, scrollHeight: 600, clientHeight: 200 });
  assert.strictEqual(shouldStickToBottom(pane), true);
});

test('shouldStickToBottom: false when the user has scrolled up', () => {
  // 200px from the bottom — operator is reading older output.
  const pane = makePane({ scrollTop: 200, scrollHeight: 600, clientHeight: 200 });
  assert.strictEqual(shouldStickToBottom(pane), false);
});

test('stickPaneToBottom parks scrollTop at scrollHeight', () => {
  const pane = makePane({ scrollTop: 0, scrollHeight: 600, clientHeight: 200 });
  stickPaneToBottom(pane);
  assert.strictEqual(pane.scrollTop, 600);
});

test('SSE update path: sticks to bottom when prior position was at bottom', () => {
  // Simulate the applySnapshot flow: read stickiness, swap content (scrollHeight
  // grows), conditionally re-stick.
  const pane = makePane({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 });
  const sticky = shouldStickToBottom(pane);
  // textContent assignment grows the buffer:
  pane.scrollHeight = 800;
  if (sticky) stickPaneToBottom(pane);
  assert.strictEqual(sticky, true);
  assert.strictEqual(pane.scrollTop, 800, 'should re-park at the new bottom');
});

test('SSE update path: leaves scrollTop alone when user scrolled up', () => {
  const pane = makePane({ scrollTop: 100, scrollHeight: 600, clientHeight: 200 });
  const sticky = shouldStickToBottom(pane);
  pane.scrollHeight = 800;
  if (sticky) stickPaneToBottom(pane);
  assert.strictEqual(sticky, false);
  assert.strictEqual(pane.scrollTop, 100, 'must not yank the operator down');
});
