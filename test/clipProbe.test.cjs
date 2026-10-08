const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { httpGet, parsePlaylist, probeClip, domainOf, isSimpliSafeHost } = require('../dist/lib/clipProbe');

// A fake https module: answers from a table keyed by link, records the headers each request carried
function fakeTransport(routes) {
    const requests = [];
    return {
        requests,
        get(url, options, callback) {
            const key = url.toString();
            requests.push({ url: key, headers: options.headers });
            const req = new EventEmitter();
            req.destroy = () => {};
            setImmediate(() => {
                const route = routes[key] || { status: 404 };
                const res = new EventEmitter();
                res.statusCode = route.status;
                res.headers = route.location ? { location: route.location } : {};
                res.resume = () => {};
                callback(res);
                if (route.status === 200) {
                    res.emit('data', Buffer.from(route.body));
                    res.emit('end');
                }
            });
            return req;
        },
    };
}

test('the token goes to simplisafe.com only, and is dropped when a redirect leaves it', async () => {
    const transport = fakeTransport({
        'https://chronicle.simplisafe.com/clip': { status: 302, location: 'https://bucket.s3.amazonaws.com/clip?signature=abc' },
        'https://bucket.s3.amazonaws.com/clip?signature=abc': { status: 200, body: 'media' },
    });

    const result = await httpGet('https://chronicle.simplisafe.com/clip', { token: 'secret-token', transport });

    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'media');
    assert.equal(result.host, 'bucket.s3.amazonaws.com');
    assert.equal(result.redirectedFrom, 'chronicle.simplisafe.com');
    assert.deepEqual(transport.requests.map((r) => r.headers.Authorization), ['Bearer secret-token', undefined]);
});

test('plain http and other hosts never get the token', async () => {
    const transport = fakeTransport({ 'https://example.com/x': { status: 200, body: 'x' } });
    assert.equal((await httpGet('http://media.simplisafe.com/x', { token: 't', transport })).error, 'not https');
    await httpGet('https://example.com/x', { token: 't', transport });
    assert.equal(transport.requests[0].headers.Authorization, undefined);
    assert.equal(isSimpliSafeHost('simplisafe.com.evil.example'), false);
    assert.equal(domainOf('b-12ab.kinesisvideo.us-east-1.amazonaws.com'), 'amazonaws.com');
});

test('playlists are read for variants, segments, an init segment and whether recording has finished', () => {
    const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvariant.m3u8\n', 'https://a.simplisafe.com/v/master.m3u8');
    assert.deepEqual(master.variants, ['https://a.simplisafe.com/v/variant.m3u8']);

    const media = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg0.m4s\n#EXTINF:1.5,\nhttps://cdn.example.net/seg1.m4s\n', 'https://a.simplisafe.com/v/variant.m3u8');
    assert.equal(media.targetDuration, 2);
    assert.equal(media.map, 'https://a.simplisafe.com/v/init.mp4');
    assert.deepEqual(media.segments.map((s) => s.uri), ['https://a.simplisafe.com/v/seg0.m4s', 'https://cdn.example.net/seg1.m4s']);
    assert.equal(media.ended, false);
    assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n', 'https://a.simplisafe.com/').ended, true);
});

test('an HLS clip still recording is described with where it is served from and what it holds', async () => {
    const routes = {
        'https://a.simplisafe.com/hls': { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n' },
        'https://a.simplisafe.com/media.m3u8': { status: 200, body: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttps://kvs.amazonaws.com/s0.ts\n#EXTINF:2.0,\nhttps://kvs.amazonaws.com/s1.ts\n' },
        'https://kvs.amazonaws.com/s0.ts': { status: 200, body: 'ts bytes' },
    };
    const transport = fakeTransport(routes);
    const get = (url, options) => httpGet(url, { ...options, transport });
    const describe = async (path, media) => (media.toString() === 'ts bytes' ? ['video h264 (Main), 1920x1080, 20 fps', 'audio aac (LC), 16000 Hz'] : []);

    const result = await probeClip('https://a.simplisafe.com/hls', 'HLS', { token: 'tok', ffmpegPath: 'ffmpeg', get, describe });

    assert.equal(result.readable, true);
    assert.equal(result.details, 'still recording, 2 segment(s) totalling 4.0s, target 2s, TS served from simplisafe.com, amazonaws.com; video h264 (Main), 1920x1080, 20 fps / audio aac (LC), 16000 Hz');
    assert.equal(transport.requests.find((r) => r.url.includes('amazonaws')).headers.Authorization, undefined);
});

test('a clip that has no segments yet, or is missing, is not readable and says why', async () => {
    const transport = fakeTransport({ 'https://a.simplisafe.com/hls': { status: 200, body: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' } });
    const get = (url, options) => httpGet(url, { ...options, transport });

    assert.deepEqual(await probeClip('https://a.simplisafe.com/hls', 'HLS', { get, describe: async () => [] }), { readable: false, status: 200, error: 'no segments yet' });
    const missing = await probeClip('https://a.simplisafe.com/other', 'HLS', { get, describe: async () => [] });
    assert.equal(missing.readable, false);
    assert.equal(missing.status, 404);
});

// A response the test drives by hand
function manualTransport() {
    const calls = [];
    return {
        calls,
        get(url, options, callback) {
            const req = new EventEmitter();
            req.destroyed = false;
            req.destroy = () => { req.destroyed = true; };
            calls.push({ url: url.toString(), options, req, respond: (res) => callback(res) });
            return req;
        },
    };
}
const response = (statusCode, headers = {}) => Object.assign(new EventEmitter(), { statusCode, headers, resume() {} });

test('a redirect to a link that cannot be read ends the request instead of crashing Homebridge', async () => {
    for (const location of ['https://[bad', '//', 'https://exa^mple.com/', 'https://media.simplisafe.com:99999/x']) {
        const transport = manualTransport();
        const pending = httpGet('https://chronicle.simplisafe.com/clip', { token: 't', transport });
        assert.doesNotThrow(() => transport.calls[0].respond(response(302, { location })));
        assert.deepEqual(await pending, { host: 'chronicle.simplisafe.com', status: 302, error: 'bad redirect' }, location);
        assert.equal(transport.calls[0].req.destroyed, true, 'the redirect body is not downloaded');
    }
});

test('an error reply is closed at once rather than drained', async () => {
    const transport = manualTransport();
    const pending = httpGet('https://chronicle.simplisafe.com/clip', { token: 't', transport });
    transport.calls[0].respond(response(404));
    assert.deepEqual(await pending, { host: 'chronicle.simplisafe.com', status: 404 });
    assert.equal(transport.calls[0].req.destroyed, true);
});

test('a body still arriving at the deadline is cut short with what has arrived', async () => {
    const transport = manualTransport();
    const pending = httpGet('https://chronicle.simplisafe.com/clip', { token: 't', transport, deadline: Date.now() + 80 });
    const res = response(200);
    transport.calls[0].respond(res);
    res.emit('data', Buffer.from('first bytes'));

    const result = await pending;
    assert.equal(result.truncated, true);
    assert.equal(result.body.toString(), 'first bytes');
    assert.equal(transport.calls[0].req.destroyed, true);
});

test('a redirect followed is not undone by the first request closing afterwards', async () => {
    const transport = manualTransport();
    const pending = httpGet('https://chronicle.simplisafe.com/clip', { token: 't', transport });
    transport.calls[0].respond(response(302, { location: 'https://bucket.s3.amazonaws.com/clip' }));
    transport.calls[0].req.emit('error', new Error('socket hang up'));
    const res = response(200);
    transport.calls[1].respond(res);
    res.emit('data', Buffer.from('media'));
    res.emit('end');

    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'media');
    assert.equal(transport.calls[1].options.headers.Authorization, undefined);
});

test('ffmpeg only reads plain media formats from the pipe, so it never opens links in a manifest', async () => {
    const { describeMedia } = require('../dist/lib/clipProbe');
    let args;
    const fake = () => {
        const cmd = new EventEmitter();
        cmd.stderr = new EventEmitter();
        cmd.stdin = Object.assign(new EventEmitter(), { end: () => setImmediate(() => cmd.emit('close', 0)) });
        cmd.kill = () => {};
        return cmd;
    };
    await describeMedia('ffmpeg', Buffer.from('x'), { spawnProcess: (path, a) => { args = a; return fake(); } });

    const whitelist = args.indexOf('-format_whitelist');
    assert.ok(whitelist > -1 && whitelist < args.indexOf('-i'));
    assert.equal(args[whitelist + 1], 'mov,mpegts,flv,live_flv');
});

test('the real ffmpeg refuses a DASH manifest from the pipe', async () => {
    const { describeMedia } = require('../dist/lib/clipProbe');
    const mpd = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period><AdaptationSet><Representation id="1" bandwidth="1"><BaseURL>http://127.0.0.1:9/x.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
    assert.deepEqual(await describeMedia(require('ffmpeg-for-homebridge'), Buffer.from(mpd)), []);
});
