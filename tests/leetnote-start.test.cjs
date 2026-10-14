const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../openleet.user.js'), 'utf8');
function setup(extra = {}) {
  const requests = [], notes = [], button = {}, links = [];
  const context = vm.createContext({
    IS_DEMO: false, $: () => button, leetnoteBase: () => 'http://127.0.0.1:8080',
    addMessage: (_, text) => { const note = { textContent: text }; notes.push(note); return note; },
    GM_xmlhttpRequest: request => { requests.push(request); request.onload({ status: 200, responseText: JSON.stringify({ service: request.url.includes(':8000') ? 'leetnote-ai' : 'leetnote-api', database: 'ok' }) }); },
    document: { body: { appendChild() {} }, createElement: () => { const link = { click() { links.push(this.href); }, remove() {} }; return link; } },
    setTimeout: fn => fn(), ...extra,
  });
  vm.runInContext(source.slice(source.indexOf('  async function probeLeetNoteServices('), source.indexOf('  const DIFFICULTY_MAP')), context);
  return { context, requests, notes, button, links };
}
test('start uses fixed local protocol, checks three services, and does not import automatically', async () => {
  const h = setup();
  await h.context.startLeetNote();
  assert.deepEqual(h.links, ['openleet-leetnote://start']);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(r => r.method === 'GET' && !r.headers));
  assert.match(h.notes[0].textContent, /已就绪/);
  assert.equal(h.button.disabled, false);
});
test('demo and remote configurations never launch local processes', async () => {
  for (const extra of [{ IS_DEMO: true }, { leetnoteBase: () => 'https://notes.example.com' }]) {
    const h = setup(extra);
    await h.context.startLeetNote();
    assert.equal(h.links.length, 0);
    assert.equal(h.requests.length, 0);
  }
});
test('unrelated API response, network errors and timeouts are not ready', async () => {
  let index = 0;
  const h = setup({ GM_xmlhttpRequest: request => {
    if (index++ === 0) request.onload({ status: 200, responseText: '{}' });
    else if (index === 2) request.onerror();
    else request.ontimeout();
  } });
  assert.ok((await h.context.probeLeetNoteServices()).every(s => !s.ready));
});
