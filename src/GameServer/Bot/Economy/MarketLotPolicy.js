function viable(line) {
    const count = Number(line?.count);
    return Number.isSafeInteger(count) && count > 0;
}

module.exports = { viable };
