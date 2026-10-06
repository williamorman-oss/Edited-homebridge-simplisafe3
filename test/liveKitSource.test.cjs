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

test('a keyframe is requested from the video receiver for the SSRC seen, at most once a second', async () => {
    const source = new LiveKitSource(createCamera());
    assert.equal(source.requestKeyframe(), false, 'nothing to ask before joining');

    const receive = joinWithTracks(source);
    const plis = [];
    const videoReceiver = { track: source.videoTrack, pliEnabled: true, sendRtcpPLI: async (ssrc) => { plis.push(ssrc); } };
    source.pc.getTransceivers = () => [{ kind: 'audio', receiver: {} }, { kind: 'video', receiver: videoReceiver }];
    assert.equal(source.requestKeyframe(), false, 'no video yet');

    receive.video({ header: { ssrc: 4242 }, payload: Buffer.from([1]) });
    assert.equal(source.requestKeyframe(), true);
    assert.deepEqual(plis, [4242]);

    // a second viewer within the second is not dropped, the request follows once allowed
    source.lastKeyframeRequest = Date.now() - 950;
    assert.equal(source.requestKeyframe(), false);
    assert.equal(source.requestKeyframe(), false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(plis, [4242, 4242], 'one follow-up request, however many asked');

    source.close();
});

test('no keyframe request is claimed when LiveKit did not offer picture loss feedback', () => {
    const source = new LiveKitSource(createCamera());
    const receive = joinWithTracks(source);
    const videoReceiver = { track: source.videoTrack, pliEnabled: undefined, sendRtcpPLI: async () => assert.fail('werift would send nothing') };
    source.pc.getTransceivers = () => [{ kind: 'video', receiver: videoReceiver }];
    receive.video({ header: { ssrc: 4242 }, payload: Buffer.from([1]) });

    assert.equal(source.requestKeyframe(), false);
    source.close();
});

test('closing cancels a follow-up keyframe request', async () => {
    const source = new LiveKitSource(createCamera());
    const receive = joinWithTracks(source);
    let plis = 0;
    source.pc.getTransceivers = () => [{ kind: 'video', receiver: { track: source.videoTrack, pliEnabled: true, sendRtcpPLI: async () => { plis++; } } }];
    receive.video({ header: { ssrc: 4242 }, payload: Buffer.from([1]) });

    source.requestKeyframe();
    source.lastKeyframeRequest = Date.now() - 950;
    source.requestKeyframe();
    source.close();
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(plis, 1);
});

test('joining logs the camera name, not the room name that ends in the subscription number', () => {
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    log.error = log;
    const source = new LiveKitSource(createCamera({ debug: true, log }));
    source._handleJoin({ iceServers: [], room: { name: '719f3d450fdb48f5a3a1a2ccf125bfe8_1234567' } }, () => {});

    assert.equal(lines[0], 'LiveKit: joined the room for Back Yard');
    assert.ok(!lines.join('\n').includes('1234567'));
    source.close();
});

test('the room summary says what the plugin may publish and who else is there, without identities', () => {
    const p = require('@livekit/protocol');
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    log.error = log;
    const source = new LiveKitSource(createCamera({ debug: true, log }));

    const join = p.SignalResponse.fromBinary(new p.SignalResponse({ message: { case: 'join', value: new p.JoinResponse({
        room: new p.Room({ name: 'abc_7654321', sid: 'RM_secretroom' }),
        participant: new p.ParticipantInfo({ sid: 'PA_mine', identity: 'user-7654321', permission: new p.ParticipantPermission({ canPublish: true, canSubscribe: true, canPublishSources: [p.TrackSource.MICROPHONE] }) }),
        otherParticipants: [new p.ParticipantInfo({ sid: 'PA_camera', identity: 'camera-identity-x', name: 'Back Yard owner@example.com', metadata: '{"sid":7654321}', isPublisher: true, state: p.ParticipantInfo_State.ACTIVE,
            tracks: [new p.TrackInfo({ sid: 'TR_video', type: p.TrackType.VIDEO, source: p.TrackSource.CAMERA, mimeType: 'video/H264', width: 1920, height: 1080 }),
                new p.TrackInfo({ sid: 'TR_audio', type: p.TrackType.AUDIO, source: p.TrackSource.MICROPHONE, mimeType: 'audio/opus', name: 'mic 7654321' })] })],
        serverInfo: new p.ServerInfo({ version: '1.9.0', protocol: 16, nodeId: 'node-secret', region: 'region-secret' }),
        enabledPublishCodecs: [new p.Codec({ mime: 'audio/red' }), new p.Codec({ mime: 'audio/opus' })],
    }) } }).toBinary()).message.value;
    source._handleJoin(join, () => {});

    const text = lines.join('\n');
    assert.match(text, /canPublish true \(MICROPHONE\), canSubscribe true/);
    assert.match(text, /publish codecs audio\/red,audio\/opus/);
    assert.match(text, /STANDARD\/ACTIVE publisher \[VIDEO\/CAMERA video\/H264 1920x1080, AUDIO\/MICROPHONE audio\/opus\]/);
    for (const secret of ['7654321', 'RM_secretroom', 'PA_', 'TR_', 'user-', 'camera-identity', 'owner@', 'node-secret', 'region-secret']) {
        assert.ok(!text.includes(secret), `${secret} must not be logged`);
    }
    source.close();
});

test('the camera\'s H.264 profile, level and keyframe spacing are logged once, and keyframes are announced', () => {
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    log.error = log;
    const source = new LiveKitSource(createCamera({ debug: true, log }));
    const receive = joinWithTracks(source);
    let keyframes = 0;
    source.on('keyframe', () => keyframes++);

    // SPS for Main 4.0 and PPS in a STAP-A, then the IDR as an FU-A over two packets, every 2s at 90 kHz
    const sps = Buffer.from([0x67, 77, 0x40, 40, 0xaa]);
    const pps = Buffer.from([0x68, 0xce]);
    const stap = Buffer.concat([Buffer.from([24, 0, sps.length]), sps, Buffer.from([0, pps.length]), pps]);
    for (let i = 0; i < 5; i++) {
        const timestamp = (4294000000 + i * 180000) >>> 0;              // wraps around 2^32
        receive.video({ header: { ssrc: 1, timestamp }, payload: stap });
        receive.video({ header: { ssrc: 1, timestamp }, payload: Buffer.from([28, 0x85, 1]) });   // FU-A start of an IDR
        receive.video({ header: { ssrc: 1, timestamp }, payload: Buffer.from([28, 0x45, 2]) });   // FU-A end
        receive.video({ header: { ssrc: 1, timestamp: (timestamp + 4500) >>> 0 }, payload: Buffer.from([0x41, 3]) }); // P frame
    }

    assert.equal(keyframes, 5);
    assert.deepEqual(lines.filter((line) => line.includes('video H.264')), ['LiveKit: Back Yard video H.264 Main 4.0, keyframes 2.0s, 2.0s, 2.0s apart']);
    source.close();
    assert.equal(lines.filter((line) => line.includes('video H.264')).length, 1, 'not logged again on close');
});

test('the participants line follows who is in the room as LiveKit sends changes', () => {
    const p = require('@livekit/protocol');
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    log.error = log;
    const source = new LiveKitSource(createCamera({ debug: true, log }));
    const camera = new p.ParticipantInfo({ sid: 'PA_cam', identity: 'camera-x', state: p.ParticipantInfo_State.ACTIVE, isPublisher: true, tracks: [new p.TrackInfo({ type: p.TrackType.VIDEO, source: p.TrackSource.CAMERA, mimeType: 'video/H264' })] });
    source._handleJoin(new p.JoinResponse({ participant: new p.ParticipantInfo({ sid: 'PA_me', identity: 'me-x' }), otherParticipants: [camera] }), () => {});

    const app = new p.ParticipantInfo({ sid: 'PA_app', identity: 'app-x', state: p.ParticipantInfo_State.ACTIVE, tracks: [new p.TrackInfo({ type: p.TrackType.AUDIO, source: p.TrackSource.MICROPHONE, mimeType: 'audio/red' })] });
    source._logParticipants([app]);
    source._logParticipants([new p.ParticipantInfo({ sid: 'PA_me', identity: 'me-x', state: p.ParticipantInfo_State.ACTIVE })]);
    source._logParticipants([new p.ParticipantInfo({ sid: 'PA_app', identity: '', state: p.ParticipantInfo_State.DISCONNECTED })]);

    const updates = lines.filter((line) => line.includes('participants:'));
    assert.equal(updates.length, 2);
    assert.match(updates[0], /STANDARD\/ACTIVE publisher \[VIDEO\/CAMERA video\/H264\]; STANDARD\/ACTIVE \[AUDIO\/MICROPHONE audio\/red\]$/);
    assert.match(updates[1], /participants: STANDARD\/ACTIVE publisher \[VIDEO\/CAMERA video\/H264\]$/);
    assert.ok(!lines.join('\n').match(/camera-x|app-x|me-x|PA_/));
    source.close();
});
