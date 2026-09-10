import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { UIManager } from './dist/uiManager.js';
import { DashManager } from './dist/dockManager.js';
import { NotificationManager } from './dist/notificationManager.js';
import { QuickSettingsManager } from './dist/quickSettingsManager.js';
import { OsdManager } from './dist/osdManager.js';
import { ApplicationManager } from './dist/applicationManager.js';
import { WindowListService } from './dist/windowListService.js';
import { Logger } from './dist/logger.js';
import { setUtilsLogger } from './dist/utils.js';
import GLib from 'gi://GLib';

const DASH_RESCAN_IDLE_TICKS = 2;
const EXTRA_GLASS_MENUS = [
  { name: 'keyboard', key: 'enable-keyboard-menu-glass' },
  { name: 'vitalsMenu', key: 'enable-vitals-menu-glass' },
];
const DASH_RESCAN_INTERVAL_MS = 2000;

export default class LiquidGlassExtension extends Extension {
  enable() {
    this._dashDocks = [];
    this._settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

    // Initialize the logger
    this._logger = new Logger(this._settings);
    // utils.ts has no settings of its own; hand it the shared, gated logger
    // so UILayerSampler's diagnostics obey `output-logs` like everything else.
    setUtilsLogger(this._logger);

    this._logger.log(`[Liquid Glass] Enabled. UUID: ${this.uuid}`);

    // Initialize the UI manager for the top panel (e.g., Date Menu)
    // Pass the extension path so it can properly load the GLSL shader files
    this._uiManager = new UIManager(this.dir.get_path(), this._settings, this._logger);
    this._uiManager.setup();

    this._extraMenuManagers = [];
    this._extraMenuSignalIds = EXTRA_GLASS_MENUS.map(({ key }) =>
      this._settings.connect(`changed::${key}`, () => this._setupExtraMenuGlass()));
    this._extraMenuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
      this._extraMenuTimeoutId = 0;
      this._setupExtraMenuGlass();
      return GLib.SOURCE_REMOVE;
    });

    // Initialize the notification manager to apply effects to notifications
    this._notificationManager = new NotificationManager(this.dir.get_path(), this._settings, this._logger);
    this._notificationManager.setup();

    // Initialize the OSD manager to apply effects to on-screen displays (like volume changes)
    this._osdManager = new OsdManager(this.dir.get_path(), this._settings, this._logger);
    this._osdManager.setup();

    // Initialize the Application manager to apply effects to whitelisted (or all) application windows
    this._applicationManager = new ApplicationManager(this.dir.get_path(), this._settings, this._logger);
    this._applicationManager.setup();

    // Publishes the list of open windows over D-Bus so the preferences window —
    // which runs in a separate process with no access to Meta/Shell — can offer a
    // live picker instead of asking the user to type WM_CLASS values by hand.
    this._windowListService = new WindowListService(this._logger);
    this._windowListService.setup();

    this._quickSettingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      this._quickSettingsManager = new QuickSettingsManager(this.dir.get_path(), this._settings, this._logger);
      this._quickSettingsManager.setup();
      this._quickSettingsTimeoutId = 0;
      return GLib.SOURCE_REMOVE;
    });

    // Variable to store the timeout ID so we can cancel it if the extension is disabled quickly
    this._timeoutId = 0;

    this._reconnectTimeoutId = 0;
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
      this._scheduleDashRescan();
    });

    // Dash to Dock might not be fully loaded when this extension is enabled at startup.
    // We set a 2-second (2000ms) delay before searching for its UI container.
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      try {
        this._findDashToDock();
        this._scheduleDashRescan();
      } finally {
        this._timeoutId = 0;
      }

      return GLib.SOURCE_REMOVE;
    });
  }

  _setupExtraMenuGlass() {
    this._teardownExtraMenuGlass();

    const detected = [];
    for (const { name, key } of EXTRA_GLASS_MENUS) {
      const panelButton = Main.panel.statusArea[name];
      if (!panelButton || !panelButton.menu || !panelButton.menu.actor)
        continue;

      detected.push(name);
      if (!this._settings.get_boolean(key))
        continue;

      try {
        const manager = new UIManager(this.dir.get_path(), this._settings, this._logger, panelButton, false);
        manager.setup();
        this._extraMenuManagers.push(manager);
      } catch (e) {
        this._logger.log(`[Liquid Glass] Failed to add glass to ${name}: ${e}`);
      }
    }

    this._settings.set_strv('detected-extra-menus', detected);
    this._logger.log(`[Liquid Glass] Extra glass menus: ${this._extraMenuManagers.length} of ${detected.length} detected`);
  }

  _teardownExtraMenuGlass() {
    for (const manager of this._extraMenuManagers ?? []) {
      try {
        manager.cleanup();
      } catch (e) {
        this._logger.log(`[Liquid Glass] Failed to clean up an extra menu: ${e}`);
      }
    }
    this._extraMenuManagers = [];
  }

  _collectDashContainers() {
    const found = [];
    const skip = global.window_group;
    const walk = (actor) => {
      if (actor === skip)
        return;
      if (actor.get_name && actor.get_name() === 'dashtodockDashContainer') {
        found.push(actor);
        return;
      }
      for (const child of actor.get_children())
        walk(child);
    };
    walk(Main.layoutManager.uiGroup);
    return found;
  }

  _findDashToDock() {
    const containers = this._collectDashContainers();

    if (containers.length === 0)
      return false;

    let added = 0;
    for (const container of containers) {
      if (this._dashDocks.some(entry => entry.container === container))
        continue;

      const entry = { container, manager: null, destroyId: 0 };
      this._dashDocks.push(entry);

      try {
        entry.manager = new DashManager(this.dir.get_path(), container, this._settings, this._logger);
        entry.manager.setup();
        entry.destroyId = container.connect('destroy', () => {
          entry.destroyId = 0;
          try {
            this._releaseDashDock(entry);
          } finally {
            this._scheduleDashRescan();
          }
        });
        added++;
      } catch (e) {
        this._logger.log(`[Liquid Glass] Failed to attach glass to a dock: ${e}`);
        try {
          this._releaseDashDock(entry);
        } catch (releaseError) {
          this._logger.log(`[Liquid Glass] Failed to release a dock: ${releaseError}`);
        }
      }
    }

    if (added > 0)
      this._logger.log(`[Liquid Glass] Dash to Dock containers with glass: ${this._dashDocks.length}`);

    return added > 0;
  }

  _releaseDashDock(entry) {
    const index = this._dashDocks.indexOf(entry);
    if (index >= 0)
      this._dashDocks.splice(index, 1);

    if (entry.destroyId !== 0) {
      try {
        entry.container.disconnect(entry.destroyId);
      } catch (e) { }
      entry.destroyId = 0;
    }

    if (entry.manager) {
      entry.manager.cleanup();
      entry.manager = null;
    }
  }

  _scheduleDashRescan() {
    if (this._reconnectTimeoutId !== 0)
      GLib.Source.remove(this._reconnectTimeoutId);

    let idleTicks = 0;
    let sourceId = 0;

    sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DASH_RESCAN_INTERVAL_MS, () => {
      let keepGoing = false;
      try {
        idleTicks = this._findDashToDock() ? 0 : idleTicks + 1;
        keepGoing = idleTicks < DASH_RESCAN_IDLE_TICKS;
      } finally {
        if (!keepGoing && this._reconnectTimeoutId === sourceId)
          this._reconnectTimeoutId = 0;
      }
      return keepGoing ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    });

    this._reconnectTimeoutId = sourceId;
  }

  disable() {
    this._logger.log(`[Liquid Glass] Disabling...`);

    if (this._quickSettingsTimeoutId && this._quickSettingsTimeoutId !== 0) {
      GLib.Source.remove(this._quickSettingsTimeoutId);
      this._quickSettingsTimeoutId = 0;
    }

    // Clear any pending timeouts to prevent them from executing after the extension is disabled
    if (this._monitorsChangedId) {
      Main.layoutManager.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = 0;
    }

    if (this._timeoutId !== 0) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }

    if (this._reconnectTimeoutId !== 0) {
      GLib.Source.remove(this._reconnectTimeoutId);
      this._reconnectTimeoutId = 0;
    }

    // Crucial: Always restore the UI to its original state when the extension is disabled
    // Failing to clean up can result in invisible menus or memory leaks
    if (this._extraMenuTimeoutId) {
      GLib.Source.remove(this._extraMenuTimeoutId);
      this._extraMenuTimeoutId = 0;
    }

    for (const id of this._extraMenuSignalIds ?? [])
      this._settings.disconnect(id);
    this._extraMenuSignalIds = [];

    this._teardownExtraMenuGlass();

    if (this._uiManager) {
      this._uiManager.cleanup();
      this._uiManager = null;
    }

    if (this._quickSettingsManager) {
      this._quickSettingsManager.cleanup();
      this._quickSettingsManager = null;
    }

    for (const entry of [...this._dashDocks]) {
      try {
        this._releaseDashDock(entry);
      } catch (e) {
        this._logger.log(`[Liquid Glass] Failed to release a dock: ${e}`);
      }
    }
    this._dashDocks = [];

    if (this._notificationManager) {
      this._notificationManager.cleanup();
      this._notificationManager = null;
    }

    if (this._osdManager) {
      this._osdManager.cleanup();
      this._osdManager = null;
    }

    if (this._applicationManager) {
      this._applicationManager.cleanup();
      this._applicationManager = null;
    }

    if (this._windowListService) {
      this._windowListService.cleanup();
      this._windowListService = null;
    }

    this._settings = null;

    if (this._logger) {
      setUtilsLogger(null);
      this._logger.cleanup();
      this._logger = null;
    }
  }
}
