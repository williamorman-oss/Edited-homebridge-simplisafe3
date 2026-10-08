const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { RtpPacket, RtpHeader } = require('werift');

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

// What an Outdoor Camera sends over LiveKit: H.264 High with a keyframe every 2s, and Opus in 100 ms packets
// that start about a second before the video, as RTP packets in real time, emitted the way LiveKitSource does.
// audioSeconds: how long the camera sends audio, 0 for a camera with its microphone off
function fakeCamera(seconds, { audioSeconds = seconds + 1 } = {}) {
    const camera = new EventEmitter();
    camera.streaming = true;
    camera.requestKeyframe = () => true;
    const sockets = ['video', 'audio'].map((kind) => {
        const socket = dgram.createSocket('udp4');
        socket.on('message', (message) => camera.emit(kind, RtpPacket.deSerialize(message)));
        return socket;
    });
    const processes = [];
    let timer = null;
    const send = (args) => processes.push(spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', ...args]));
    return {
        camera,
        start: () => Promise.all(sockets.map((socket) => new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)))).then(() => {
            const [video, audio] = sockets.map((socket) => socket.address().port);
            if (audioSeconds) send(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(audioSeconds),
                '-c:a', 'libopus', '-frame_duration', '100', '-ac', '2', '-f', 'rtp', '-payload_type', '111', `rtp://127.0.0.1:${audio}`]);
            timer = setTimeout(() => send(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=20', '-t', String(seconds),
                '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-g', '40', '-bf', '0', '-f', 'rtp', '-payload_type', '96', `rtp://127.0.0.1:${video}?pkt_size=1200`]), 1000);
        }),
        stop: () => { clearTimeout(timer); processes.forEach((process) => process.kill('SIGKILL')); sockets.forEach((socket) => socket.close()); },
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

// A source past its keyframe, with what it sends to ffmpeg captured instead of sent
function sendingSource() {
    const camera = new EventEmitter();
    const source = new LiveKitRecordingSource({ name: 'Back Yard', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        acquire: () => ({ source: camera, ready: new Promise(() => {}) }),
        release: () => {},
    });
    const sent = [];
    source.start();
    source.ports = { video: 1, audio: 2 };
    source.socket = { send: (data, port) => sent.push({ port, rtp: RtpPacket.deSerialize(data) }), close() {} };
    const packet = (kind, sequenceNumber, ssrc = 7) => camera.emit(kind, new RtpPacket(new RtpHeader({ payloadType: kind === 'video' ? 102 : 111, ssrc, sequenceNumber, timestamp: 1000 }), Buffer.from([sequenceNumber & 0xff])));
    return { source, sent, packet };
}

test('late and repeated packets keep the camera\'s order for ffmpeg, numbered from the first one sent', () => {
    const { source, sent, packet } = sendingSource();
    // a retransmitted packet after the ones that followed it, and one that came twice, across the wrap
    for (const sequenceNumber of [65533, 65535, 0, 65534, 1, 1, 65535]) packet('video', sequenceNumber);
    packet('audio', 500);
    packet('audio', 502);
    assert.deepEqual(sent.filter((p) => p.port === 1).map((p) => p.rtp.header.sequenceNumber), [1, 3, 4, 2, 5]);
    assert.deepEqual(sent.filter((p) => p.port === 1).map((p) => p.rtp.payload[0]), [0xfd, 0xff, 0, 0xfe, 1]);
    // audio has its own numbering, with the lost packet left as a gap
    assert.deepEqual(sent.filter((p) => p.port === 2).map((p) => p.rtp.header.sequenceNumber), [1, 3]);
    assert.equal(source.ended, false);
    source.end('test over');
});

test('a new stream from the camera ends the source rather than breaking the recording\'s timeline', () => {
    const { source, sent, packet } = sendingSource();
    let reason = null;
    source.on('end', (r) => { reason = r; });
    packet('video', 100);
    packet('video', 101);
    packet('video', 9000, 8); // published again: new SSRC and numbering
    packet('video', 9001, 8);
    assert.equal(reason, 'the camera started a new video stream');
    assert.equal(sent.length, 2);
});

test('with recording audio on, a camera that sends no audio is still recorded, without an audio track', { timeout: 60000 }, () => withDir(async (dir) => {
    const fake = fakeCamera(6, { audioSeconds: 0 });
    const source = new LiveKitRecordingSource({ name: 'Back Yard', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        acquire: () => ({ source: fake.camera, ready: Promise.resolve() }),
        release: () => {},
    });
    source.start();
    await fake.start();
    try {
        // ffmpeg told about audio that never comes writes nothing at all
        const [fragment] = await collect(source, { fragments: 1, timeout: 8000 });
        const file = path.join(dir, 'no-microphone.mp4');
        fs.writeFileSync(file, Buffer.concat([source.init, fragment.data]));
        const info = describe(file);
        assert.match(info, /Video: h264/);
        assert.ok(!/Audio:/.test(info));
    } finally {
        source.end('test over');
        fake.stop();
    }
}));

test('when the camera\'s audio stops, the video fragments keep coming', { timeout: 60000 }, () => withDir(async () => {
    // audio for the first second of video only, e.g. someone starts talking through the camera from the SimpliSafe app
    const fake = fakeCamera(10, { audioSeconds: 2 });
    const source = new LiveKitRecordingSource({ name: 'Back Yard', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        acquire: () => ({ source: fake.camera, ready: Promise.resolve() }),
        release: () => {},
    });
    source.start();
    await fake.start();
    try {
        // a keyframe every 2s: without the pause the fragments come about 2s apart, ffmpeg's default
        // would hold them back up to 10s
        const fragments = await collect(source, { fragments: 3, timeout: 12000 });
        const gaps = fragments.slice(1).map((fragment, i) => fragment.at - fragments[i].at);
        assert.ok(gaps.every((gap) => gap < 4000), `fragments ${gaps.join(', ')} ms apart`);
    } finally {
        source.end('test over');
        fake.stop();
    }
}));

// AAC samples in a fragment's audio track (track 2: video is mapped first)
function audioSamples(fragment) {
    let count = 0;
    const within = (start, end, visit) => {
        for (let offset = start; offset + 8 <= end;) {
            const size = fragment.readUInt32BE(offset);
            visit(fragment.toString('latin1', offset + 4, offset + 8), offset + 8, offset + size);
            offset += size;
        }
    };
    within(0, fragment.length, (type, start, end) => type === 'moof' && within(start, end, (type, start, end) => {
        if (type !== 'traf') return;
        let track = 0;
        within(start, end, (type, start) => {
            if (type === 'tfhd') track = fragment.readUInt32BE(start + 4);
            if (type === 'trun' && track === 2) count += fragment.readUInt32BE(start + 4);
        });
    }));
    return count;
}

test('once \'Record Audio\' is turned off during a recording, the fragments that follow have no audio and keep coming', { timeout: 60000 }, () => withDir(async () => {
    const fake = fakeCamera(12);
    const source = new LiveKitRecordingSource({ name: 'Back Yard', log, debug: false, ffmpegPath: ffmpeg, audio: true }, {
        acquire: () => ({ source: fake.camera, ready: Promise.resolve() }),
        release: () => {},
    });
    source.start();
    await fake.start();
    try {
        const [before] = await collect(source, { fragments: 1 });
        assert.ok(audioSamples(before.data) > 0);
        assert.equal(source.stopAudio(), true);
        const after = await collect(source, { fragments: 3, timeout: 12000 });
        // the first may still hold the audio from before, ffmpeg holds up to a second of it back
        assert.deepEqual(after.slice(1).map((f) => audioSamples(f.data)), [0, 0]);
        const gaps = after.map((fragment, i) => fragment.at - (i ? after[i - 1] : before).at);
        assert.ok(gaps.every((gap) => gap < 4000), `fragments ${gaps.join(', ')} ms apart`);
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

test('looking for ffmpeg\'s ports closes every socket it opened, also those that found the port taken', async () => {
    const bindTo = (port) => new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => { socket.close(); resolve(null); });
        socket.bind(port, '127.0.0.1', () => resolve(socket));
    });
    // ports held by something else: an even one for the first try's RTP, an odd one for the second try's RTCP
    const held = [];
    while (held.length < 2) {
        const port = 20000 + 2 * Math.floor(Math.random() * 20000) + held.length;
        if (held.length && port - 1 === held[0].address().port) continue;
        const socket = await bindTo(port);
        if (socket) held.push(socket);
    }
    const tries = held.map((socket, i) => ((socket.address().port - i - 20000) / 2 + 0.5) / 20000);
    const random = Math.random;
    const createSocket = dgram.createSocket;
    let opened = 0;
    let closed = 0;
    Math.random = () => (tries.length ? tries.shift() : random());
    dgram.createSocket = (...args) => {
        const socket = createSocket(...args);
        opened++;
        socket.once('close', () => closed++);
        return socket;
    };
    try {
        const source = new LiveKitRecordingSource({ name: 'Backyard', log, ffmpegPath: ffmpeg }, { acquire() {}, release() {} });
        source.ended = true; // stops once it has the ports, without starting ffmpeg
        await source.startFfmpeg();
    } finally {
        Math.random = random;
        dgram.createSocket = createSocket;
        held.forEach((socket) => socket.close());
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(opened >= 6, `${opened} sockets`);
    assert.equal(closed, opened);
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
