import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID = 'Vitals@CoreCoding.com';

function call(method, cancellable) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions', method,
      new GLib.Variant('(s)', [UUID]), null, Gio.DBusCallFlags.NONE, -1, cancellable, (connection, result) => {
        try { resolve(connection.call_finish(result).deep_unpack()[0]); }
        catch (error) { reject(error); }
      });
  });
}

export function addStatsWidget(page, controls) {
  const group = controls.group(page, 'Dock widget');
  const row = new Adw.SwitchRow({title: 'CPU and network', subtitle: 'Uses Vitals. Drag it between your dock icons.'});
  group.add(row);
  let syncing = false;
  let closed = false;
  let pending = null;
  controls.watch(['dock-stats-widget'], () => {
    syncing = true;
    row.active = controls.settings.get_boolean('dock-stats-widget');
    syncing = false;
  });
  controls.onClose(() => { closed = true; pending?.cancel(); });
  row.connect('notify::active', async () => {
    if (syncing || pending) return;
    if (!row.active) {
      controls.write({'dock-stats-widget': false});
      return;
    }
    pending = new Gio.Cancellable();
    row.sensitive = false;
    try {
      const info = await call('GetExtensionInfo', pending);
      if (!Object.keys(info).length) {
        row.subtitle = 'Confirm the Vitals installation in GNOME.';
        if (await call('InstallRemoteExtension', pending) !== 'successful') throw Error('Vitals installation was cancelled');
      }
      if (!await call('EnableExtension', pending)) throw Error('GNOME could not enable Vitals');
      if (!closed) {
        controls.write({'dock-stats-widget': true});
        row.subtitle = 'CPU above, download and upload below. Click to open Vitals settings.';
      }
    } catch (error) {
      if (!closed) {
        syncing = true;
        row.active = controls.settings.get_boolean('dock-stats-widget');
        syncing = false;
        row.subtitle = String(error.message ?? error);
      }
    } finally {
      pending = null;
      if (!closed) row.sensitive = true;
    }
  });
}
