const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./conversation-harness.cjs');

for (const includeCode of [true, false]) {
  test(`Python questions work without an editor or problem context (includeCode=${includeCode})`, async () => {
    const app = setup();
    app.context.cfg.mode = 'knowledge';
    app.context.cfg.includeCode = includeCode;
    app.context.readProblem = () => { throw Error('Editor unavailable'); };
    const pending = app.send('nums[::-1] 是什么意思？');
    assert.equal(app.requests.length, 1);
    const messages = app.requests[0].payload.messages;
    assert.match(messages[0].content, /Python 3/);
    assert.match(messages[0].content, /预期输出/);
    assert.doesNotMatch(messages[0].content, /只围绕当前这道题|【题目】|【用户当前代码/);
    assert.equal(messages.at(-1).content, 'nums[::-1] 是什么意思？');
    app.requests[0].onDelta('这是反向切片。');
    app.requests[0].resolve();
    await pending;
    assert.equal(app.state().busy, false);
    const reopened = setup(app.saved);
    assert.deepEqual(reopened.state().history.map(m => m.content), ['nums[::-1] 是什么意思？', '这是反向切片。']);
  });
}

test('switching from Python questions to problem modes restores fresh problem context and keeps conversation', async () => {
  const app = setup();
  app.context.cfg.mode = 'knowledge';
  let reads = 0;
  app.context.readProblem = () => {
    reads++;
    return { title: 'Current problem', code: 'CURRENT_EDITOR_CODE', codeSource: 'model', lang: 'python' };
  };
  app.context.readCode = () => ({ code: 'CURRENT_EDITOR_CODE', codeSource: 'model', lang: 'python' });
  const first = app.send('enumerate 怎么用？');
  app.requests[0].onDelta('它可以同时提供索引和值。');
  app.requests[0].resolve();
  await first;
  assert.equal(reads, 0);
  for (const mode of ['hint', 'explain', 'debug']) {
    app.context.cfg.mode = mode;
    const pending = app.send('结合当前代码帮助我');
    const request = app.requests.at(-1);
    assert.match(request.payload.messages[0].content, /Current problem/);
    assert.match(request.payload.messages[0].content, /CURRENT_EDITOR_CODE/);
    assert.equal(request.payload.messages.some(m => m.content === 'enumerate 怎么用？'), true);
    request.resolve();
    await pending;
  }
  assert.equal(reads, 3);
});
