import https from 'https';
import { spawn } from 'child_process';

import { ffmpegStreams } from './diagnosticLines';

// Reads the start of SimpliSafe's clip of a motion or doorbell event (HLS or FLV) to learn how soon it can
// be read, whether it is still recording and what it holds. Only used by the motionTest option.
// The SimpliSafe access token is only ever sent to simplisafe.com: redirects elsewhere (e.g. storage
// links that carry their own signature) are followed without it, and ffmpeg never opens a link itself,
// it only reads bytes fetched here

const requestTimeout = 8000; // ms
const maxRedirects = 3;
const maxPlaylistBytes = 256 * 1024;
const maxMediaBytes = 3 * 1024 * 1024;

export const isSimpliSafeHost = host => host === 'simplisafe.com' || host.endsWith('.simplisafe.com');

// The last two labels of a host, e.g. 'amazonaws.com', which says where media is served from without
// anything account specific
export const domainOf = host => host.split('.').slice(-2).join('.');

export function httpGet(url, { token, maxBytes = maxPlaylistBytes, timeout = requestTimeout, redirects = maxRedirects, transport = https } = {}) {
    return new Promise(resolve => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            resolve({ error: 'bad link' });
            return;
        }
        if (parsed.protocol !== 'https:') {
            resolve({ error: 'not https' });
            return;
        }

        const host = parsed.hostname.toLowerCase();
        const headers = token && isSimpliSafeHost(host) ? { Authorization: `Bearer ${token}` } : {};
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            resolve({ host, ...result });
        };

        let req;
        try {
            req = transport.get(parsed, { headers, timeout }, res => {
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    httpGet(next, { token, maxBytes, timeout, redirects: redirects - 1, transport })
                        .then(result => finish({ ...result, redirectedFrom: host }));
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    finish({ status });
                    return;
                }

                const chunks = [];
                let size = 0;
                res.on('data', chunk => {
                    chunks.push(chunk);
                    size += chunk.length;
                    // a clip still recording never ends, what has arrived is enough
                    if (size >= maxBytes) {
                        req.destroy();
                        finish({ status, body: Buffer.concat(chunks), truncated: true, url: parsed.toString() });
                    }
                });
                res.on('end', () => finish({ status, body: Buffer.concat(chunks), url: parsed.toString() }));
                res.on('error', () => finish({ status, body: Buffer.concat(chunks), url: parsed.toString() }));
            });
        } catch (err) {
            finish({ error: err.message });
            return;
        }
        req.on('timeout', () => {
            req.destroy();
            finish({ error: 'timed out' });
        });
        req.on('error', err => finish({ error: err.message }));
    });
}

// The parts of an HLS playlist that matter here
export function parsePlaylist(text, base) {
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const resolve = uri => new URL(uri, base).toString();
    const result = { variants: [], segments: [], map: null, targetDuration: null, ended: false };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const uri = lines.slice(i + 1).find(next => next && !next.startsWith('#'));
            if (uri) result.variants.push(resolve(uri));
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            result.targetDuration = Number(line.split(':')[1]);
        } else if (line.startsWith('#EXT-X-MAP:')) {
            const match = line.match(/URI="([^"]+)"/);
            if (match) result.map = resolve(match[1]);
        } else if (line.startsWith('#EXTINF:')) {
            const duration = parseFloat(line.slice(8));
            const uri = lines.slice(i + 1).find(next => next && !next.startsWith('#'));
            if (uri) result.segments.push({ duration, uri: resolve(uri) });
        } else if (line === '#EXT-X-ENDLIST') {
            result.ended = true;
        }
    }
    return result;
}

// What ffmpeg makes of some media bytes, e.g. ['video h264 (Main), yuvj420p, 1920x1080, 20 fps', 'audio aac (LC), 16000 Hz, mono']
export function describeMedia(ffmpegPath, media, { spawnProcess = spawn, timeout = 15000 } = {}) {
    return new Promise(resolve => {
        let stderr = '';
        let cmd;
        try {
            cmd = spawnProcess(ffmpegPath, ['-hide_banner', '-nostats', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-f', 'null', '-'], { env: process.env });
        } catch {
            resolve([]);
            return;
        }
        const killID = setTimeout(() => cmd.kill('SIGKILL'), timeout);
        cmd.stderr.on('data', data => { stderr += data.toString(); });
        cmd.on('error', () => {});
        cmd.on('close', () => {
            clearTimeout(killID);
            resolve(ffmpegStreams(stderr));
        });
        cmd.stdin.on('error', () => {}); // ffmpeg may stop reading early
        cmd.stdin.end(media);
    });
}

// One attempt to read a clip. Resolves with { readable, details, status } where details is a log-safe
// description: whether the clip is still recording, its segments, where they are served from and what they hold
export async function probeClip(url, kind, { token, ffmpegPath, get = httpGet, describe = describeMedia } = {}) {
    if (kind === 'FLV') {
        const response = await get(url, { token, maxBytes: maxMediaBytes });
        if (!response.body || !response.body.length) return { readable: false, status: response.status || null, error: response.error };
        const streams = await describe(ffmpegPath, response.body);
        const served = `served from ${domainOf(response.host)}${response.redirectedFrom ? ` via ${domainOf(response.redirectedFrom)}` : ''}`;
        return { readable: streams.length > 0, details: `${response.truncated ? 'still recording' : 'finished'}, ${served}; ${streams.join(' / ') || 'no streams found'}` };
    }

    let response = await get(url, { token });
    if (response.status !== 200 || !response.body) return { readable: false, status: response.status || null, error: response.error };
    let playlist = parsePlaylist(response.body.toString(), response.url);
    const servedFrom = [domainOf(response.host)];

    if (playlist.variants.length) {
        response = await get(playlist.variants[0], { token });
        if (response.status !== 200 || !response.body) return { readable: false, status: response.status || null, error: response.error };
        playlist = parsePlaylist(response.body.toString(), response.url);
        servedFrom.push(domainOf(response.host));
    }
    if (!playlist.segments.length) return { readable: false, status: 200, error: 'no segments yet' };

    const parts = [];
    if (playlist.map) {
        const init = await get(playlist.map, { token, maxBytes: maxMediaBytes });
        if (init.body) parts.push(init.body);
        if (init.host) servedFrom.push(domainOf(init.host));
    }
    const segment = await get(playlist.segments[0].uri, { token, maxBytes: maxMediaBytes });
    if (segment.host) servedFrom.push(domainOf(segment.host));
    if (segment.status !== 200 || !segment.body) return { readable: false, status: segment.status || null, error: segment.error || 'first segment not available' };
    parts.push(segment.body);

    const streams = await describe(ffmpegPath, Buffer.concat(parts));
    const total = playlist.segments.reduce((sum, item) => sum + (item.duration || 0), 0);
    const hosts = [...new Set(servedFrom)].join(', ');
    return {
        readable: streams.length > 0,
        details: `${playlist.ended ? 'finished' : 'still recording'}, ${playlist.segments.length} segment(s) totalling ${total.toFixed(1)}s, target ${playlist.targetDuration}s, ${playlist.map ? 'fMP4' : 'TS'} served from ${hosts}; ${streams.join(' / ') || 'no streams found'}`
    };
}
