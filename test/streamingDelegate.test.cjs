const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const StreamingDelegate = require('../dist/lib/streamingDelegate').default;

function createApiStub() {
    class CameraController {
        constructor(config) {
            this.delegate = config.delegate;
            this.streamingOptions = config.streamingOptions;
        }
    }

    return {
        hap: {
            SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 'suite' },
            H264Profile: { BASELINE: 'baseline', MAIN: 'main', HIGH: 'high' },
            H264Level: { LEVEL3_1: '3.1', LEVEL3_2: '3.2', LEVEL4_0: '4.0' },
            AudioStreamingCodecType: { AAC_ELD: 'AAC_ELD' },
            AudioStreamingSamplerate: { KHZ_16: 16 },
            CameraController,
            uuid: { unparse: (value) => `uuid:${value}` },
        },
    };
}

// Stands in for LiveKitSource: connect() resolves or rejects when the test says so
class FakeLiveKitSource extends EventEmitter {
    constructor() {
        super();
        this.closed = false;
        this.streaming = false;
        this.keyframeRequests = 0;
        this.ready = new Promise((resolve, reject) => { this.connected = resolve; this.failed = reject; });
    }

    connect() { return this.ready; }

    close() {
        this.closed = true;
        this.streaming = false;
        this.removeAllListeners();
    }

    requestKeyframe() { this.keyframeRequests++; return true; }

    timeoutMessage(ms) { return `Timed out after ${ms / 1000}s`; }

    // a keyframe as RTP: SPS, PPS and an IDR slice sharing a timestamp
    sendKeyframe(timestamp = 1000) {
        [[0x67, 1], [0x68, 2], [0x65, 3]].forEach((payload, i) => {
            this.emit('video', { payload: Buffer.from(payload), header: { timestamp, marker: i === 2, sequenceNumber: i, ssrc: 42 } });
        });
    }
}

function useFakeLiveKit(delegate) {
    const created = [];
    delegate.createLiveKitSource = () => {
        const source = new FakeLiveKitSource();
        created.push(source);
        return source;
    };
    return created;
}

function liveKitStreamRequest(sessionID) {
    return {
        targetAddress: '192.168.1.5',
        sessionID,
        video: { port: 5010, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
        audio: { port: 5011, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
    };
}

async function startLiveView(delegate, sessionID) {
    delegate.prepareStream(liveKitStreamRequest(sessionID), () => {});
    let args;
    await delegate.handleStreamRequest({
        sessionID,
        type: 'start',
        video: { width: 1280, height: 720, fps: 20, max_bit_rate: 299 },
        audio: { codec: 'OPUS', sample_rate: 24 },
    }, (...a) => { args = a; });
    return args;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createCameraStub(overrides = {}) {
    return {
        simplisafe: { isBlocked: false, nextAttempt: 0, getCurrentAlarmState: async () => 'OFF' },
        log: (() => {
            const fn = () => {};
            fn.error = () => {};
            return fn;
        })(),
        api: createApiStub(),
        cameraOptions: null,
        cameraDetails: {
            uuid: 'camera-uuid',
            cameraSettings: {
                admin: { fps: 20, bitRate: 300 },
                pictureQuality: '720p',
                cameraName: 'Garage Camera',
            },
        },
        debug: false,
        name: 'Garage Camera',
        authManager: { accessToken: 'token-123' },
        isUnsupported: () => false,
        getStreamProvider: () => 'legacy',
        supportsPrivacyShutter: () => false,
        isBatteryPowered: () => false,
        isCharging: () => false,
        motionIsTriggered: false,
        lastEventAt: 0,
        ...overrides,
    };
}

test('constructor limits advertised resolutions to the configured picture quality', () => {
    const delegate = new StreamingDelegate(createCameraStub());
    const heights = delegate.controller.streamingOptions.video.resolutions.map((resolution) => resolution[1]);

    assert.ok(heights.every((height) => height <= 720));
    assert.ok(heights.includes(720));
    assert.ok(!heights.includes(1080));
});

test('constructor offers square resolutions for 1:1 cameras', () => {
    const square = new StreamingDelegate(createCameraStub({
        cameraDetails: {
            uuid: 'camera-uuid',
            supportedFeatures: { aspectRatio: '1:1' },
            cameraSettings: { admin: { fps: 20, bitRate: 300 }, pictureQuality: '1536p', cameraName: 'Front Door' },
        },
    }));
    const wide = new StreamingDelegate(createCameraStub());

    const isSquare = (r) => r[0] === r[1];
    assert.ok(square.controller.streamingOptions.video.resolutions.some(isSquare));
    assert.ok(!wide.controller.streamingOptions.video.resolutions.some(isSquare));
});

const requestSnapshot = (delegate, request = { width: 1280, height: 720 }) => new Promise((resolve) => {
    delegate.handleSnapshotRequest(request, (...a) => resolve(a));
});

test('snapshot requests are answered from the cache without waiting on the camera', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    let fetched = 0;
    delegate.warmSnapshot = async () => { fetched++; return Buffer.from('new'); };
    const cached = Buffer.from('jpeg-bytes');
    delegate.snapshots.set(cached);

    const args = await requestSnapshot(delegate);

    assert.equal(args[0], undefined);
    assert.equal(args[1], cached);
    assert.equal(fetched, 0);
});

test('a stale snapshot is served at once and refreshed in the background', async () => {
    const delegate = new StreamingDelegate(createCameraStub());
    delegate.fetchLegacySnapshot = async () => Buffer.from('new');
    delegate.snapshots.set(Buffer.from('old'), Date.now() - 20000);

    const args = await requestSnapshot(delegate);
    assert.equal(args[1].toString(), 'old');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delegate.snapshots.image.toString(), 'new');
});

test('a notification snapshot waits for a new image unless the cached one is only seconds old', async () => {
    const delegate = new StreamingDelegate(createCameraStub());
    let fetched = 0;
    delegate.fetchLegacySnapshot = () => new Promise((resolve) => setTimeout(() => resolve(Buffer.from(`new-${++fetched}`)), 20));
    delegate.snapshots.set(Buffer.from('cached'), Date.now() - 20000);

    const args = await requestSnapshot(delegate, { width: 1280, height: 720, reason: 1 });
    assert.equal(args[1].toString(), 'new-1');

    const again = await requestSnapshot(delegate, { width: 1280, height: 720, reason: 1 });
    assert.equal(again[1].toString(), 'new-1');
    assert.equal(fetched, 1);
});

test('after motion only an image taken after it is served, then without asking again', async () => {
    const motionAt = Date.now();
    const delegate = new StreamingDelegate(createCameraStub({ lastEventAt: motionAt }));
    let fetched = 0;
    delegate.fetchLegacySnapshot = async () => { fetched++; return Buffer.from('new'); };
    delegate.snapshots.set(Buffer.from('cached'), motionAt - 1000);

    const first = await requestSnapshot(delegate);
    assert.equal(first[1].toString(), 'new');

    const second = await requestSnapshot(delegate);
    assert.equal(second[1].toString(), 'new');
    assert.equal(fetched, 1, 'the image is already newer than the motion');
});

test('a camera that keeps failing shows the unavailable placeholder instead of an old image', async () => {
    const delegate = new StreamingDelegate(createCameraStub());
    delegate.fetchLegacySnapshot = async () => { throw new Error('offline'); };
    delegate.snapshots.set(Buffer.from('old'), Date.now() - 60 * 60000);
    delegate.snapshots.failures = 2;

    const args = await requestSnapshot(delegate);
    assert.notEqual(args[1].toString(), 'old');
    assert.ok(args[1].length > 1000);
});

test('failing battery cameras are retried less often than powered ones', () => {
    const backoffMax = (overrides) => new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit', ...overrides })).snapshots.options.backoffMax();

    assert.equal(backoffMax({}), 2 * 60000);
    assert.equal(backoffMax({ isBatteryPowered: () => true }), 30 * 60000);
    assert.equal(backoffMax({ isBatteryPowered: () => true, isCharging: () => true }), 2 * 60000);
});

test('snapshots of cameras with a privacy shutter are never written to disk', () => {
    const indoor = new StreamingDelegate(createCameraStub({ supportsPrivacyShutter: () => true, snapshotPath: '/tmp/indoor.jpg' }));
    const outdoor = new StreamingDelegate(createCameraStub({ snapshotPath: '/tmp/outdoor.jpg' }));

    assert.equal(indoor.snapshots.options.persistPath, undefined);
    assert.equal(outdoor.snapshots.options.persistPath, '/tmp/outdoor.jpg');
});

test('a camera that cannot be reached gets a placeholder rather than holding up HomeKit', async () => {
    const delegate = new StreamingDelegate(createCameraStub());
    delegate.fetchLegacySnapshot = async () => { throw new Error('offline'); };

    const args = await requestSnapshot(delegate);

    assert.equal(args[0], undefined);
    assert.ok(Buffer.isBuffer(args[1]) && args[1].length > 0);
    assert.equal(delegate.snapshots.failing, true);
});

test('nothing is fetched while rate limited, a cached image is still served', async () => {
    const delegate = new StreamingDelegate(createCameraStub({
        simplisafe: { isBlocked: true, nextAttempt: Date.now() + 60000 },
    }));
    let fetched = 0;
    delegate.fetchLegacySnapshot = async () => { fetched++; return Buffer.from('new'); };
    delegate.snapshots.set(Buffer.from('old'), Date.now() - 60000);

    const args = await requestSnapshot(delegate);

    assert.equal(args[1].toString(), 'old');
    assert.equal(fetched, 0);
});

test('privacy shutter state follows the alarm state without blocking on errors', async () => {
    const shutterSettings = { shutterOff: 'closedAlarmOnly', shutterHome: 'open', shutterAway: 'open' };
    const make = (getCurrentAlarmState) => {
        const delegate = new StreamingDelegate(createCameraStub({
            supportsPrivacyShutter: () => true,
            simplisafe: { isBlocked: false, nextAttempt: 0, getCurrentAlarmState },
            cameraDetails: {
                uuid: 'camera-uuid',
                cameraSettings: { admin: { fps: 20, bitRate: 300 }, pictureQuality: '720p', cameraName: 'Indoor', ...shutterSettings },
            },
        }));
        delegate.snapshots.set(Buffer.from('real-image'));
        return delegate;
    };

    const closed = await requestSnapshot(make(async () => 'OFF'));
    assert.notEqual(closed[1].toString(), 'real-image');

    const open = await requestSnapshot(make(async () => 'HOME'));
    assert.equal(open[1].toString(), 'real-image');

    const unknown = await requestSnapshot(make(async () => null));
    assert.notEqual(unknown[1].toString(), 'real-image', 'an unknown alarm state must not show the camera');

    // exit delay from OFF (closed) to AWAY (open): closed until armed
    const exitDelay = await requestSnapshot(make(async () => 'AWAY_COUNT'));
    assert.notEqual(exitDelay[1].toString(), 'real-image');

    const unexpected = await requestSnapshot(make(async () => 'SOMETHING_NEW'));
    assert.notEqual(unexpected[1].toString(), 'real-image');

    const failed = await requestSnapshot(make(async () => { throw new Error('api down'); }));
    assert.ok(failed[0] instanceof Error, 'errors must reach HomeKit instead of leaving it waiting');
});

test('battery cameras refresh their snapshot less often unless charging', () => {
    const age = (overrides) => new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit', ...overrides })).snapshotRefreshAge();

    assert.equal(new StreamingDelegate(createCameraStub()).snapshotRefreshAge(), 10000);
    assert.equal(age({}), 60000);
    assert.equal(age({ isBatteryPowered: () => true }), 10 * 60000);
    assert.equal(age({ isBatteryPowered: () => true, isCharging: () => true }), 60000);
    assert.equal(age({ isBatteryPowered: () => true, cameraOptions: { batterySnapshotMinutes: 3 } }), 3 * 60000);
});

test('legacy live view starts without -re and with low-latency input options', () => {
    const delegate = new StreamingDelegate(createCameraStub());
    delegate.serverIpAddress = '1.2.3.4';
    const sessionInfo = {
        address: '192.168.1.5',
        video_port: 5010,
        audio_port: 5011,
        video_ssrc: 1,
        audio_ssrc: 2,
        video_srtp: Buffer.alloc(30),
        audio_srtp: Buffer.alloc(30),
    };
    const request = { video: { width: 1280, fps: 20, max_bit_rate: 299, mtu: 1378 }, audio: { codec: 'AAC-eld', max_bit_rate: 24, sample_rate: 16 } };

    const { source, video, audio } = delegate.buildLegacyStreamArgs(request, sessionInfo);

    assert.ok(!source.includes('-re'));
    const input = source.indexOf('-i');
    for (const flag of ['-fpsprobesize', '-flags']) {
        assert.ok(source.indexOf(flag) > -1 && source.indexOf(flag) < input, `${flag} must be an input option`);
    }
    assert.ok(!source.includes('-analyzeduration'), 'a short analyzeduration loses an audio track that starts late');
    assert.equal(video[video.indexOf('-map') + 1], '0:v:0');
    assert.equal(audio[audio.indexOf('-map') + 1], '0:a:0');
    assert.equal(video[video.indexOf('-g') + 1], '40');
    assert.ok(video.at(-1).startsWith('srtp://') && audio.at(-1).startsWith('srtp://'));
});

test('legacy live view applies user options in the right place', () => {
    const delegate = new StreamingDelegate(createCameraStub({
        cameraOptions: { sourceOptions: '-re -analyzeduration 500000', videoOptions: '-tune false -crf 23', audioOptions: '-ac 2' },
    }));
    delegate.serverIpAddress = '1.2.3.4';
    const sessionInfo = { address: 'a', video_port: 1, audio_port: 2, video_ssrc: 1, audio_ssrc: 2, video_srtp: Buffer.alloc(30), audio_srtp: Buffer.alloc(30) };
    const request = { video: { width: 1280, fps: 20, max_bit_rate: 299 }, audio: { codec: 'OPUS' } };

    const { source, video, audio } = delegate.buildLegacyStreamArgs(request, sessionInfo);

    assert.ok(source.indexOf('-re') > -1 && source.indexOf('-re') < source.indexOf('-i'));
    assert.equal(source[source.indexOf('-analyzeduration') + 1], '500000');
    assert.ok(!video.includes('-tune'));
    assert.ok(video.indexOf('-crf') > -1 && video.indexOf('-crf') < video.length - 1);
    assert.equal(audio[audio.indexOf('-ac') + 1], '2');
    assert.equal(audio[audio.indexOf('-acodec') + 1], 'libopus');
    assert.ok(!source.at(-1).includes('audioEncoding=AAC'));
});

test('stopLiveKitStream is a no-op for an unknown session', () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    assert.doesNotThrow(() => delegate.stopLiveKitStream('uuid:missing'));
});

test('prepareStream records pending session details for audio and video', () => {
    const delegate = new StreamingDelegate(createCameraStub());
    let callbackArgs;

    delegate.prepareStream({
        targetAddress: '192.168.1.5',
        sessionID: 'session-1',
        video: {
            port: 5010,
            srtp_key: Buffer.from('1234567890123456'),
            srtp_salt: Buffer.from('12345678901234'),
        },
        audio: {
            port: 5011,
            srtp_key: Buffer.from('abcdefghijklmnop'),
            srtp_salt: Buffer.from('abcdefghijklmn'),
        },
    }, (...args) => {
        callbackArgs = args;
    });

    const [, response] = callbackArgs;
    const session = delegate.pendingSessions['uuid:session-1'];

    assert.equal(response.video.port, 5010);
    assert.equal(response.audio.port, 5011);
    assert.equal(typeof response.video.ssrc, 'number');
    assert.equal(typeof response.audio.ssrc, 'number');
    assert.equal(session.address, '192.168.1.5');
    assert.equal(session.video_port, 5010);
    assert.equal(session.audio_port, 5011);
    assert.equal(session.video_srtp.length, 30);
    assert.equal(session.audio_srtp.length, 30);
});

test('handleUnsupportedCameraSnapshotRequest returns the static unsupported image', () => {
    const delegate = new StreamingDelegate(createCameraStub({
        isUnsupported: () => true,
    }));

    delegate.handleUnsupportedCameraSnapshotRequest((err, image) => {
        assert.equal(err, undefined);
        assert.ok(Buffer.isBuffer(image));
        assert.ok(image.length > 0);
    });
});

test('handlePrivacyShutterClosedSnapshotRequest returns the static privacy image', () => {
    const delegate = new StreamingDelegate(createCameraStub());

    delegate.handlePrivacyShutterClosedSnapshotRequest((err, image) => {
        assert.equal(err, undefined);
        assert.ok(Buffer.isBuffer(image));
        assert.ok(image.length > 0);
    });
});

test('handleStreamRequest acknowledges a reconfigure request', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));

    const args = await new Promise((resolve) => {
        delegate.handleStreamRequest({ type: 'reconfigure', sessionID: 'session-9' }, (...a) => resolve(a));
    });

    assert.equal(args[0], undefined);
});

test('livekit snapshots are not refreshed by joining again while a live view is running', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    let joined = 0;
    delegate.warmSnapshot = async () => { joined++; return Buffer.from('new'); };
    const stale = Buffer.from('stale-jpeg');
    delegate.snapshots.set(stale, Date.now() - 120000);   // expired
    delegate.liveKitSessions['uuid:active'] = {};          // a stream is running

    const args = await requestSnapshot(delegate);

    assert.equal(args[0], undefined);
    assert.equal(args[1], stale);
    assert.equal(joined, 0);                               // no second room was opened
});

test('a running live view keeps the snapshot current', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    delegate.jpegFromKeyframe = async () => Buffer.from('from-stream');
    delegate.snapshots.set(Buffer.from('old'), Date.now() - 30000);
    let reset = false;

    delegate.cacheSnapshotFromStream({ annexB: () => Buffer.from('keyframe'), reset: () => { reset = true; } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reset, true);
    assert.equal(delegate.snapshots.image.toString(), 'from-stream');
});

test('startLiveKitStream reports setup failures instead of leaving HAP hanging', () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    const sessionInfo = {
        address: '192.168.1.5',
        video_port: 5010,
        video_srtp: undefined,                             // makes createSrtpSession throw
        liveKit: delegate.acquireLiveKitSource(),
    };

    let callbackArgs;
    delegate.startLiveKitStream({ sessionID: 'x', audio: {} }, 'uuid:x', sessionInfo, (...a) => { callbackArgs = a; });

    assert.ok(callbackArgs, 'callback must always be called');
    assert.ok(callbackArgs[0] instanceof Error);
    assert.equal(created[0].closed, true, 'the pre-warmed source must be closed');
    assert.equal(delegate.liveKitShared, null);
});

test('a failed ffmpeg start answers HomeKit exactly once', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ ffmpegPath: '/nonexistent/ffmpeg' }));
    delegate.resolveMediaServer = async () => '1.2.3.4';
    delegate.pendingSessions['uuid:session-1'] = {
        address: '192.168.1.5', video_port: 5010, audio_port: 5011, video_ssrc: 1, audio_ssrc: 2,
        video_srtp: Buffer.alloc(30), audio_srtp: Buffer.alloc(30),
    };

    const calls = [];
    await delegate.handleStreamRequest({
        sessionID: 'session-1',
        type: 'start',
        video: { width: 1280, fps: 20, max_bit_rate: 299, mtu: 1378 },
        audio: { codec: 'AAC-eld', max_bit_rate: 24, sample_rate: 16 },
    }, (...args) => calls.push(args));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(calls.length, 1);
    assert.ok(calls[0][0] instanceof Error);
});

test('stream requests are logged in one line, without the stream keys', async () => {
    const lines = [];
    const log = (...args) => lines.push(args.map(String).join(' '));
    log.error = log;
    const delegate = new StreamingDelegate(createCameraStub({ debug: true, log, getStreamProvider: () => 'legacy' }));

    delegate.prepareStream({
        targetAddress: '192.168.1.5',
        sessionID: 'session-1',
        video: { port: 5010, srtp_key: Buffer.from('1234567890123456'), srtp_salt: Buffer.from('12345678901234') },
        audio: { port: 5011, srtp_key: Buffer.from('abcdefghijklmnop'), srtp_salt: Buffer.from('abcdefghijklmn') },
    }, () => {});
    await delegate.handleStreamRequest({ sessionID: 'session-2', type: 'stop' }, () => {});

    assert.ok(lines.some((line) => line === "Prepare stream for 'Garage Camera' to 192.168.1.5"));
    assert.ok(lines.some((line) => line === "Stream stop for 'Garage Camera'"));
    assert.ok(!lines.join('\n').includes('srtp'));
    assert.ok(!lines.join('\n').includes('1234567890'));
});

test('a live view opened while a snapshot is being taken shares its connection', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    delegate.jpegFromKeyframe = async () => Buffer.from('jpeg');
    const forwarded = [];
    delegate.forwardRtp = (rtp, srtp, socket, payloadType, ssrc) => forwarded.push(ssrc);

    const snapshot = delegate.warmSnapshot();             // wakes the camera
    const started = await startLiveView(delegate, 'live-1');

    assert.equal(started[0], undefined);
    assert.equal(created.length, 1, 'the live view joins the snapshot\'s connection');
    const source = created[0];

    source.streaming = true;
    source.connected();
    await tick();
    source.sendKeyframe();

    assert.equal((await snapshot).toString(), 'jpeg');
    assert.equal(forwarded.length, 3, 'the same packets reach the live view');
    assert.equal(source.closed, false, 'the live view still uses the connection');

    await delegate.handleStreamRequest({ sessionID: 'live-1', type: 'stop' }, () => {});
    assert.equal(source.closed, true, 'closed as soon as nobody uses it');
    assert.equal(delegate.liveKitShared, null);
});

test('a second viewer joins a running stream and asks for a keyframe', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    delegate.forwardRtp = () => {};

    await startLiveView(delegate, 'phone');
    const source = created[0];
    source.streaming = true;
    source.connected();
    await tick();
    assert.equal(source.keyframeRequests, 0, 'a new connection starts with a keyframe anyway');

    await startLiveView(delegate, 'tablet');
    assert.equal(created.length, 1);
    assert.equal(source.keyframeRequests, 1);

    await delegate.handleStreamRequest({ sessionID: 'phone', type: 'stop' }, () => {});
    assert.equal(source.closed, false);
    assert.equal(source.listenerCount('video'), 1, 'only the stopped viewer stops receiving');

    await delegate.handleStreamRequest({ sessionID: 'tablet', type: 'stop' }, () => {});
    assert.equal(source.closed, true);
});

test('a dropped connection stops every live view on it and the next one reconnects', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    delegate.forwardRtp = () => {};
    const forceStopped = [];
    delegate.controller.forceStopStreamingSession = (id) => forceStopped.push(id);

    await startLiveView(delegate, 'phone');
    await startLiveView(delegate, 'tablet');
    const source = created[0];
    source.streaming = true;
    source.connected();
    await tick();

    // what LiveKitSource does when the room goes away under a running stream
    const listeners = source.listeners('ended');
    source.close();
    listeners.forEach((listener) => listener('signalling closed'));

    assert.deepEqual(forceStopped.sort(), ['phone', 'tablet']);
    assert.deepEqual(Object.keys(delegate.liveKitSessions), []);
    assert.equal(delegate.liveKitShared, null);

    delegate.acquireLiveKitSource();
    assert.equal(created.length, 2, 'a closed connection is never reused');
});

test('a failed join is not reused and HomeKit is told the stream stopped', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    const forceStopped = [];
    delegate.controller.forceStopStreamingSession = (id) => forceStopped.push(id);

    await startLiveView(delegate, 'phone');
    created[0].failed(new Error('Timed out after 30s waiting for video'));
    await tick();

    assert.equal(created[0].closed, true);
    assert.deepEqual(forceStopped, ['phone']);
    assert.equal(delegate.liveKitShared, null);

    delegate.acquireLiveKitSource();
    assert.equal(created.length, 2);
});

test('a snapshot that gives up does not close the connection a live view is waiting on', async () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);
    delegate.forwardRtp = () => {};

    const lease = delegate.acquireLiveKitSource();         // as warmSnapshot does
    await startLiveView(delegate, 'phone');
    delegate.releaseLiveKitSource(lease);
    delegate.releaseLiveKitSource(lease);                  // releasing twice counts once

    assert.equal(created[0].closed, false);
    assert.equal(delegate.liveKitShared.users, 1);

    await delegate.handleStreamRequest({ sessionID: 'phone', type: 'stop' }, () => {});
    assert.equal(created[0].closed, true);
});

test('a live view prepared but never started gives the connection back', () => {
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const created = useFakeLiveKit(delegate);

    const timers = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
    try {
        delegate.prepareStream(liveKitStreamRequest('abandoned'), () => {});
    } finally {
        global.setTimeout = realSetTimeout;
    }
    assert.equal(created[0].closed, false);

    timers.find((timer) => timer.ms === 20000).fn();       // HomeKit never sent 'start'
    assert.equal(created[0].closed, true);
    assert.deepEqual(delegate.pendingSessions, {});
});

test('forwarding re-stamps a copy, the packet other viewers get is unchanged', () => {
    const { RtpHeader } = require('werift');
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const header = new RtpHeader({ payloadType: 96, ssrc: 1234, sequenceNumber: 7, timestamp: 90000, marker: true, extension: true, extensions: [{ id: 1, payload: Buffer.from([1]) }] });
    const rtp = { header, payload: Buffer.from([0x65, 1]) };

    let sent;
    delegate.forwardRtp(rtp, { encrypt: (payload, h) => { sent = h; return Buffer.alloc(1); } }, { send: () => {} }, 99, 5555, 5010, '192.168.1.5');

    assert.equal(sent.payloadType, 99);
    assert.equal(sent.ssrc, 5555);
    assert.equal(sent.sequenceNumber, 7);
    assert.equal(sent.marker, true);
    assert.equal(sent.extension, false);
    assert.equal(header.payloadType, 96);
    assert.equal(header.ssrc, 1234);
    assert.equal(header.extension, true);
});

test('padding stripped by werift is not claimed to HomeKit, padding-only probes are not forwarded', () => {
    const { RtpHeader, RtpPacket } = require('werift');
    const delegate = new StreamingDelegate(createCameraStub({ getStreamProvider: () => 'livekit' }));
    const key = Buffer.alloc(30, 7);
    const encrypt = delegate.createSrtpSession(key);
    const decrypt = delegate.createSrtpSession(key);
    const sent = [];
    const socket = { send: (buf) => sent.push(buf) };

    // as LiveKit sends it: 4 bytes of padding, the payload's last byte would read as a padding count
    const padded = RtpPacket.deSerialize(new RtpPacket(new RtpHeader({ payloadType: 96, ssrc: 1, sequenceNumber: 9, padding: true, paddingSize: 4 }), Buffer.from([0x65, 1, 2, 7])).serialize());
    assert.equal(padded.payload.length, 4);
    delegate.forwardRtp(padded, encrypt, socket, 99, 5555, 5010, '192.168.1.5');

    const received = RtpPacket.deSerialize(decrypt.decrypt(sent[0]));
    assert.deepEqual([...received.payload], [0x65, 1, 2, 7]);

    const probe = RtpPacket.deSerialize(new RtpPacket(new RtpHeader({ payloadType: 96, ssrc: 1, sequenceNumber: 10, padding: true, paddingSize: 200 }), Buffer.alloc(0)).serialize());
    delegate.forwardRtp(probe, encrypt, socket, 99, 5555, 5010, '192.168.1.5');
    assert.equal(sent.length, 1);
});
