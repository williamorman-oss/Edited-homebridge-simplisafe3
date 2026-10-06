const test = require('node:test');
const assert = require('node:assert/strict');

const {
    word, cameraCapabilities, eventShape, eventClip, eventTime, opusPacketDuration, simplisafeUrl, ffmpegStreams,
} = require('../dist/lib/diagnosticLines');
const { redact } = require('../dist/lib/diagnosticLog');

// planted identifiers, none may appear in any line
const ids = {
    uuid: 'e15534806fb14446be20a948f11a9cfb', uid: 2085199, sid: 7654321, serial: 'f11a9cfb', account: 'abcdef12',
    wifiSsid: 'Smith Family 5G', mac: 'a4:da:22:3f:01:9c', userId: 4433221, eventUuid: 'deadbeef-event-uuid',
};
const assertClean = (line) => {
    for (const value of Object.values(ids)) assert.ok(!line.includes(String(value)), `${value} leaked into: ${line}`);
    assert.ok(!/https?:/.test(line), `a link leaked into: ${line}`);
};

function cameraDetails() {
    return {
        model: 'SSOBCM4', uuid: ids.uuid, uid: ids.uid, sid: ids.sid, serial: ids.serial,
        cameraSettings: {
            cameraName: 'Back Yard', pictureQuality: '1080p', nightVision: 'auto', statusLight: 'on', micEnable: true, speakerVolume: 50,
            privacyEnable: false, shutterOff: 'closedAlarmOnly', shutterHome: 'closedAlarmOnly', shutterAway: 'open', wifiSsid: ids.wifiSsid,
            motion: { enable: { off: true, home: true, away: true } }, spotlight: { enableColorNightMode: true, level: 'medium' },
            admin: { webRTCProvider: 'mist', fps: 20, gopLength: 40, bitRate: 2000, wlanMac: ids.mac, account: ids.account },
        },
        supportedFeatures: { battery: true, wired: false, speaker: true, fullDuplexAudio: true, siren: true, sirenManualControl: false, audioEncodings: ['opus'], granularObjectDetectionTypes: [] },
        currentState: { recordingProvider: 'KVS', batteryCharging: false },
        subscription: { enabled: true, storageDays: 30, sid: ids.sid },
    };
}

test('the capability line says what matters about a camera, short enough for Logs for Claude, without identifiers', () => {
    const line = cameraCapabilities(cameraDetails());

    assert.match(line, /^SSOBCM4: live mist, recording KVS; features speaker,fullDuplexAudio,battery,siren;/);
    assert.match(line, /fps 20, gop 40, bitrate 2000, quality 1080p/);
    assert.match(line, /shutter off\/home\/away closedAlarmOnly\/closedAlarmOnly\/open/);
    assert.match(line, /spotlight medium color; plan on, 30 days$/);
    assert.ok(line.length < 600);
    assertClean(line);
});

test('the capability line copes with missing details and replaces values that are not plain words', () => {
    const line = cameraCapabilities({ model: 'model with spaces 123', cameraSettings: { nightVision: 'auto 5G', statusLight: 42 } });
    assert.match(line, /^\?: live \?, recording \?/);
    assert.match(line, /nightVision \(text\)/);
    assert.equal(word('Camera Detected Motion'), 'Camera Detected Motion');
    assert.equal(word('Back Yard Camera Detected Motion on 12/29/2023'), '(text)');
});

function motionEvent() {
    const href = `https://chronicle.us-east-1.prd.cam.simplisafe.com/v1/recordings/${ids.account}/${ids.sid}/${ids.uuid}/26361666077`;
    return {
        eventUuid: ids.eventUuid, eventTimestamp: 1703882325, eventCid: 1170, sensorType: 17, sensorSerial: ids.serial,
        account: ids.account, userId: ids.userId, sid: ids.sid, messageSubject: 'Camera Detected Motion',
        messageBody: 'Back Yard Camera Detected Motion at 12 Main Street on 12/29/2023', eventType: 'activityCam',
        internal: { dispatcher: 'x', mainCamera: ids.uuid }, videoStartedBy: ids.uuid,
        video: {
            [ids.uuid]: {
                clipId: '26361666077', preroll: 3, postroll: 7, recordingType: 'KVS', status: 'PENDING', account: ids.account, sid: ids.sid,
                _links: { 'snapshot/jpg': { href: `${href}/snapshot{&width}` }, 'playback/hls': { href: `${href}/hls` }, 'download/mp4': { href: `${href}/mp4` } },
            },
        },
    };
}

test('the event shape shows the clip SimpliSafe records and its links by name only', () => {
    const line = eventShape(motionEvent());

    assert.match(line, /clips \[KVS\/PENDING 3s before, 7s after, links snapshot\/jpg\|playback\/hls\|download\/mp4\]/);
    assert.match(line, /subject 'Camera Detected Motion'/);
    assert.match(line, /internal dispatcher,mainCamera/);
    assert.ok(!line.includes('Main Street'));
    assertClean(line);
    assert.equal(eventClip(motionEvent()).preroll, 3);
    assert.equal(eventClip({}), null);
});

test('event times are read in seconds or milliseconds', () => {
    assert.equal(eventTime({ eventTimestamp: 1703882325 }), 1703882325000);
    assert.equal(eventTime({ eventTimestamp: 1791314093567 }), 1791314093567);
    assert.equal(eventTime({}), null);
});

test('Opus packet length is read from the TOC byte', () => {
    assert.equal(opusPacketDuration(Buffer.from([0xfc, 0])), 20);           // CELT FB 20 ms, one frame
    assert.equal(opusPacketDuration(Buffer.from([0x78 | 1, 0])), 40);       // SILK 20 ms, two frames
    assert.equal(opusPacketDuration(Buffer.from([0xfc | 3, 3])), 60);       // three 20 ms frames
    assert.equal(opusPacketDuration(Buffer.alloc(0)), null);
});

test('the access token is only ever sent to SimpliSafe over https', () => {
    assert.equal(simplisafeUrl('https://chronicle.us-east-1.prd.cam.simplisafe.com/v1/x/snapshot{&width}'), 'https://chronicle.us-east-1.prd.cam.simplisafe.com/v1/x/snapshot');
    assert.equal(simplisafeUrl('https://simplisafe.com/x'), 'https://simplisafe.com/x');
    for (const href of ['http://media.simplisafe.com/x', 'https://simplisafe.com.evil.example/x', 'https://evilsimplisafe.com/x', 'https://example.com/?simplisafe.com', 'not a link', undefined]) {
        assert.equal(simplisafeUrl(href), null, String(href));
    }
});

test('ffmpeg stream descriptions keep codecs and drop links', () => {
    const stderr = "Input #0, hls, from 'https://chronicle.simplisafe.com/v1/abcdef12/7654321/x.m3u8':\n  Stream #0:0: Video: h264 (Main), yuvj420p(pc), 1920x1080, 20 fps\n  Stream #0:1(und): Audio: aac (LC), 16000 Hz, mono, fltp https://x.simplisafe.com/7654321\n";
    const streams = ffmpegStreams(stderr);
    assert.deepEqual(streams, ['video h264 (Main), yuvj420p(pc), 1920x1080, 20 fps', 'audio aac (LC), 16000 Hz, mono, fltp']);
});

test('every new line also survives redaction unchanged, so nothing relies on it', () => {
    const lines = [cameraCapabilities(cameraDetails()), eventShape(motionEvent())];
    for (const line of lines) assert.equal(redact(line), line);
});

test('ffmpeg stream descriptions come from the input only, not repeated for the output', () => {
    const stderr = [
        "Input #0, mpegts, from 'pipe:0':",
        '  Stream #0:0[0x100]: Video: h264 (Main), yuv420p, 1920x1080, 20 fps',
        '  Stream #0:1[0x101]: Audio: aac (LC), 16000 Hz, mono',
        'Stream mapping:',
        '  Stream #0:0 -> #0:0 (copy)',
        "Output #0, null, to 'pipe:':",
        '  Stream #0:0: Video: h264 (Main), yuv420p, 1920x1080, q=2-31, 20 fps',
        '  Stream #0:1: Audio: aac (LC), 16000 Hz, mono',
    ].join('\n');
    assert.deepEqual(ffmpegStreams(stderr), ['video h264 (Main), yuv420p, 1920x1080, 20 fps', 'audio aac (LC), 16000 Hz, mono']);
});

test('a camera\'s video track lists the qualities a viewer could choose between', () => {
    const p = require('@livekit/protocol');
    const { participants } = require('../dist/lib/diagnosticLines');
    const line = participants([new p.ParticipantInfo({ identity: 'camera-x', state: p.ParticipantInfo_State.ACTIVE, isPublisher: true, tracks: [
        new p.TrackInfo({ type: p.TrackType.VIDEO, source: p.TrackSource.CAMERA, mimeType: 'video/H264', simulcast: true, layers: [
            new p.VideoLayer({ quality: p.VideoQuality.LOW, width: 480, height: 270, bitrate: 150000, ssrc: 1234567 }),
            new p.VideoLayer({ quality: p.VideoQuality.HIGH, width: 1920, height: 1080, bitrate: 2000000 }),
        ] }),
        new p.TrackInfo({ type: p.TrackType.AUDIO, source: p.TrackSource.MICROPHONE, mimeType: 'audio/opus' }),
    ] })]);

    assert.equal(line, 'STANDARD/ACTIVE publisher [VIDEO/CAMERA video/H264 simulcast layers LOW 480x270 150kbps/HIGH 1920x1080 2000kbps, AUDIO/MICROPHONE audio/opus]');
    assert.ok(!line.includes('1234567') && !line.includes('camera-x'));
});
