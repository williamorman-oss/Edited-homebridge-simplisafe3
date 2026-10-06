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
const maxFlvBytes = 256 * 1024; // the start of an FLV holds its stream headers, enough to describe it

export const isSimpliSafeHost = host => host === 'simplisafe.com' || host.endsWith('.simplisafe.com');

// The last two labels of a host, e.g. 'amazonaws.com', which says where media is served from without
// anything account specific
export const domainOf = host => host.split('.').slice(-2).join('.');

// GETs a link. Resolves, never rejects, with { host, status, body, truncated, url, redirectedFrom } or
// { host, error }. 'timeout' is how long the connection may sit idle, 'deadline' the time (ms since the
// epoch) by which everything, redirects included, must be done; a body still arriving then is cut short
export function httpGet(url, { token, maxBytes = maxPlaylistBytes, timeout = requestTimeout, deadline = Date.now() + requestTimeout, redirects = maxRedirects, transport = https } = {}) {
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
        if (Date.now() >= deadline) {
            resolve({ error: 'timed out' });
            return;
        }

        const host = parsed.hostname.toLowerCase();
        const headers = token && isSimpliSafeHost(host) ? { Authorization: `Bearer ${token}` } : {};
        const chunks = [];
        let status = null;
        let req;
        let deadlineID;
        let following = false;
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(deadlineID);
            resolve({ host, ...result });
        };
        const partial = () => ({ status, body: Buffer.concat(chunks), truncated: true, url: parsed.toString() });

        deadlineID = setTimeout(() => {
            if (req) req.destroy();
            finish(status === 200 ? partial() : { error: 'timed out' });
        }, Math.max(0, deadline - Date.now()));

        try {
            req = transport.get(parsed, { headers, timeout }, res => {
                try {
                    status = res.statusCode;
                    if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                        // the body of a redirect is never needed, and may not end
                        req.destroy();
                        let next;
                        try {
                            next = new URL(res.headers.location, parsed).toString();
                        } catch {
                            finish({ status, error: 'bad redirect' });
                            return;
                        }
                        // from here the next request decides the result, not this one closing
                        following = true;
                        clearTimeout(deadlineID);
                        httpGet(next, { token, maxBytes, timeout, deadline, redirects: redirects - 1, transport })
                            .then(result => finish({ ...result, redirectedFrom: host }));
                        return;
                    }
                    if (status !== 200) {
                        req.destroy();
                        finish({ status });
                        return;
                    }

                    let size = 0;
                    res.on('data', chunk => {
                        chunks.push(chunk);
                        size += chunk.length;
                        // a clip still recording never ends, what has arrived is enough
                        if (size >= maxBytes) {
                            req.destroy();
                            finish(partial());
                        }
                    });
                    res.on('end', () => finish({ status, body: Buffer.concat(chunks), url: parsed.toString() }));
                    res.on('error', () => finish(partial()));
                } catch {
                    // a throw here would escape to the process and stop Homebridge
                    if (req) req.destroy();
                    finish({ status, error: 'bad response' });
                }
            });
        } catch (err) {
            finish({ error: 'request failed' });
            return;
        }
        req.on('timeout', () => {
            if (following) return;
            req.destroy();
            finish(status === 200 ? partial() : { error: 'timed out' });
        });
        req.on('error', () => {
            if (following) return;
            finish(status === 200 ? partial() : { error: 'request failed' });
        });
    });
}

// The parts of an HLS playlist that matter here
export function parsePlaylist(text, base) {
    const lines = text.split(/\r?\n/).map(line => line.trim());
    // an entry that is not a link is skipped
    const resolve = uri => {
        try {
            return new URL(uri, base).toString();
        } catch {
            return null;
        }
    };
    const result = { variants: [], segments: [], map: null, targetDuration: null, ended: false };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const uri = lines.slice(i + 1).find(next => next && !next.startsWith('#'));
            const link = uri && resolve(uri);
            if (link) result.variants.push(link);
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            result.targetDuration = Number(line.split(':')[1]);
        } else if (line.startsWith('#EXT-X-MAP:')) {
            const match = line.match(/URI="([^"]+)"/);
            if (match) result.map = resolve(match[1]);
        } else if (line.startsWith('#EXTINF:')) {
            const duration = parseFloat(line.slice(8));
            const uri = lines.slice(i + 1).find(next => next && !next.startsWith('#'));
            const link = uri && resolve(uri);
            if (link) result.segments.push({ duration, uri: link });
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
            // only formats that are plain media: a playlist or manifest would make ffmpeg open its links itself
            cmd = spawnProcess(ffmpegPath, ['-hide_banner', '-nostats', '-format_whitelist', 'mov,mpegts,flv,live_flv', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-f', 'null', '-'], { env: process.env });
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
export async function probeClip(url, kind, { token, ffmpegPath, deadline, get = httpGet, describe = describeMedia } = {}) {
    const fetch = (link, options = {}) => get(link, { token, deadline, ...options });
    const failed = response => ({ readable: false, status: response.status || null, error: response.error, host: response.host });

    if (kind === 'FLV') {
        const response = await fetch(url, { maxBytes: maxFlvBytes });
        if (!response.body || !response.body.length) return failed(response);
        const streams = await describe(ffmpegPath, response.body);
        const served = `served from ${domainOf(response.host)}${response.redirectedFrom ? ` via ${domainOf(response.redirectedFrom)}` : ''}`;
        return { readable: streams.length > 0, details: `${response.truncated ? 'still recording' : 'finished'}, ${served}; ${streams.join(' / ') || 'no streams found'}` };
    }

    let response = await fetch(url);
    if (response.status !== 200 || !response.body) return failed(response);
    let playlist = parsePlaylist(response.body.toString(), response.url);
    const servedFrom = [domainOf(response.host)];

    if (playlist.variants.length) {
        response = await fetch(playlist.variants[0]);
        if (response.status !== 200 || !response.body) return failed(response);
        playlist = parsePlaylist(response.body.toString(), response.url);
        servedFrom.push(domainOf(response.host));
    }
    if (!playlist.segments.length) return { readable: false, status: 200, error: 'no segments yet' };

    const parts = [];
    if (playlist.map) {
        const init = await fetch(playlist.map, { maxBytes: maxMediaBytes });
        if (init.body) parts.push(init.body);
        if (init.host) servedFrom.push(domainOf(init.host));
    }
    const segment = await fetch(playlist.segments[0].uri, { maxBytes: maxMediaBytes });
    if (segment.host) servedFrom.push(domainOf(segment.host));
    if (segment.status !== 200 || !segment.body) return { ...failed(segment), error: segment.error || 'first segment not available' };
    parts.push(segment.body);

    const streams = await describe(ffmpegPath, Buffer.concat(parts));
    const total = playlist.segments.reduce((sum, item) => sum + (item.duration || 0), 0);
    const hosts = [...new Set(servedFrom)].join(', ');
    return {
        readable: streams.length > 0,
        details: `${playlist.ended ? 'finished' : 'still recording'}, ${playlist.segments.length} segment(s) totalling ${total.toFixed(1)}s, target ${playlist.targetDuration}s, ${playlist.map ? 'fMP4' : 'TS'} served from ${hosts}; ${streams.join(' / ') || 'no streams found'}`
    };
}
