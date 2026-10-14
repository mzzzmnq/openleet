const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../openleet.user.js'), 'utf8');

function setup(saved = null) {
  const events = {}, windowEvents = {}, writes = [];
  let captured = null;
  const handle = {
    addEventListener: (name, fn) => events[name] = fn,
    classList: { add() {}, remove() {} },
    setPointerCapture: id => captured = id,
    hasPointerCapture: id => captured === id,
    releasePointerCapture: () => captured = null,
  };
  const panel = { hidden: false, style: {}, getBoundingClientRect: () => ({ left: 500, top: 100, width: 420, height: 600 }) };
  const window = { innerWidth: 1000, innerHeight: 800, addEventListener: (name, fn) => windowEvents[name] = fn };
  const context = vm.createContext({ window, store: { get: () => saved, set: (key, value) => writes.push({ key, value }) } });
  vm.runInContext(source.slice(source.indexOf('  function setupPanelDrag('), source.indexOf('  const restorePanelPosition =')), context);
  const restore = context.setupPanelDrag(panel, handle);
  const fire = (name, extra = {}) => events[name]({ button: 0, pointerId: 1, clientX: 510, clientY: 110, target: { closest: () => null }, preventDefault() {}, ...extra });
  return { panel, window, windowEvents, restore, fire, writes };
}

test('drag follows pointer, clamps to viewport, and saves at release', () => {
  const h = setup();
  h.fire('pointerdown');
  h.fire('pointermove', { clientX: 200, clientY: 60 });
  assert.equal(h.panel.style.left, '190px');
  assert.equal(h.panel.style.top, '50px');
  h.fire('pointermove', { clientX: 2000, clientY: -30 });
  assert.equal(h.panel.style.left, '580px');
  assert.equal(h.panel.style.top, '0px');
  assert.equal(h.writes.length, 0);
  h.fire('pointerup');
  assert.equal(h.writes[0].value.x, 580);
  h.fire('pointermove', { clientX: 20 });
  assert.equal(h.panel.style.left, '580px');
});

test('header buttons and secondary pointers do not drag; cancellation ends dragging', () => {
  const h = setup();
  h.fire('pointerdown', { target: { closest: () => ({}) } });
  h.fire('pointermove');
  assert.equal(h.panel.style.left, undefined);
  h.fire('pointerdown');
  h.fire('pointermove', { pointerId: 2 });
  assert.equal(h.panel.style.left, undefined);
  h.fire('pointercancel');
  h.fire('pointermove');
  assert.equal(h.panel.style.left, undefined);
});

test('saved position restores within resized viewport and double click resets it', () => {
  const h = setup({ x: 900, y: 700 });
  h.restore();
  assert.equal(h.panel.style.left, '580px');
  h.window.innerWidth = 500;
  h.windowEvents.resize();
  assert.equal(h.panel.style.left, '80px');
  h.fire('dblclick');
  assert.equal(h.panel.style.left, '');
  assert.equal(h.writes.at(-1).value, null);
  const invalid = setup({ x: 'bad', y: 1 });
  invalid.restore();
  assert.equal(invalid.panel.style.left, undefined);
});
