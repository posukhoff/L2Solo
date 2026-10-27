'use strict';

// This thread's CPU ms (user + system) since the meter's previous read: one threadCpuUsage call per read
// (the one owner; safe on main and in workers). Beside a busy share (wall clock) it tells our work from time
// the thread spent off a core: a thread waiting for one lasts longer by the clock with no more CPU.
// null on a Node without process.threadCpuUsage (added in 22.19 / 23.9; package.json allows 22.5).
module.exports = () => {
    if (typeof process.threadCpuUsage !== 'function') return () => null;
    let last = process.threadCpuUsage();
    return () => {
        const now = process.threadCpuUsage();
        const ms = (now.user - last.user + now.system - last.system) / 1000;
        last = now;
        return ms;
    };
};
