import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {StatsHistory} from './chart.js';
import {observeVitals} from './vitalsBridge.js';

const APP_ID = 'liquid-glass-vitals-widget.desktop';
const LAUNCHER = '[Desktop Entry]\nType=Application\nName=Vitals — CPU / Network\nExec=gnome-extensions prefs Vitals@CoreCoding.com\nIcon=utilities-system-monitor\nTerminal=false\n';

export class DockStatsWidget {
  private settings: Gio.Settings;
  private signals: [any, number][] = [];
  private docks: any[] = [];
  private boxes = new Map<any, number[]>();
  private icons = new Map<any, {gicon: any; name: string | null; destroyId: number}>();
  private history = new StatsHistory();
  private detach: (() => void) | null = null;
  private values: any = null;
  private timer = 0;
  private idle = 0;
  private waitingForApp = false;
  private pinned = false;
  private dockDestroyIds = new Map<any, number>();

  constructor(settings: Gio.Settings) { this.settings = settings; }

  setup() {
    this.signals.push([this.settings, this.settings.connect('changed::dock-stats-widget', () => this.refresh())]);
    this.signals.push([Main.extensionManager, Main.extensionManager.connect('extension-state-changed', () => {
      this.refreshSource();
      return false;
    })]);
    const apps = Shell.AppSystem.get_default();
    this.signals.push([apps, apps.connect('installed-changed', () => { this.pin(); return false; })]);
    this.pinned = this.favorites().includes(APP_ID);
    this.signals.push([global.settings, global.settings.connect('changed::favorite-apps', () => this.followFavorites())]);
    this.refresh();
  }

  syncDocks(docks: any[]) {
    for (const [dock, id] of this.dockDestroyIds) {
      if (docks.includes(dock)) continue;
      try { dock.disconnect(id); } catch { }
      this.dockDestroyIds.delete(dock);
    }
    for (const dock of docks) {
      if (this.dockDestroyIds.has(dock)) continue;
      this.dockDestroyIds.set(dock, dock.connect('destroy', () => {
        this.dockDestroyIds.delete(dock);
        this.docks = this.docks.filter(item => item !== dock);
      }));
    }
    this.docks = docks;
    this.rescan();
  }

  private favorites(): string[] {
    return global.settings.get_strv('favorite-apps');
  }

  private followFavorites() {
    const pinned = this.favorites().includes(APP_ID);
    const wasPinned = this.pinned;
    this.pinned = pinned;
    if (pinned === wasPinned || pinned === this.settings.get_boolean('dock-stats-widget')) return;
    this.settings.set_boolean('dock-stats-widget', pinned);
  }

  private refresh() {
    if (!this.settings.get_boolean('dock-stats-widget')) {
      this.stop();
      const favorites = this.favorites();
      const index = favorites.indexOf(APP_ID);
      if (index >= 0) {
        this.settings.set_int('dock-stats-position', index);
        favorites.splice(index, 1);
        this.pinned = false;
        global.settings.set_strv('favorite-apps', favorites);
      }
      this.removeLauncher();
      return;
    }
    this.ensureLauncher();
    this.waitingForApp = true;
    this.pin();
    this.refreshSource();
    this.rescan();
    if (!this.timer) this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
      this.tick();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private launcherPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'applications', APP_ID]);
  }

  private removeLauncher() {
    try { Gio.File.new_for_path(this.launcherPath()).delete(null); } catch { }
  }

  private ensureLauncher() {
    const path = this.launcherPath();
    const file = Gio.File.new_for_path(path);
    if (file.query_exists(null)) {
      const [, contents] = file.load_contents(null);
      if (new TextDecoder().decode(contents) === LAUNCHER) return;
    } else {
      GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    }
    file.replace_contents(new TextEncoder().encode(LAUNCHER), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  }

  private pin() {
    if (!this.waitingForApp || !this.settings.get_boolean('dock-stats-widget')) return;
    if (!Shell.AppSystem.get_default().lookup_app(APP_ID)) return;
    this.waitingForApp = false;
    const favorites = this.favorites();
    if (favorites.includes(APP_ID)) return;
    const position = this.settings.get_int('dock-stats-position');
    favorites.splice(position < 0 || position > favorites.length ? favorites.length : position, 0, APP_ID);
    this.pinned = true;
    global.settings.set_strv('favorite-apps', favorites);
  }

  private refreshSource() {
    const next = this.settings.get_boolean('dock-stats-widget') ? (Main.panel.statusArea as any).vitalsMenu?._values : null;
    if (next === this.values) return;
    this.detach?.();
    this.values = next;
    this.history = new StatsHistory();
    this.detach = observeVitals(next, (metric, value) => this.history.update(metric, value, GLib.get_monotonic_time() / 1e6));
  }

  private scheduleRescan() {
    if (this.idle) return;
    this.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.idle = 0;
      this.rescan();
      return GLib.SOURCE_REMOVE;
    });
  }

  private rescan() {
    if (!this.settings.get_boolean('dock-stats-widget')) return;
    const seen = new Set<any>();
    const seenIcons = new Set<any>();
    const watch = box => {
      seen.add(box);
      if (!this.boxes.has(box)) this.boxes.set(box, [
        box.connect('child-added', () => this.scheduleRescan()),
        box.connect('child-removed', () => this.scheduleRescan()),
        box.connect('destroy', () => { this.boxes.delete(box); }),
      ]);
    };
    const visit = actor => {
      if (actor._box && typeof actor._createAppItem === 'function') watch(actor._box);
      const delegate = actor._delegate;
      if (delegate?.app?.get_id() === APP_ID && delegate.icon?.icon) {
        const icon = delegate.icon.icon;
        if (icon.get_parent()) watch(icon.get_parent());
        seenIcons.add(icon);
        this.trackIcon(icon);
      }
      for (const child of actor.get_children()) visit(child);
    };
    for (const dock of this.docks) visit(dock);
    for (const [box, ids] of this.boxes) {
      if (seen.has(box)) continue;
      for (const id of ids) box.disconnect(id);
      this.boxes.delete(box);
    }
    for (const icon of this.icons.keys()) if (!seenIcons.has(icon)) this.releaseIcon(icon);
  }

  private trackIcon(icon: any) {
    if (this.icons.has(icon)) return;
    this.icons.set(icon, {gicon: icon.gicon, name: icon.icon_name,
      destroyId: icon.connect('destroy', () => this.icons.delete(icon))});
  }

  private tick() {
    this.refreshSource();
    const vitals = (Main.panel.statusArea as any).vitalsMenu;
    const interval = vitals?._settings?.get_int('update-time') ?? 5;
    this.history.sample(GLib.get_monotonic_time() / 1e6, Math.max(5, interval * 3));
    if (![...this.icons.keys()].some(icon => icon.mapped)) return;
    const icon = Gio.BytesIcon.new(new GLib.Bytes(new TextEncoder().encode(this.history.svg())));
    for (const target of this.icons.keys()) if (target.mapped) target.gicon = icon;
  }

  private stop() {
    if (this.timer) GLib.source_remove(this.timer);
    if (this.idle) GLib.source_remove(this.idle);
    this.timer = this.idle = 0;
    this.waitingForApp = false;
    this.detach?.();
    this.detach = null;
    this.values = null;
    this.history = new StatsHistory();
    for (const [box, ids] of this.boxes) for (const id of ids) box.disconnect(id);
    this.boxes.clear();
    for (const icon of this.icons.keys()) this.releaseIcon(icon);
  }

  private releaseIcon(icon: any) {
    const original = this.icons.get(icon)!;
    this.icons.delete(icon);
    icon.disconnect(original.destroyId);
    if (original.gicon) icon.gicon = original.gicon;
    else icon.icon_name = original.name;
  }

  cleanup() {
    this.stop();
    for (const [object, id] of this.signals.splice(0)) {
      try { object.disconnect(id); } catch { }
    }
    for (const [dock, id] of this.dockDestroyIds) {
      try { dock.disconnect(id); } catch { }
    }
    this.dockDestroyIds.clear();
    this.docks = [];
  }
}
