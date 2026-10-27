'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');

const rootDir = path.resolve(__dirname, '..');
const MANIFEST_NAME = '.l2solo-geodata-manifest.json';

function defaultLogger(message) {
    console.info(`Geodata   :: ${message}`);
}

async function inspectDirectory(directory, options = {}) {
    let entries;

    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { valid: false, exists: false, fileCount: 0 };
        throw error;
    }

    const geodataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.l2j'));
    // Explicit fixture/legacy validation remains available to callers. Normal
    // startup uses a complete manifest rather than a particular pack's sizes.
    if (options.minimumFileCount === undefined && options.requiredFiles === undefined) {
        return inspectManifest(directory, entries, geodataFiles.length);
    }
    const requiredFiles = options.requiredFiles || {};
    const minimumFileCount = Number(options.minimumFileCount ?? Object.keys(requiredFiles).length);
    if (geodataFiles.length < minimumFileCount) {
        return { valid: false, exists: true, fileCount: geodataFiles.length };
    }

    for (const [name, expectedSize] of Object.entries(requiredFiles)) {
        try {
            const stat = await fs.promises.stat(path.join(directory, name));
            if (!stat.isFile() || stat.size !== Number(expectedSize)) {
                return { valid: false, exists: true, fileCount: geodataFiles.length, invalidFile: name };
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { valid: false, exists: true, fileCount: geodataFiles.length, invalidFile: name };
            }
            throw error;
        }
    }

    return { valid: true, exists: true, fileCount: geodataFiles.length };
}

async function fileSha256(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

async function inspectManifest(directory, entries, fileCount) {
    const invalid = (reason, invalidFile) => ({ valid: false, exists: true, fileCount, reason, invalidFile });
    let manifest;
    try {
        manifest = JSON.parse(await fs.promises.readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return invalid(`missing ${MANIFEST_NAME}`);
        if (error instanceof SyntaxError) return invalid('invalid geodata manifest JSON');
        throw error;
    }
    if (manifest.schemaVersion !== 1 || manifest.format !== 'L2J'
        || !Array.isArray(manifest.regions) || !manifest.regions.length) {
        return invalid('unsupported geodata manifest');
    }
    const files = new Map();
    for (const row of manifest.regions) {
        if (!row || !/^\d{2}_\d{2}$/.test(row.region) || files.has(`${row.region}.l2j`)
            || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
            || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) {
            return invalid('invalid or duplicate manifest region');
        }
        files.set(`${row.region}.l2j`, row);
    }
    const actual = entries.filter(entry => entry.name.endsWith('.l2j'));
    const extra = actual.find(entry => !entry.isFile() || !files.has(entry.name));
    if (extra) return invalid('unexpected geodata file', extra.name);
    for (const [name, row] of files) {
        const entry = actual.find(candidate => candidate.name === name);
        if (!entry) return invalid('missing manifest region', name);
        const filename = path.join(directory, name);
        if ((await fs.promises.stat(filename)).size !== row.bytes) return invalid('region size mismatch', name);
        if (await fileSha256(filename) !== row.sha256) return invalid('region checksum mismatch', name);
    }
    return { valid: true, exists: true, fileCount, profile: manifest.profile || null };
}

function openDownload(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(parsed, {
            headers: { 'User-Agent': 'L2Solo-Geodata-Bootstrap/1.0' }
        }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                if (redirects <= 0) {
                    reject(new Error('Too many redirects while downloading geodata'));
                    return;
                }
                resolve(openDownload(new URL(response.headers.location, parsed).toString(), redirects - 1));
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Geodata download failed with HTTP ${response.statusCode}`));
                return;
            }

            response.setTimeout(30000, () => response.destroy(new Error('Geodata download stalled')));
            resolve(response);
        });
        request.on('error', reject);
        request.setTimeout(30000, () => request.destroy(new Error('Geodata download connection timed out')));
    });
}

async function downloadArchive(url, destination, logger) {
    const response = await openDownload(url);
    const expectedBytes = Number(response.headers['content-length'] || 0);
    const hash = crypto.createHash('sha256');
    let receivedBytes = 0;
    let lastReportedPercent = -10;

    logger(`downloading ${url}`);
    const meter = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            receivedBytes += chunk.length;
            if (expectedBytes > 0) {
                const percent = Math.floor(receivedBytes / expectedBytes * 100);
                if (percent >= lastReportedPercent + 10 || percent === 100) {
                    lastReportedPercent = percent;
                    logger(`download ${Math.min(percent, 100)}% (${receivedBytes}/${expectedBytes} bytes)`);
                }
            }
            callback(null, chunk);
        }
    });

    await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx' }));
    return { bytes: receivedBytes, sha256: hash.digest('hex') };
}

function assertSafeArchiveEntry(entry) {
    const name = String(entry.fileName || '').replace(/\\/g, '/');
    const segments = name.split('/');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || segments.includes('..')) {
        throw new Error(`Unsafe geodata archive entry: ${name || '<empty>'}`);
    }
}

async function renameWithRetries(source, destination, options = {}) {
    const retries = Number(options.retries ?? 20);
    const retryDelay = Number(options.retryDelay ?? 250);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(source, destination);
            return 'renamed';
        } catch (error) {
            if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) && options.acceptDestination) {
                if (await options.acceptDestination()) return 'destination-ready';
                if (error.code !== 'EPERM') throw error;
            }
            const retryable = ['EBUSY', 'EPERM'].includes(error.code);
            if (!retryable || attempt >= retries) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
    }
}

async function extractedGeodataRoot(stagingDirectory, validationOptions) {
    const direct = await inspectDirectory(stagingDirectory, validationOptions);
    if (direct.valid) return { directory: stagingDirectory, inspection: direct };

    const entries = await fs.promises.readdir(stagingDirectory, { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        const candidate = path.join(stagingDirectory, entry.name);
        const inspection = await inspectDirectory(candidate, validationOptions);
        if (inspection.valid) return { directory: candidate, inspection };
    }

    throw new Error(`Downloaded geodata archive is incomplete: found ${direct.fileCount} .l2j files`);
}

async function ensureGeodata(options = {}) {
    const logger = options.logger || defaultLogger;
    const targetDirectory = path.resolve(options.targetDirectory
        || process.env.L2NODE_GEODATA_DIR
        || path.join(rootDir, 'data', 'Geodata'));
    const tempDirectory = path.resolve(options.tempDirectory || path.join(rootDir, 'tmp', 'geodata-bootstrap'));
    const url = options.url || process.env.L2NODE_GEODATA_URL;
    const expectedSha256 = String(options.sha256
        || process.env.L2NODE_GEODATA_SHA256
        || '').toLowerCase();
    const validationOptions = {
        minimumFileCount: options.minimumFileCount,
        requiredFiles: options.requiredFiles
    };
    const existing = await inspectDirectory(targetDirectory, validationOptions);

    if (existing.valid) {
        logger(`ready: ${existing.fileCount} region files in ${targetDirectory}`);
        return { downloaded: false, directory: targetDirectory, fileCount: existing.fileCount };
    }
    if (existing.exists) {
        const entries = await fs.promises.readdir(targetDirectory);
        if (entries.length > 0) {
            throw new Error(`Geodata directory is incomplete (${existing.fileCount} region files): ${targetDirectory}`
                + (existing.reason ? ` (${existing.reason}${existing.invalidFile ? `: ${existing.invalidFile}` : ''})` : ''));
        }
        await fs.promises.rmdir(targetDirectory);
    }

    // The retired automatic pack was mostly High Five geometry. Never fetch
    // it as a C4 fallback when a client-generated installation is absent.
    if (!url || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new Error(`Install client-generated L2J geodata with ${MANIFEST_NAME}, or set both L2NODE_GEODATA_URL and L2NODE_GEODATA_SHA256 to a verified archive`);
    }

    await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true });
    await fs.promises.mkdir(tempDirectory, { recursive: true });
    const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const archivePath = path.join(tempDirectory, `geodata-${token}.zip`);
    const stagingDirectory = path.join(path.dirname(targetDirectory), `.Geodata.installing-${token}`);
    let installRoot = null;
    let operationError = null;
    let cleanupError = null;
    let result = null;

    try {
        const downloaded = await downloadArchive(url, archivePath, logger);
        if (downloaded.sha256 !== expectedSha256) {
            throw new Error(`Geodata checksum mismatch: expected ${expectedSha256}, received ${downloaded.sha256}`);
        }
        logger(`checksum verified: ${downloaded.sha256}`);

        await fs.promises.mkdir(stagingDirectory);
        logger('extracting archive');
        await extract(archivePath, {
            dir: stagingDirectory,
            onEntry: assertSafeArchiveEntry
        });
        const extracted = await extractedGeodataRoot(stagingDirectory, validationOptions);
        installRoot = extracted.directory;
        await fs.promises.writeFile(path.join(installRoot, '.l2solo-geodata.json'), `${JSON.stringify({
            url,
            sha256: downloaded.sha256,
            archiveBytes: downloaded.bytes,
            fileCount: extracted.inspection.fileCount,
            installedAt: new Date().toISOString()
        }, null, 2)}\n`);

        const installOutcome = await renameWithRetries(installRoot, targetDirectory, {
            acceptDestination: async () => (await inspectDirectory(targetDirectory, validationOptions)).valid
        });
        const reusedConcurrentInstall = installOutcome === 'destination-ready';
        if (!reusedConcurrentInstall) installRoot = null;
        logger(`${reusedConcurrentInstall ? 'reused concurrent install' : 'installed'} ${extracted.inspection.fileCount} region files in ${targetDirectory}`);
        result = {
            downloaded: !reusedConcurrentInstall,
            directory: targetDirectory,
            fileCount: extracted.inspection.fileCount,
            sha256: downloaded.sha256,
            bytes: downloaded.bytes,
            concurrentInstall: reusedConcurrentInstall
        };
    } catch (error) {
        operationError = error;
    } finally {
        const cleanupTargets = [
            [archivePath, false],
            [stagingDirectory, true]
        ];
        for (const [cleanupPath, recursive] of cleanupTargets) {
            try {
                await fs.promises.rm(cleanupPath, {
                    recursive,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 100
                });
            } catch (error) {
                if (operationError) {
                    logger(`cleanup warning for ${cleanupPath}: ${error.message}`);
                } else if (!cleanupError) {
                    cleanupError = error;
                }
            }
        }
    }

    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    return result;
}

module.exports = {
    MANIFEST_NAME,
    ensureGeodata,
    inspectDirectory
};
