// Virtual setTimeout/clearTimeout for tests, since Node 18 has no mock timers. Date.now is left alone
function useFakeTimers() {
    const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
    let now = 0;
    let nextId = 1;
    const timers = new Map();

    global.setTimeout = (fn, ms = 0, ...args) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn, args });
        return { id, unref() { return this; }, ref() { return this; }, [Symbol.toPrimitive]: () => id };
    };
    global.clearTimeout = (timer) => { if (timer) timers.delete(typeof timer === 'object' ? timer.id : timer); };

    return {
        tick(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, timer] = due;
                timers.delete(id);
                now = timer.at;
                timer.fn(...timer.args);
            }
            now = end;
        },
        restore() {
            global.setTimeout = real.setTimeout;
            global.clearTimeout = real.clearTimeout;
        },
    };
}

module.exports = { useFakeTimers };
