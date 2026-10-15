const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../openleet.user.js'), 'utf8');

function setup(fontSize) {
  const controls = {}, styles = {};
  let saved;
  const context = vm.createContext({
    cfg: { fontSize },
    panel: { style: { setProperty: (key, value) => styles[key] = value } },
    $: name => controls[name] ||= { addEventListener: (_, fn) => controls[name].click = fn },
    saveCfg: () => saved = context.cfg.fontSize,
  });
  vm.runInContext(source.slice(source.indexOf('  function applyFontSize('), source.indexOf('  /* -------------------------------------------------------- panel position */')), context);
  return { controls, styles, saved: () => saved, context };
}

test('font controls apply immediately, persist changes, and restore on a fresh page', () => {
  const first = setup(undefined);
  assert.equal(first.styles['--ocleet-font-size'], '14px');
  first.controls['font-increase'].click();
  assert.equal(first.saved(), 15);
  assert.equal(first.styles['--ocleet-font-size'], '15px');
  const restored = setup(first.saved());
  assert.equal(restored.controls['font-size'].textContent, 15);
  restored.controls['font-decrease'].click();
  assert.equal(restored.saved(), 14);
});

test('font settings normalize malformed values and prevent unreadable or oversized values', () => {
  for (const invalid of [undefined, null, '', 'bad', Infinity]) assert.equal(setup(invalid).context.cfg.fontSize, 14);
  const low = setup(3), high = setup(100);
  assert.equal(low.context.cfg.fontSize, 12);
  assert.equal(low.controls['font-decrease'].disabled, true);
  assert.equal(high.context.cfg.fontSize, 22);
  assert.equal(high.controls['font-increase'].disabled, true);
});
