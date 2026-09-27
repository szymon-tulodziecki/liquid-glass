export class StatsHistory {
    points = [];
    latest = { cpu: null, rx: null, tx: null };
    received = { cpu: -Infinity, rx: -Infinity, tx: -Infinity };
    update(metric, value, now) {
        if (!['cpu', 'rx', 'tx'].includes(metric) || !Number.isFinite(value) || value < 0)
            return;
        this.latest[metric] = value;
        this.received[metric] = now;
    }
    sample(now, staleAfter) {
        const point = { cpu: null, rx: null, tx: null };
        for (const metric of ['cpu', 'rx', 'tx'])
            if (now - this.received[metric] <= staleAfter)
                point[metric] = this.latest[metric];
        this.points.push(point);
        if (this.points.length > 32)
            this.points.shift();
        return point;
    }
    svg() {
        const networkMax = Math.max(1024, ...this.points.flatMap(point => [point.rx ?? 0, point.tx ?? 0]));
        const paths = ['cpu', 'rx', 'tx'].map((metric, index) => {
            let drawing = false;
            const commands = [];
            this.points.forEach((point, i) => {
                const value = point[metric];
                if (value === null) {
                    drawing = false;
                    return;
                }
                const x = 5 + (32 - this.points.length + i) * 54 / 31;
                const y = (index === 0 ? 29 : 57) - Math.min(1, value / (index === 0 ? 1 : networkMax)) * 19;
                commands.push(`${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
                drawing = true;
            });
            return `<path d="${commands.join(' ')}" fill="none" stroke="${['#72c9ff', '#76efad', '#e5a5ff'][index]}" stroke-width="2"/>`;
        });
        return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="1" y="1" width="62" height="62" rx="13" fill="#142030" fill-opacity=".85" stroke="#ffffff" stroke-opacity=".3"/><path d="M5 32H59" stroke="#ffffff" stroke-opacity=".2"/>${paths.join('')}</svg>`;
    }
}
