const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { RtpPacket } = require('werift');

const { LiveKitRecordingSource, FlvRecordingSource, recordingOptions } = require('../dist/lib/recording');
const RecordingDelegate = require('../dist/lib/recordingDelegate').default;
const ffmpeg = require('ffmpeg-for-homebridge');

const log = () => {};
log.error = () => {};
const boxTypes = (buffer) => {
    const types = [];
    for (let offset = 0; offset + 8 <= buffer.length;) {
        types.push(buffer.toString('latin1', offset + 4, offset + 8));
        offset += buffer.readUInt32BE(offset);
    }
    return types;
};
function describe(file) {
    const run = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-']);
    return run.stderr.toString();
}
function withDir(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-recording-'));
    return Promise.resolve(run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function collect(source, { fragments = 3, timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const out = [];
        const timer = setTimeout(() => reject(new Error(`only ${out.length} fragment(s), ${source.endReason || 'still running'}`)), timeout);
        source.on('fragment', (fragment) => {
            out.push(fragment);
            if (out.length === fragments) { clearTimeout(timer); resolve(out); }
        });
        source.on('end', (reason) => { if (out.length < fragments) { clearTimeout(timer); reject(new Error(`ended: ${reason}`)); } });
    });
}

// What an Outdoor Camera sends over LiveKit: H.264 High with a keyframe every 2s, and Opus in 100 ms packets,
// as RTP packets in real time, emitted the way LiveKitSource does
function fakeCamera(seconds) {
    const camera = new EventEmitter();
    camera.streaming = true;
    camera.requestKeyframe = () => true;
    const sockets = ['video', 'audio'].map((kind) => {
        const socket = dgram.createSocket('udp4');
        socket.on('message', (message) => camera.emit(kind, RtpPacket.deSerialize(message)));
        return socket;
    });
    return {
        camera,
        start: () => Promise.all(sockets.map((socket) => new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)))).then(() => {
            const [video, audio] = sockets.map((socket) => socket.address().port);
            camera.process = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re',
                '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds),
                '-map', '0:v', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-g', '40', '-bf', '0', '-f', 'rtp', '-payload_type', '96', `rtp://127.0.0.1:${video}?pkt_size=1200`,
                '-map', '1:a', '-c:a', 'libopus', '-frame_duration', '100', '-ac', '2', '-f', 'rtp', '-payload_type', '111', `rtp://127.0.0.1:${audio}`]);
        }),
        stop: () => { if (camera.process) camera.process.kill('SIGKILL'); sockets.forEach((socket) => socket.close()); },
    };
}

test('an Outdoor Camera\'s stream becomes fragmented MP4 with its H.264 copied and Opus turned into AAC', { timeout: 60000 }, () => withDir(async (dir) => {
    const fake = fakeCamera(9);
    let released = 0;
    const lease = { source: fake.camera, ready: Promise.resolve() };
    const source = new LiveKitRecordingSource({ name: 'Back Yard', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        acquire: () => lease,
        release: (l) => { assert.equal(l, lease); released++; },
    });

    source.start();
    await fake.start();
    try {
        const fragments = await collect(source, { fragments: 3 });
        assert.deepEqual(boxTypes(source.init), ['ftyp', 'moov']);
        for (const fragment of fragments) assert.deepEqual(boxTypes(fragment.data), ['moof', 'mdat']);

        const file = path.join(dir, 'recording.mp4');
        fs.writeFileSync(file, Buffer.concat([source.init, ...fragments.map((f) => f.data)]));
        const info = describe(file);
        assert.match(info, /Video: h264 \(High\)/);
        assert.match(info, /1280x720/);
        assert.match(info, /Audio: aac \(LC\).*16000 Hz, mono/);
        assert.ok(!/Error while decoding|non-existing PPS|missing picture/i.test(info), info);
        // keyframe every 2s, a fragment per keyframe: 3 fragments is about 6s
        const seconds = Number(info.match(/time=00:00:(\d+\.\d+)/g).pop().slice(-5));
        assert.ok(seconds > 4.5 && seconds < 7, `${seconds}s of video`);
    } finally {
        source.end('test over');
        fake.stop();
    }
    assert.equal(released, 1, 'the LiveKit connection is given back');
}));

test('without recording audio the MP4 has no audio track', { timeout: 60000 }, () => withDir(async (dir) => {
    const fake = fakeCamera(5);
    const source = new LiveKitRecordingSource({ name: 'Garage', log, debug: false, ffmpegPath: ffmpeg, audio: false }, {
        acquire: () => ({ source: fake.camera, ready: Promise.resolve() }),
        release: () => {},
    });
    source.start();
    await fake.start();
    try {
        const [fragment] = await collect(source, { fragments: 1 });
        const file = path.join(dir, 'silent.mp4');
        fs.writeFileSync(file, Buffer.concat([source.init, fragment.data]));
        const info = describe(file);
        assert.match(info, /Video: h264/);
        assert.ok(!/Audio:/.test(info));
    } finally {
        source.end('test over');
        fake.stop();
    }
}));

test('the Doorbell Pro\'s FLV is fetched from media.simplisafe.com with the login and copied as it is', { timeout: 60000 }, () => withDir(async (dir) => {
    // what media.simplisafe.com sends: H.264 Main full range at 20 fps with a keyframe every 2s, AAC-LC 16 kHz mono
    const flvFile = path.join(dir, 'camera.flv');
    const make = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=16000',
        '-t', '7', '-c:v', 'libx264', '-preset', 'superfast', '-profile:v', 'main', '-pix_fmt', 'yuvj420p', '-g', '40', '-c:a', 'aac', '-ac', '1', '-f', 'flv', flvFile]);
    assert.equal(make.status, 0, make.stderr.toString());

    const requests = [];
    const transport = {
        get(options, callback) {
            requests.push(options);
            const req = new EventEmitter();
            req.destroy = () => {};
            setImmediate(() => {
                const res = fs.createReadStream(flvFile);
                res.statusCode = 200;
                callback(res);
            });
            return req;
        },
    };
    const source = new FlvRecordingSource({ name: 'Front Door', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        uuid: 'bb252bbe6a402bf67b161bb1b0640051', accessToken: () => 'secret-token', transport,
    });
    source.start();
    const fragments = await collect(source, { fragments: 3, timeout: 45000 });

    assert.deepEqual(requests, [{ host: 'media.simplisafe.com', path: '/v1/bb252bbe6a402bf67b161bb1b0640051/flv?x=1920&audioEncoding=AAC', headers: { Authorization: 'Bearer secret-token' }, timeout: 15000 }]);
    assert.equal(requests[0].rejectUnauthorized, undefined, 'the certificate is checked');
    const file = path.join(dir, 'doorbell.mp4');
    fs.writeFileSync(file, Buffer.concat([source.init, ...fragments.map((f) => f.data)]));
    const info = describe(file);
    assert.match(info, /Video: h264 \(Main\)/);
    assert.match(info, /Audio: aac \(LC\).*16000 Hz, mono/);
    source.end('test over');
}));

test('a refused or failed FLV request ends the source with the reason', async () => {
    const transport = (status) => ({
        get(options, callback) {
            const req = new EventEmitter();
            req.destroy = () => {};
            setImmediate(() => callback(Object.assign(new EventEmitter(), { statusCode: status, resume() {} })));
            return req;
        },
    });
    const source = new FlvRecordingSource({ name: 'Front Door', log, ffmpegPath: ffmpeg }, { uuid: 'x', accessToken: () => 't', transport: transport(401) });
    const reason = await new Promise((resolve) => { source.on('end', resolve); source.start(); });
    assert.equal(reason, 'media.simplisafe.com answered HTTP 401');
});

test('the advertised recording options are the same whatever the camera, so HomeKit keeps the user\'s choice', () => {
    const hap = require('@homebridge/hap-nodejs');
    const a = recordingOptions(hap);
    assert.deepEqual(a, recordingOptions(hap));
    assert.equal(a.audio.codecs[0].type, hap.AudioRecordingCodecType.AAC_LC);
    assert.equal(a.audio.codecs[0].samplerate, hap.AudioRecordingSamplerate.KHZ_16);
    assert.ok(a.video.resolutions.some(([w, h]) => w === 1920 && h === 1080));
    assert.ok(a.video.resolutions.some(([w, h]) => w === 1280 && h === 720));
});
