'use strict';

// This thread's CPU ms (user + system) since the meter's previous read: one threadCpuUsage call per read
// (the one owner; safe on main and in workers). Beside a busy share (wall clock) it tells our work from time
// the system took: a thread waiting for a core lasts longer by the clock with no more CPU.
module.exports = () => {
    let last = process.threadCpuUsage();
    return () => {
        const now = process.threadCpuUsage();
        const ms = (now.user - last.user + now.system - last.system) / 1000;
        last = now;
        return ms;
    };
};
