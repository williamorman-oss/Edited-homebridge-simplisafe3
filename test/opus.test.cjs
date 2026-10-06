const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { opusFrames, opusPacket, opusFrameDuration, OpusRepacker } = require('../dist/lib/opus');
const ffmpeg = require('ffmpeg-for-homebridge');

// --- Ogg Opus, just enough to get real libopus packets in and check that ours decode ---
function oggPackets(file) {
    const b = fs.readFileSync(file);
    const packets = [];
    let current = [];
    for (let o = 0; o < b.length;) {
        assert.equal(b.toString('latin1', o, o + 4), 'OggS');
        const count = b[o + 26];
        let p = o + 27 + count;
        for (const size of b.subarray(o + 27, o + 27 + count)) {
            current.push(b.subarray(p, p + size));
            p += size;
            if (size < 255) { packets.push(Buffer.concat(current)); current = []; }
        }
        o = p;
    }
    return packets;
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    return r >>> 0;
});
function oggPage(packet, { granule, sequence, flags }) {
    const segments = [];
    for (let left = packet.length; ; left -= 255) { segments.push(Math.min(left, 255)); if (left < 255) break; }
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'latin1');
    header[5] = flags;
    header.writeBigInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(1234, 14);
    header.writeUInt32LE(sequence, 18);
    header[26] = segments.length;
    const page = Buffer.concat([header, Buffer.from(segments), packet]);
    let crc = 0;
    for (const byte of page) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    page.writeUInt32LE(crc, 22);
    return page;
}
function writeOgg(file, head, tags, packets) {
    const pages = [oggPage(head, { granule: 0, sequence: 0, flags: 2 }), oggPage(tags, { granule: 0, sequence: 1, flags: 0 })];
    let granule = head.readUInt16LE(10); // pre-skip
    packets.forEach((packet, i) => {
        const parsed = opusFrames(packet);
        granule += parsed.frames.length * opusFrameDuration(parsed.toc) * 48;
        pages.push(oggPage(packet, { granule, sequence: i + 2, flags: i === packets.length - 1 ? 4 : 0 }));
    });
    fs.writeFileSync(file, Buffer.concat(pages));
}

// 3s of a tone as 100 ms Opus packets of five 20 ms frames, like the Outdoor Cameras send
function cameraLikeOpus(dir) {
    const file = path.join(dir, 'camera.ogg');
    const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '3', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-frame_duration', '100', '-f', 'ogg', file]);
    assert.equal(run.status, 0, run.stderr && run.stderr.toString());
    return oggPackets(file);
}

function withDir(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-opus-'));
    try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('every Opus packet layout is split into its frames, and joined back the same', () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([4, 5, 6]);
    const long = Buffer.alloc(300, 7);
    const toc = 0xf8; // CELT fullband 20 ms, mono

    assert.deepEqual(opusFrames(Buffer.from([toc, 1, 2, 3])).frames, [a]);
    assert.deepEqual(opusFrames(Buffer.from([toc | 1, 1, 2, 3, 4, 5, 6])).frames, [a, b]);
    assert.deepEqual(opusFrames(Buffer.concat([Buffer.from([toc | 2, 3]), a, Buffer.from([9, 9])])).frames, [a, Buffer.from([9, 9])]);
    // code 3: CBR, VBR with a two-byte length, and padding
    assert.deepEqual(opusFrames(Buffer.concat([Buffer.from([toc | 3, 2]), a, b])).frames, [a, b]);
    assert.deepEqual(opusFrames(opusPacket(toc, [long, a, b])).frames, [long, a, b]);
    assert.deepEqual(opusFrames(Buffer.concat([Buffer.from([toc | 3, 0x40 | 2, 2]), a, b, Buffer.from([0, 0])])).frames, [a, b]);

    assert.equal(opusFrames(Buffer.from([toc | 3, 0])), null, 'no frames');
    assert.equal(opusFrames(Buffer.from([toc | 3, 7, 1])), null, '7 x 20 ms is more than 120 ms');
    assert.equal(opusFrames(Buffer.from([toc | 1, 1, 2, 3])), null, 'two equal frames need an even length');
    assert.equal(opusFrames(Buffer.alloc(0)), null);
});

test('the camera\'s 100 ms packets become 20 ms packets timed at the 24 kHz HomeKit asked for, frames untouched', () => withDir((dir) => {
    const [head, tags, ...camera] = cameraLikeOpus(dir);
    assert.equal(opusFrames(camera[0]).frames.length, 5, 'libopus packs five 20 ms frames, as the cameras do');

    const repacker = new OpusRepacker({ packetTime: 20, sampleRate: 24 });
    const out = [];
    camera.forEach((payload, i) => out.push(...repacker.push({ header: { timestamp: (4294960000 + i * 4800) >>> 0 }, payload })));

    assert.equal(out.length, camera.length * 5);
    out.forEach((packet, i) => {
        assert.equal(packet.payload[0] & 3, 0, 'one frame per packet');
        assert.equal(packet.timestamp, i * 480, '20 ms at 24 kHz, across the 48 kHz clock wrapping');
        if (i) assert.equal(packet.sequenceNumber, (out[i - 1].sequenceNumber + 1) & 0xffff);
    });
    const framesIn = camera.flatMap((packet) => opusFrames(packet).frames);
    const framesOut = out.flatMap((packet) => opusFrames(packet.payload).frames);
    assert.ok(Buffer.concat(framesIn).equals(Buffer.concat(framesOut)));

    // the re-cut packets decode to the same 3 s of tone
    const file = path.join(dir, 'homekit.ogg');
    writeOgg(file, head, tags, out.map((packet) => packet.payload));
    const decode = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
    const stderr = decode.stderr.toString();
    assert.equal(decode.status, 0, stderr);
    assert.ok(!/Error|Invalid/i.test(stderr.split('Output #0')[0]), stderr);
    const seconds = stderr.match(/time=00:00:(\d+\.\d+)/g).pop().slice(-5);
    assert.ok(Math.abs(Number(seconds) - 3) < 0.15, `decoded ${seconds}s`);
    assert.ok(Number(stderr.match(/mean_volume: (-?\d+\.\d+)/)[1]) > -30, 'the tone is there');
}));

test('HomeKit\'s 60 ms packets over cellular get three frames each', () => withDir((dir) => {
    const [, , ...camera] = cameraLikeOpus(dir);
    const repacker = new OpusRepacker({ packetTime: 60, sampleRate: 16 });
    const out = [];
    camera.forEach((payload, i) => out.push(...repacker.push({ header: { timestamp: i * 4800 }, payload })));

    let framesBefore = 0;
    out.forEach((packet, i) => {
        const { toc, frames } = opusFrames(packet.payload);
        assert.equal(packet.timestamp, framesBefore * 320, 'timestamps at 16 kHz follow the frames');
        // a shorter packet only where libopus switches mode (its first packet differs) or at the end
        if (frames.length !== 3) assert.ok(i === out.length - 1 || opusFrames(out[i + 1].payload).toc !== toc, `packet ${i} has ${frames.length} frames`);
        framesBefore += frames.length;
    });
    assert.ok(framesBefore >= camera.length * 5 - 2, 'at most the last two frames wait for a third');
    assert.ok(out.filter((packet) => opusFrames(packet.payload).frames.length === 3).length >= out.length - 2);
}));

test('a lost packet or a change of Opus mode starts a new packet rather than mixing frames', () => {
    const repacker = new OpusRepacker({ packetTime: 60, sampleRate: 24 });
    const frame = Buffer.from([1, 2]);
    const fb = 0xf8;
    const wb = 0xd8; // CELT wideband 20 ms

    assert.deepEqual(repacker.push({ header: { timestamp: 0 }, payload: opusPacket(fb, [frame, frame]) }), []);
    const lost = repacker.push({ header: { timestamp: 4800 }, payload: opusPacket(fb, [frame]) }); // 40-100 ms missing
    assert.equal(lost.length, 1);
    assert.equal(opusFrames(lost[0].payload).frames.length, 2, 'the two frames before the gap');
    assert.equal(lost[0].timestamp, 0);

    const switched = repacker.push({ header: { timestamp: 5760 }, payload: opusPacket(wb, [frame]) });
    assert.equal(switched.length, 1);
    assert.equal(switched[0].timestamp, 100 * 24, 'the frame after the gap, at 100 ms');
    assert.equal(switched[0].payload[0] >> 3, fb >> 3);

    assert.deepEqual(repacker.push({ header: { timestamp: 6720 }, payload: Buffer.from([0xfb, 9]) }), [], 'invalid packets are dropped');
    assert.equal(repacker.invalid, 1);
});
