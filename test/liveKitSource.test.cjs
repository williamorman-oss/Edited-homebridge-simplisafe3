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
