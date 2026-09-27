import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import { StatsHistory } from './chart.js';
import { observeVitals } from './vitalsBridge.js';
const APP_ID = 'liquid-glass-vitals-widget.desktop';
const LAUNCHER = '[Desktop Entry]\nType=Application\nName=Vitals — CPU / Network\nExec=gnome-extensions prefs Vitals@CoreCoding.com\nIcon=utilities-system-monitor\nNoDisplay=true\nTerminal=false\n';
export class DockStatsWidget {
    settings;
    signals = [];
    docks = [];
    boxes = new Map();
    icons = new Map();
    history = new StatsHistory();
    detach = null;
    values = null;
    timer = 0;
    idle = 0;
    waitingForApp = false;
    constructor(settings) { this.settings = settings; }
    setup() {
        this.signals.push([this.settings, this.settings.connect('changed::dock-stats-widget', () => this.refresh())]);
        this.signals.push([Main.extensionManager, Main.extensionManager.connect('extension-state-changed', () => {
                this.refreshSource();
                return false;
            })]);
        const apps = Shell.AppSystem.get_default();
        this.signals.push([apps, apps.connect('installed-changed', () => { this.pin(); return false; })]);
        this.refresh();
    }
    syncDocks(docks) {
        this.docks = docks;
        this.rescan();
    }
    refresh() {
        if (!this.settings.get_boolean('dock-stats-widget')) {
            this.stop();
            const favorites = AppFavorites.getAppFavorites();
            const index = favorites.getFavorites().findIndex(app => app.get_id() === APP_ID);
            if (index >= 0) {
                this.settings.set_int('dock-stats-position', index);
                favorites.removeFavorite(APP_ID);
            }
            return;
        }
        const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications', APP_ID]);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            const stream = file.create(Gio.FileCreateFlags.NONE, null);
            try {
                stream.write_all(new TextEncoder().encode(LAUNCHER), null);
            }
            finally {
                stream.close(null);
            }
        }
        this.waitingForApp = true;
        this.pin();
        this.refreshSource();
        this.rescan();
        if (!this.timer)
            this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this.tick();
                return GLib.SOURCE_CONTINUE;
            });
    }
    pin() {
        if (!this.waitingForApp || !this.settings.get_boolean('dock-stats-widget'))
            return;
        if (!Shell.AppSystem.get_default().lookup_app(APP_ID))
            return;
        this.waitingForApp = false;
        const favorites = AppFavorites.getAppFavorites();
        if (!favorites.isFavorite(APP_ID))
            favorites.addFavoriteAtPos(APP_ID, this.settings.get_int('dock-stats-position'));
    }
    refreshSource() {
        const next = this.settings.get_boolean('dock-stats-widget') ? Main.panel.statusArea.vitalsMenu?._values : null;
        if (next === this.values)
            return;
        this.detach?.();
        this.values = next;
        this.history = new StatsHistory();
        this.detach = observeVitals(next, (metric, value) => this.history.update(metric, value, GLib.get_monotonic_time() / 1e6));
    }
    scheduleRescan() {
        if (this.idle)
            return;
        this.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.idle = 0;
            this.rescan();
            return GLib.SOURCE_REMOVE;
        });
    }
    rescan() {
        if (!this.settings.get_boolean('dock-stats-widget'))
            return;
        const seen = new Set();
        const seenIcons = new Set();
        const watch = box => {
            seen.add(box);
            if (!this.boxes.has(box))
                this.boxes.set(box, [
                    box.connect('child-added', () => this.scheduleRescan()),
                    box.connect('child-removed', () => this.scheduleRescan()),
                    box.connect('destroy', () => { this.boxes.delete(box); }),
                ]);
        };
        const visit = actor => {
            if (actor._box && typeof actor._createAppItem === 'function')
                watch(actor._box);
            const delegate = actor._delegate;
            if (delegate?.app?.get_id() === APP_ID && delegate.icon?.icon) {
                const icon = delegate.icon.icon;
                if (icon.get_parent())
                    watch(icon.get_parent());
                seenIcons.add(icon);
                this.trackIcon(icon);
            }
            for (const child of actor.get_children())
                visit(child);
        };
        for (const dock of this.docks)
            visit(dock);
        for (const [box, ids] of this.boxes) {
            if (seen.has(box))
                continue;
            for (const id of ids)
                box.disconnect(id);
            this.boxes.delete(box);
        }
        for (const icon of this.icons.keys())
            if (!seenIcons.has(icon))
                this.releaseIcon(icon);
    }
    trackIcon(icon) {
        if (this.icons.has(icon))
            return;
        this.icons.set(icon, { gicon: icon.gicon, name: icon.icon_name,
            destroyId: icon.connect('destroy', () => this.icons.delete(icon)) });
    }
    tick() {
        if (![...this.icons.keys()].some(icon => icon.mapped))
            return;
        this.refreshSource();
        const vitals = Main.panel.statusArea.vitalsMenu;
        const interval = vitals?._settings?.get_int('update-time') ?? 5;
        this.history.sample(GLib.get_monotonic_time() / 1e6, Math.max(5, interval * 3));
        const icon = Gio.BytesIcon.new(new GLib.Bytes(new TextEncoder().encode(this.history.svg())));
        for (const target of this.icons.keys())
            if (target.mapped)
                target.gicon = icon;
    }
    stop() {
        if (this.timer)
            GLib.source_remove(this.timer);
        if (this.idle)
            GLib.source_remove(this.idle);
        this.timer = this.idle = 0;
        this.waitingForApp = false;
        this.detach?.();
        this.detach = null;
        this.values = null;
        this.history = new StatsHistory();
        for (const [box, ids] of this.boxes)
            for (const id of ids)
                box.disconnect(id);
        this.boxes.clear();
        for (const icon of this.icons.keys())
            this.releaseIcon(icon);
    }
    releaseIcon(icon) {
        const original = this.icons.get(icon);
        this.icons.delete(icon);
        icon.disconnect(original.destroyId);
        if (original.gicon)
            icon.gicon = original.gicon;
        else
            icon.icon_name = original.name;
    }
    cleanup() {
        for (const [object, id] of this.signals.splice(0))
            object.disconnect(id);
        this.stop();
        this.docks = [];
    }
}
