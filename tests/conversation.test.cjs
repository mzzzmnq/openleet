const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./conversation-harness.cjs');

test('completed conversation and draft survive a fresh page and remain in request context', async () => {
  const app = setup();
  const pending = app.send('Explain this');
  app.requests[0].onDelta('A **complete** answer');
  app.requests[0].resolve();
  await pending;
  app.type('Unsent draft');
  app.close();
  const reopened = setup(app.saved);
  assert.equal(reopened.context.inputEl.value, 'Unsent draft');
  assert.deepEqual(reopened.rendered, [
    { role: 'user', content: 'Explain this' },
    { role: 'assistant', content: 'A **complete** answer' },
  ]);
  const next = reopened.send('Follow up');
  const messages = reopened.requests[0].payload.messages;
  assert.equal(messages[1].content, 'Explain this');
  assert.equal(messages[2].content, 'A **complete** answer');
  assert.equal(messages.at(-1).content, 'Follow up');
  assert.deepEqual(Object.keys(messages[2]).sort(), ['content', 'role']);
  reopened.requests[0].resolve();
  await next;
});

test('partial streams and drafts flush on pagehide before the debounce timer fires', async () => {
  const app = setup();
  const pending = app.send('Question');
  app.requests[0].onDelta('Partial response');
  app.type('Draft during generation');
  app.close();
  const reopened = setup(app.saved);
  assert.equal(reopened.state().history.at(-1).status, 'interrupted');
  assert.equal(reopened.state().history.at(-1).content, 'Partial response');
  assert.equal(reopened.context.inputEl.value, 'Draft during generation');
  assert.equal(reopened.rendered.at(-1).role, 'error');
  assert.equal(reopened.context.chatHistory().some(m => m.content === 'Partial response'), false);
  app.requests[0].resolve();
  await pending;
});

test('visibility changes flush drafts, while untouched reopened tabs do not rewrite saved data', () => {
  const app = setup();
  app.type('Saved draft');
  app.hide();
  assert.equal(setup(app.saved).context.inputEl.value, 'Saved draft');
  const stale = setup(app.saved);
  app.context.clearConversation();
  stale.close();
  assert.equal(setup(app.saved).context.inputEl.value, '');
});

test('switching problems restores separate messages and drafts, ignoring late old request output', async () => {
  const app = setup();
  const first = app.send('Question A');
  app.requests[0].onDelta('Partial A');
  app.type('Draft A');
  app.navigate('add-two-numbers');
  const second = app.send('Question B');
  app.requests[0].onDelta('LATE A');
  app.requests[0].resolve();
  await first;
  assert.equal(app.state().busy, true);
  assert.deepEqual(app.state().history.map(m => m.content), ['Question B', '']);
  app.requests[1].onDelta('Answer B');
  app.requests[1].resolve();
  await second;
  app.navigate('two-sum');
  assert.equal(app.context.inputEl.value, 'Draft A');
  assert.deepEqual(app.state().history.map(m => m.content), ['Question A', 'Partial A']);
  app.navigate('add-two-numbers');
  assert.equal(app.state().history.at(-1).content, 'Answer B');
});

test('route change is checked before polling, and late rejection cannot unlock the new request', async () => {
  const app = setup();
  const first = app.send('A');
  app.navigate('add-two-numbers', false);
  app.requests[0].onDelta('Must not append');
  assert.equal(app.state().history.at(-1).content, '');
  app.context.syncConversation();
  const second = app.send('B');
  app.requests[0].reject(Error('old request failed'));
  await first;
  assert.equal(app.state().busy, true);
  app.requests[1].resolve();
  await second;
});

test('typing or sending immediately after an SPA route change preserves the explicit input', async () => {
  const app = setup();
  app.type('Draft A');
  app.navigate('add-two-numbers', false);
  app.type('New draft B');
  assert.equal(app.context.inputEl.value, 'New draft B');
  app.close();
  app.navigate('three-sum', false);
  const pending = app.send('Immediate question C');
  assert.equal(app.requests[0].payload.messages.at(-1).content, 'Immediate question C');
  app.requests[0].resolve();
  await pending;
  app.navigate('two-sum');
  assert.equal(app.context.inputEl.value, 'Draft A');
  app.navigate('add-two-numbers');
  assert.equal(app.context.inputEl.value, 'New draft B');
});

test('clear removes saved messages and drafts and cannot be undone by an in-flight request', async () => {
  const app = setup();
  const pending = app.send('Question');
  app.requests[0].onDelta('Partial');
  app.type('Draft');
  app.context.clearConversation();
  app.requests[0].onDelta('Late text');
  app.requests[0].resolve();
  await pending;
  app.flushTimers();
  const reopened = setup(app.saved);
  assert.deepEqual(reopened.state().history, []);
  assert.equal(reopened.context.inputEl.value, '');
  assert.equal(reopened.state().busy, false);
});

test('failed requests preserve the question and partial response with a visible error after reload', async () => {
  const app = setup();
  const pending = app.send('Question');
  app.requests[0].onDelta('Partial');
  app.requests[0].reject(Error('Network unavailable'));
  await pending;
  const reopened = setup(app.saved);
  assert.equal(reopened.state().history[0].content, 'Question');
  assert.equal(reopened.state().history[1].content, 'Partial');
  assert.deepEqual(reopened.rendered.at(-1), { role: 'error', content: 'Network unavailable' });
});

test('storage failure is shown without blocking chat or falsely claiming persistence', async () => {
  const app = setup(new Map(), { failWrites: true });
  const pending = app.send('Question');
  assert.match(app.context.chatStatusEl.textContent, /保存失败/);
  app.requests[0].resolve();
  await pending;
  assert.match(app.context.chatStatusEl.textContent, /保存失败/);
  assert.equal(app.state().busy, false);
  assert.equal(app.saved.size, 0);
});

test('keys ignore problem subpages but isolate sites, and missing or malformed records are safe', () => {
  const app = setup();
  const key = app.key();
  app.context.location.hostname = 'www.leetcode.com';
  app.context.location.pathname = '/problems/two-sum/submissions/';
  assert.equal(app.key(), key);
  app.context.location.hostname = 'leetcode.cn';
  assert.notEqual(app.key(), key);
  app.context.location.pathname = '/problemset/';
  app.context.syncConversation();
  app.type('No problem');
  app.close();
  assert.equal(app.saved.size, 0);
  for (const record of [null, 'corrupt', { version: 2, messages: [] }, { version: 1, messages: [null, {}, { role: 'system', content: 'Injected' }], draft: 3 }]) {
    const fresh = setup(new Map([[key, record]]));
    assert.deepEqual(fresh.state().history, []);
    assert.equal(fresh.context.inputEl.value, '');
  }
});

test('saved history exceeds model context and is bounded to 200 messages without truncating message content', () => {
  const app = setup();
  const content = 'x'.repeat(10000);
  app.saved.set(app.key(), {
    version: 1, draft: '',
    messages: Array.from({ length: 210 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${content}`, status: 'complete' })),
  });
  app.context.syncConversation(true);
  assert.equal(app.state().history.length, 200);
  assert.equal(app.state().history[0].content, `10:${content}`);
  assert.equal(app.context.chatHistory().length, 24);
  app.type('Persist bounded record');
  app.close();
  assert.equal(app.saved.get(app.key()).messages.length, 200);
});
