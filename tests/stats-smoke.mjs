import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {StatsHistory} from '../liquid-glass@thinkingcoding1231.gmail.com/dist/stats/chart.js';

const history = new StatsHistory();
for (let i = 0; i < 40; i++) {
  history.update('cpu', (i % 10) / 10, i);
  history.update('rx', i * 1000, i);
  history.update('tx', i * 500, i);
  history.sample(i, 5);
}
const bytes = new GLib.Bytes(new TextEncoder().encode(history.svg()));
const icon = Gio.BytesIcon.new(bytes);
if (icon.to_string() !== null) throw Error('Graph icon would enter Shell’s permanent texture cache');
const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
if (pixbuf.width !== 64 || pixbuf.height !== 64) throw Error('Unexpected graph dimensions');
stream.close(null);
print(JSON.stringify({svgDecode: 'passed', permanentIconCache: 'bypassed', history: history.points.length}));
