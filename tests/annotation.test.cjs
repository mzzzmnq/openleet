const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./conversation-harness.cjs');

test('annotation sends current code and problem, supports one-click request and refreshes after edits', async () => {
  const app = setup();
  app.context.cfg.mode = 'annotate';
  let code = 'print(1)';
  app.context.readCode = () => ({ code, codeSource: 'model', lang: 'python' });
  for (const next of ['print(1)', 'print(2)']) {
    code = next;
    const pending = app.send('');
    const request = app.requests.at(-1);
    const system = request.payload.messages[0].content;
    assert.match(system, /模式：代码批注/);
    assert.match(system, /Problem/);
    assert.ok(system.includes(next));
    if (next === 'print(2)') assert.ok(!system.includes('print(1)'));
    assert.match(request.payload.messages.at(-1).content, /添加简短注释/);
    request.onDelta('```python\n# 【知识点】输出数值\n' + next + '\n```');
    request.resolve();
    await pending;
  }
  assert.equal(app.requests.length, 2);
  const reopened = setup(app.saved);
  assert.match(reopened.state().history.at(-1).content, /print\(2\)/);
});

test('annotation refuses disabled, empty, partial or oversized code instead of sending misleading context', async () => {
  for (const scenario of [
    { includeCode: false, code: 'print(1)', message: /启用/ },
    { code: '', message: /没有读取到/ },
    { code: 'print(1)', codeIncomplete: true, message: /代码片段/ },
    { code: 'x'.repeat(8001), message: /8,000/ },
  ]) {
    const app = setup();
    app.context.cfg.mode = 'annotate';
    app.context.cfg.includeCode = scenario.includeCode !== false;
    app.context.readCode = () => ({ ...scenario, codeSource: 'model', lang: 'python' });
    await app.send('');
    assert.equal(app.requests.length, 0);
    assert.equal(app.state().busy, false);
    assert.match(app.rendered.at(-1).error, scenario.message);
  }
});
