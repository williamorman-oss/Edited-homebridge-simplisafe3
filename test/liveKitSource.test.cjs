const test = require('node:test');
const assert = require('node:assert/strict');

const LiveKitSource = require('../dist/lib/liveKitSource').default;

function createCamera(overrides = {}) {
    const log = () => {};
    log.error = () => {};
    return {
        id: 'camera-uuid',
        name: 'Back Yard',
        log,
        debug: false,
        cameraDetails: {},
        simplisafe: { getCameraLiveView: () => new Promise(() => {}) },
        ...overrides,
    };
}

test('connect gives up after the timeout, including while the live view is being requested', async () => {
    const source = new LiveKitSource(createCamera());
    const started = Date.now();

    await assert.rejects(source.connect(30), /Timed out after 0.03s waiting for video from Back Yard\.$/);
    assert.ok(Date.now() - started < 500);
    source.close();
});

test('the timeout message points at the battery for battery cameras', async () => {
    const source = new LiveKitSource(createCamera({
        cameraDetails: { supportedFeatures: { battery: true, wired: false }, cameraStatus: { batteryPercentage: 0 } },
    }));

    await assert.rejects(source.connect(10), /runs on battery \(0% at last check\)/);
    source.close();
});

test('a source closed while the live view is requested never opens a connection', async () => {
    let resolveLiveView;
    const source = new LiveKitSource(createCamera({
        simplisafe: { getCameraLiveView: () => new Promise((resolve) => { resolveLiveView = resolve; }) },
    }));

    const connecting = source.connect(1000);
    source.close();
    resolveLiveView({ liveKitURL: 'ws://127.0.0.1:1', userToken: 'token', cameraStatus: 'online' });

    await assert.rejects(connecting, /closed before joining/);
    assert.equal(source.ws, null);
});

test('a track announced again on renegotiation is only listened to once', () => {
    const source = new LiveKitSource(createCamera());
    source._handleJoin({ iceServers: [] }, () => {});

    let subscriptions = 0;
    const track = (kind) => ({ kind, codec: { mimeType: `${kind}/x` }, onReceiveRtp: { subscribe: () => { subscriptions++; } } });
    const audio = track('audio');

    source.pc.onTrack.execute(audio);
    source.pc.onTrack.execute(audio); // werift fires again for known transceivers on every offer
    assert.equal(subscriptions, 1);

    source.pc.onTrack.execute(track('video'));
    assert.equal(subscriptions, 2);

    source.close();
});

test('a join arriving after the source was closed opens nothing', () => {
    const source = new LiveKitSource(createCamera());
    source.close();
    source._handleJoin({ iceServers: [], pingInterval: 1 }, () => {});

    assert.equal(source.pc, null);
    assert.equal(source.pingIntervalID, null);
});

function joinWithTracks(source) {
    source._handleJoin({ iceServers: [] }, () => {});
    const receive = {};
    for (const kind of ['video', 'audio']) {
        source.pc.onTrack.execute({ kind, codec: { mimeType: `${kind}/x` }, onReceiveRtp: { subscribe: (fn) => { receive[kind] = fn; } } });
    }
    return receive;
}

test('every listener gets each packet, so a snapshot and live views can share the connection', async () => {
    const source = new LiveKitSource(createCamera());
    const receive = joinWithTracks(source);
    const seen = [];
    source.on('video', (rtp) => seen.push(['first', rtp.header.ssrc]));
    source.on('video', (rtp) => seen.push(['second', rtp.header.ssrc]));
    source.on('audio', () => seen.push(['audio']));

    receive.video({ header: { ssrc: 77 }, payload: Buffer.from([1]) });
    receive.audio({ header: { ssrc: 78 }, payload: Buffer.from([2]) });

    assert.deepEqual(seen, [['first', 77], ['second', 77], ['audio']]);
    assert.equal(source.streaming, true);
    assert.equal(source.videoSsrc, 77);

    source.close();
    receive.video({ header: { ssrc: 77 }, payload: Buffer.from([1]) });
    assert.equal(seen.length, 3, 'nothing is delivered after close');
    assert.equal(source.listenerCount('video'), 0);
});

test('a running session that dies tells every user once, after closing', () => {
    const source = new LiveKitSource(createCamera());
    const ended = [];
    source.on('ended', (reason) => ended.push(['first', reason, source.closed]));
    source.on('ended', (reason) => ended.push(['second', reason, source.closed]));

    source._sessionEnded('not streaming yet');             // a failed join is reported by connect() instead
    assert.deepEqual(ended, []);

    source.streaming = true;
    source._sessionEnded('signalling closed');
    source._sessionEnded('signalling closed');

    assert.deepEqual(ended, [['first', 'signalling closed', true], ['second', 'signalling closed', true]]);
});

test('a keyframe is requested from the video receiver for the SSRC seen, at most once a second', () => {
    const source = new LiveKitSource(createCamera());
    assert.equal(source.requestKeyframe(), false, 'nothing to ask before joining');

    const receive = joinWithTracks(source);
    const plis = [];
    const videoReceiver = { track: source.videoTrack, sendRtcpPLI: async (ssrc) => { plis.push(ssrc); } };
    source.pc.getTransceivers = () => [{ kind: 'audio', receiver: {} }, { kind: 'video', receiver: videoReceiver }];
    assert.equal(source.requestKeyframe(), false, 'no video yet');

    receive.video({ header: { ssrc: 4242 }, payload: Buffer.from([1]) });
    assert.equal(source.requestKeyframe(), true);
    assert.equal(source.requestKeyframe(), false);
    source.lastKeyframeRequest -= 1000;                    // a second later
    assert.equal(source.requestKeyframe(), true);

    assert.deepEqual(plis, [4242, 4242]);
    source.close();
});
