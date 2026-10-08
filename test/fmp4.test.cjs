const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const Mp4Fragmenter = require('../dist/lib/fmp4').default;
const ffmpeg = require('ffmpeg-for-homebridge');

// 6s of 1080p20 H.264 with a keyframe every 2s and AAC-LC 16 kHz mono, as fragmented MP4
function sampleMp4() {
    const run = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
        '-t', '6', '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '40', '-bf', '0', '-c:a', 'aac', '-ac', '1',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
    ], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr && run.stderr.toString());
    return run.stdout;
}

const boxTypes = (buffer) => {
    const types = [];
    for (let offset = 0; offset < buffer.length;) {
        const size = buffer.readUInt32BE(offset);
        types.push(buffer.toString('latin1', offset + 4, offset + 8));
        offset += size;
    }
    return types;
};

test('ffmpeg\'s fragmented MP4 is split into one init segment and moof+mdat fragments, whatever the chunk sizes', () => {
    const mp4 = sampleMp4();
    const fragmenter = new Mp4Fragmenter();
    const segments = [];
    for (let offset = 0, i = 0; offset < mp4.length; i++) {
        const size = [1, 7, 333, 4096, 65536][i % 5];
        segments.push(...fragmenter.push(mp4.subarray(offset, offset + size)));
        offset += size;
    }

    assert.equal(segments[0].type, 'init');
    assert.deepEqual(boxTypes(segments[0].data), ['ftyp', 'moov']);
    const fragments = segments.slice(1);
    assert.ok(fragments.length >= 3, `expected a fragment per keyframe, got ${fragments.length}`);
    for (const fragment of fragments) {
        assert.equal(fragment.type, 'fragment');
        assert.deepEqual(boxTypes(fragment.data), ['moof', 'mdat']);
    }
    // only ffmpeg's closing index (mfra), which HomeKit does not use, is left out
    const types = boxTypes(mp4);
    assert.equal(types[types.length - 1], 'mfra');
    const mfraSize = mp4.readUInt32BE(mp4.length - 4);
    assert.ok(Buffer.concat(segments.map((s) => s.data)).equals(mp4.subarray(0, mp4.length - mfraSize)), 'nothing else lost or duplicated');
});

test('broken input is reported rather than buffered forever', () => {
    const fragmenter = new Mp4Fragmenter({ maxBoxSize: 1024 });
    const huge = Buffer.alloc(16);
    huge.writeUInt32BE(10 * 1024 * 1024, 0);
    huge.write('mdat', 4, 'latin1');
    assert.throws(() => fragmenter.push(huge), /larger than expected/);

    const unsized = Buffer.alloc(8);
    unsized.write('moov', 4, 'latin1');
    assert.throws(() => new Mp4Fragmenter().push(unsized), /not fragmented/);
});
