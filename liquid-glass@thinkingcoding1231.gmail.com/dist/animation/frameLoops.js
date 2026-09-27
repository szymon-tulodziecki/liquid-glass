import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';
import { isFrameSyncFrozen } from './frameSync.js';
export function addBeforeRedraw(callback) {
    return global.compositor?.get_laters?.().add(Meta.LaterType.BEFORE_REDRAW, callback) ?? 0;
}
export function removeBeforeRedraw(id) {
    if (!id)
        return;
    try {
        global.compositor?.get_laters?.().remove(id);
    }
    catch { }
}
export function startLaterLoop(slot, loop) {
    if (slot.get() !== 0)
        return false;
    const tick = () => {
        slot.set(0);
        if (!loop.alive())
            return GLib.SOURCE_REMOVE;
        if (!(loop.honourFreeze && isFrameSyncFrozen())) {
            try {
                loop.step();
            }
            catch (e) {
                reportFrameLoopError(loop.errorTag, e);
            }
        }
        slot.set(addBeforeRedraw(tick));
        return GLib.SOURCE_REMOVE;
    };
    slot.set(addBeforeRedraw(tick));
    return true;
}
export function stopLaterLoop(slot) {
    const id = slot.get();
    slot.set(0);
    removeBeforeRedraw(id);
}
export function startStageLoop(signal, first, tick) {
    if (signal.get() !== 0)
        return false;
    signal.set(global.stage.connect('before-update', tick));
    first.set(addBeforeRedraw(() => {
        first.set(0);
        tick();
        return GLib.SOURCE_REMOVE;
    }));
    return true;
}
export function stopStageLoop(signal, first) {
    const signalId = signal.get();
    signal.set(0);
    if (signalId) {
        try {
            global.stage.disconnect(signalId);
        }
        catch { }
    }
    stopLaterLoop(first);
}
