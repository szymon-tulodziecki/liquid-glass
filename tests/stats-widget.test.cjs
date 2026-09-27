const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {loadModule} = require('./helpers/load-module.cjs');
const root = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist/stats');
const {observeVitals} = loadModule(path.join(root, 'vitalsBridge.js'));
const {StatsHistory} = loadModule(path.join(root, 'chart.js'));

test('Vitals bridge forwards each call once and reuses calculated network rates', () => {
  let calls = 0;
  const output = [];
  const original = function (...args) { calls++; assert.equal(this, values); return args; };
  const values = {returnIfDifferent: original, _networkSpeeds: {rx: {eth0: 10, wlan0: 20}}};
  const detach = observeVitals(values, (...sample) => output.push(sample));
  const args = [5, 'processor', 0.3, 'processor-group', 'percent'];
  assert.deepEqual(values.returnIfDifferent(...args), args);
  values.returnIfDifferent(5, 'eth0', 10000, 'network-rx', 'storage');
  assert.deepEqual(output, [['cpu', 0.3], ['rx', 30]]);
  assert.equal(calls, 2);
  detach();
  assert.equal(values.returnIfDifferent, original);
});

test('bridge cleanup never overwrites another extension wrapper and stops delivery', () => {
  let calls = 0;
  const values = {returnIfDifferent() { return 42; }};
  const detach = observeVitals(values, () => calls++);
  const wrapped = values.returnIfDifferent;
  const other = (...args) => wrapped(...args);
  values.returnIfDifferent = other;
  detach();
  assert.equal(values.returnIfDifferent, other);
  assert.equal(other(1, 'cpu', 0.3, 'processor-group'), 42);
  assert.equal(calls, 0);
  assert.equal(observeVitals(null, () => {}), null);
});

test('history bounds memory, rejects invalid numbers and shows gaps for stale data', () => {
  const history = new StatsHistory();
  history.update('cpu', 0.5, 0);
  history.update('rx', NaN, 0);
  history.update('tx', -1, 0);
  assert.deepEqual(history.sample(1, 5), {cpu: 0.5, rx: null, tx: null});
  assert.deepEqual(history.sample(6, 5), {cpu: null, rx: null, tx: null});
  for (let i = 0; i < 100; i++) history.sample(i, 5);
  assert.equal(history.points.length, 32);
  assert.doesNotMatch(history.svg(), /NaN|Infinity|undefined/);
});

function fixture(enabled = true, existing = null) {
  let serial = 0;
  const timers = new Map(), idles = new Map();
  class Actor {
    constructor() { this.handlers = new Map(); this.children = []; this.mapped = true; }
    connect(name, fn) { const id = ++serial; this.handlers.set(id, {name, fn}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(); }
    get_children() { return this.children; }
    get_parent() { return this.parent; }
    add(child) { child.parent = this; this.children.push(child); this.emit('child-added'); }
  }
  const settings = Object.assign(new Actor(), {enabled, position: -1,
    get_boolean() { return this.enabled; }, get_int() { return this.position; },
    set_int(_, value) { this.position = value; },
    set_boolean(_, value) { this.enabled = value; this.emit('changed::dock-stats-widget'); }});
  const favorites = Object.assign(new Actor(), {ids: ['first.desktop'],
    get_strv(key) { assert.equal(key, 'favorite-apps'); return [...this.ids]; },
    set_strv(key, ids) { assert.equal(key, 'favorite-apps'); this.ids = [...ids]; this.emit('changed::favorite-apps'); },
    removeFavorite(id) { this.set_strv('favorite-apps', this.ids.filter(item => item !== id)); }});
  const apps = Object.assign(new Actor(), {lookup_app: () => ({})});
  const source = {returnIfDifferent() { return []; }};
  const originalSource = source.returnIfDifferent;
  const extensionManager = new Actor();
  const statusArea = {vitalsMenu: {_values: source, _settings: {get_int: () => 5}}};
  let encoded = 0;
  let launcher = existing, writes = 0;
  const {DockStatsWidget} = loadModule(path.join(root, 'dockWidget.js'), {
    GLib: {build_filenamev: xs => xs.join('/'), get_user_data_dir: () => '/fake',
      path_get_dirname: () => '/fake/applications', mkdir_with_parents() {},
      timeout_add_seconds(_, seconds, fn) { assert.equal(seconds, 1); const id = ++serial; timers.set(id, fn); return id; },
      idle_add(_, fn) { const id = ++serial; idles.set(id, fn); return id; },
      source_remove(id) { timers.delete(id); idles.delete(id); },
      get_monotonic_time: () => 1000000, Bytes: class { constructor(bytes) { this.bytes = bytes; } }},
    Gio: {FileCreateFlags: {REPLACE_DESTINATION: 1}, File: {new_for_path: () => ({query_exists: () => launcher !== null,
      load_contents: () => [true, new TextEncoder().encode(launcher)],
      delete() { launcher = null; },
      replace_contents(bytes) { writes++; launcher = new TextDecoder().decode(bytes); }})},
      BytesIcon: {new: bytes => { encoded++; return bytes; }}},
    Shell: {AppSystem: {get_default: () => apps}}, Main: {extensionManager, panel: {statusArea}},
    global: {settings: favorites},
  });
  const manager = new DockStatsWidget(settings);
  const dock = new Actor(), box = new Actor();
  dock._box = box; dock._createAppItem = () => {}; dock.add(box);
  function addIcon() {
    const item = new Actor(), bin = new Actor(), icon = new Actor();
    icon.gicon = 'original'; bin.add(icon); item.add(bin);
    item._delegate = {app: {get_id: () => 'liquid-glass-vitals-widget.desktop'}, icon: {icon}};
    box.add(item);
    return {icon, bin, item};
  }
  manager.setup();
  const entry = addIcon();
  manager.syncDocks([dock]);
  const flush = () => { for (const [id, fn] of [...idles]) { idles.delete(id); fn(); } };
  return {manager, settings, favorites, source, originalSource, timers, idles, entry, addIcon, dock, box, apps,
    statusArea, extensionManager, encoded: () => encoded, launcher: () => launcher, writes: () => writes, flush, Actor};
}

test('generated launcher is eligible for GNOME favorites rather than hidden by NoDisplay', () => {
  const f = fixture(true);
  assert.match(f.launcher(), /Type=Application/);
  assert.doesNotMatch(f.launcher(), /(?:NoDisplay|Hidden)=true/);
  f.manager.cleanup();
});

test('a launcher left hidden by an earlier version is rewritten, a current one is left alone', () => {
  const stale = fixture(true, '[Desktop Entry]\nType=Application\nNoDisplay=true\n');
  assert.equal(stale.writes(), 1);
  assert.doesNotMatch(stale.launcher(), /NoDisplay=true/);
  const current = fixture(true, stale.launcher());
  assert.equal(current.writes(), 0);
  stale.manager.cleanup();
  current.manager.cleanup();
});

test('disabled widget owns no timer, source hook, icon mutation or favorite', () => {
  const f = fixture(false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.source.returnIfDifferent, f.originalSource);
  assert.equal(f.entry.icon.gicon, 'original');
  assert.deepEqual(f.favorites.ids, ['first.desktop']);
  f.manager.cleanup();
});

test('widget shares one timer, preserves native drag delegate and restores everything on cleanup', () => {
  const f = fixture();
  const delegate = f.entry.item._delegate;
  const other = f.addIcon(); f.flush();
  f.source.returnIfDifferent(5, 'processor', 0.2, 'processor-group');
  for (const tick of f.timers.values()) tick();
  assert.equal(f.timers.size, 1);
  assert.equal(f.encoded(), 1);
  assert.equal(f.entry.icon.gicon, other.icon.gicon);
  assert.equal(f.entry.item._delegate, delegate);
  f.manager.cleanup();
  assert.equal(f.entry.icon.gicon, 'original');
  assert.equal(f.source.returnIfDifferent, f.originalSource);
  assert.equal(f.timers.size, 0);
  assert.equal(f.box.handlers.size, 0);
  assert.equal(f.entry.bin.handlers.size, 0);
  assert.equal(f.extensionManager.handlers.size, 0);
  f.manager.cleanup();
});

test('hidden docks do not render graphs, and disabling remembers the favorite position', () => {
  const f = fixture();
  f.entry.icon.mapped = false;
  for (const tick of f.timers.values()) tick();
  assert.equal(f.encoded(), 0);
  f.settings.enabled = false; f.settings.emit('changed::dock-stats-widget');
  assert.equal(f.settings.position, 1);
  assert.deepEqual(f.favorites.ids, ['first.desktop']);
  assert.equal(f.timers.size, 0);
  f.settings.enabled = true; f.settings.emit('changed::dock-stats-widget');
  assert.equal(f.favorites.ids[1], 'liquid-glass-vitals-widget.desktop');
  f.manager.cleanup();
});

test('unpinning from the dock turns the widget off, so a later enable does not repin it', () => {
  const f = fixture();
  f.favorites.removeFavorite('liquid-glass-vitals-widget.desktop');
  assert.equal(f.settings.enabled, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.launcher(), null, 'the launcher is removed with the widget');
  f.apps.emit('installed-changed');
  f.manager.cleanup();
  const again = fixture(false);
  again.manager.cleanup();
  assert.deepEqual(f.favorites.ids, ['first.desktop']);
});

test('undoing an unpin turns the widget back on', () => {
  const f = fixture();
  f.favorites.removeFavorite('liquid-glass-vitals-widget.desktop');
  f.favorites.set_strv('favorite-apps', [...f.favorites.ids, 'liquid-glass-vitals-widget.desktop']);
  assert.equal(f.settings.enabled, true);
  assert.equal(f.timers.size, 1);
  f.manager.cleanup();
});

test('pinning keeps favorites whose launcher is currently missing', () => {
  const f = fixture(false);
  f.favorites.ids = ['first.desktop', 'not-installed-yet.desktop'];
  f.settings.enabled = true; f.settings.emit('changed::dock-stats-widget');
  assert.deepEqual(f.favorites.ids, ['first.desktop', 'not-installed-yet.desktop', 'liquid-glass-vitals-widget.desktop']);
  f.manager.cleanup();
});

test('hidden docks keep sampling so the history shows the gap, and a destroyed dock is forgotten', () => {
  const f = fixture();
  f.entry.icon.mapped = false;
  for (let i = 0; i < 3; i++) for (const tick of f.timers.values()) tick();
  assert.equal(f.encoded(), 0);
  f.dock.emit('destroy');
  f.box.emit('child-removed');
  f.dock.get_children = () => { throw new Error('disposed'); };
  f.flush();
  assert.equal(f.manager.docks.includes(f.dock), false);
  f.manager.cleanup();
});

test('recreated icons and a restarted Vitals reconnect without accumulating hooks', () => {
  const f = fixture();
  const old = f.entry.icon;
  const icon = new f.Actor(); icon.gicon = 'new-original';
  f.entry.bin.children = [];
  f.entry.bin.add(icon);
  f.entry.item._delegate.icon.icon = icon;
  old.emit('destroy'); f.flush();
  const source = {returnIfDifferent() { return []; }};
  const original = source.returnIfDifferent;
  f.statusArea.vitalsMenu._values = source;
  f.extensionManager.emit('extension-state-changed');
  assert.equal(f.source.returnIfDifferent, f.originalSource);
  assert.notEqual(source.returnIfDifferent, original);
  for (const tick of f.timers.values()) tick();
  assert.notEqual(icon.gicon, 'new-original');
  f.manager.cleanup();
  assert.equal(icon.gicon, 'new-original');
  assert.equal(source.returnIfDifferent, original);
});

test('detaching from a prototype method leaves no own property behind', () => {
  class Values { returnIfDifferent() { return 'proto'; } }
  const values = new Values();
  const detach = observeVitals(values, () => {});
  assert.equal(Object.hasOwn(values, 'returnIfDifferent'), true);
  detach();
  assert.equal(Object.hasOwn(values, 'returnIfDifferent'), false);
  Values.prototype.returnIfDifferent = () => 'patched';
  assert.equal(values.returnIfDifferent(), 'patched');
});
