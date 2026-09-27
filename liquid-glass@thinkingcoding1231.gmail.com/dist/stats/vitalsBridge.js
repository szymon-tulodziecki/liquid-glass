export function observeVitals(values, receive) {
    if (typeof values?.returnIfDifferent !== 'function')
        return null;
    const original = values.returnIfDifferent;
    const hadOwn = Object.prototype.hasOwnProperty.call(values, 'returnIfDifferent');
    let listener = receive;
    const wrapped = function (...args) {
        const result = original.apply(this, args);
        if (!listener)
            return result;
        const [, , raw, type] = args;
        try {
            if (type === 'processor-group' && Number.isFinite(raw))
                listener('cpu', Math.min(1, Math.max(0, raw)));
            if (type === 'network-rx' || type === 'network-tx') {
                const direction = type.slice(-2);
                const rates = Object.values(this._networkSpeeds?.[direction] ?? {});
                if (rates.length && rates.every(rate => Number.isFinite(rate) && rate >= 0))
                    listener(direction, rates.reduce((sum, rate) => sum + rate, 0));
            }
        }
        catch (error) {
            console.error(`[Liquid Glass] Vitals widget update: ${error}`);
        }
        return result;
    };
    values.returnIfDifferent = wrapped;
    return () => {
        listener = null;
        if (values.returnIfDifferent !== wrapped)
            return;
        if (hadOwn)
            values.returnIfDifferent = original;
        else
            delete values.returnIfDifferent;
    };
}
