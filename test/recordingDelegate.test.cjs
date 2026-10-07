const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const hap = require('@homebridge/hap-nodejs');
const RecordingDelegate = require('../dist/lib/recordingDelegate').default;
const { recordingOptions } = require('../dist/lib/recording');
const { useFakeTimers } = require('./helpers/fake-timers.cjs');

const log = () => {};
log.error = () => {};

// Stands in for a RecordingSource
class FakeSource extends EventEmitter {
    constructor() {
        super();
        this.init = null;
        this.fragments = [];
        this.ended = false;
    }
    fragmentsSince(time) { return this.fragments.filter((f) => f.at >= time); }
    giveInit() { this.init = Buffer.from('init'); this.emit('init', this.init); }
    giveFragment(name, at = Date.now()) { const f = { data: Buffer.from(name), at }; this.fragments.push(f); this.emit('fragment', f); }
    end(reason) { if (this.ended) return; this.ended = true; this.endReason = reason; this.emit('end', reason); }
}

function delegate(options = {}) {
    const sources = [];
    const recording = new RecordingDelegate({
        name: 'Side Yard', log, debug: false, hap,
        createSource: (options) => { const s = new FakeSource(); s.audio = options.audio; sources.push(s); return s; },
        ...options,
    });
    return { recording, sources };
}

async function take(generator, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const { value, done } = await generator.next();
        if (done) break;
        out.push(value);
    }
    return out;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a motion event starts the camera, and HomeKit\'s request gets the init segment then everything since', async () => {
    const { recording, sources } = delegate();
    recording.updateRecordingActive(true);
    recording.prepare();
    const source = sources[0];
    source.giveInit();
    source.giveFragment('before HomeKit asked');

    const abort = new AbortController();
    const stream = recording.handleRecordingStreamRequest(1, abort.signal);
    const first = await take(stream, 2);
    assert.deepEqual(first.map((p) => [p.data.toString(), p.isLast]), [['init', false], ['before HomeKit asked', false]]);

    const next = stream.next();
    source.giveFragment('live');
    assert.equal((await next).value.data.toString(), 'live');

    abort.abort();
    const done = stream.next();
    source.giveFragment('after close');
    assert.equal((await done).done, true);
    recording.disconnect('test over');
});

test('HomeKit\'s close ends a recording on a HAP that passes no signal (Homebridge 1.x)', async () => {
    const { recording, sources } = delegate();
    recording.updateRecordingActive(true);

    // closed while the camera wakes: no wait for video and no error
    const waking = recording.handleRecordingStreamRequest(1);
    const first = waking.next();
    await tick();
    recording.closeRecordingStream(1, 3);
    assert.equal((await first).done, true);
    assert.equal(recording.streams, 0);

    // closed between fragments: ends at once, not with the next fragment
    sources[0].giveInit();
    const stream = recording.handleRecordingStreamRequest(2);
    assert.equal((await stream.next()).value.data.toString(), 'init');
    const next = stream.next();
    await tick();
    recording.closeRecordingStream(2, 0);
    assert.equal((await next).done, true);
    assert.equal(recording.streams, 0);

    // a late close for a finished request, e.g. HAP's own after the end, leaves the next one alone
    recording.closeRecordingStream(2, 3);
    const later = recording.handleRecordingStreamRequest(3);
    assert.equal((await later.next()).value.data.toString(), 'init');
    const pending = later.next();
    sources[0].giveFragment('live');
    assert.equal((await pending).value.data.toString(), 'live');
    recording.disconnect('test over');
});

test('a recording HomeKit closed during the privacy check does not start the camera', async () => {
    let answer;
    const { recording, sources } = delegate({ allowed: () => new Promise((resolve) => { answer = resolve; }) });
    recording.updateRecordingActive(true);
    const abort = new AbortController();
    const stream = recording.handleRecordingStreamRequest(1, abort.signal);
    const first = stream.next();
    await tick();
    abort.abort();
    answer(true);
    assert.equal((await first).done, true);
    assert.equal(sources.length, 0);
    assert.equal(recording.streams, 0);
});

test('when the camera goes away mid-recording, HomeKit is told the recording ended', async () => {
    const { recording, sources } = delegate();
    recording.updateRecordingActive(true);
    const stream = recording.handleRecordingStreamRequest(1, new AbortController().signal);
    const pending = take(stream, 4);
    await tick();
    sources[0].giveInit();
    await tick();
    sources[0].giveFragment('fragment');
    await tick();
    sources[0].end('LiveKit session ended');

    // the fragment was already sent, so a final byte carries the end, as homebridge-unifi-protect does
    const packets = await pending;
    assert.deepEqual(packets.map((p) => [p.data.length === 1 ? 'end' : p.data.toString(), p.isLast]), [['init', false], ['fragment', false], ['end', true]]);
});

test('no video within the wait ends the request with an error HAP passes on to HomeKit', async (t) => {
    const { recording, sources } = delegate();
    recording.updateRecordingActive(true);
    const stream = recording.handleRecordingStreamRequest(1, new AbortController().signal);
    const pending = stream.next();
    await tick();
    sources[0].end('no video: Timed out after 30s waiting for video from Side Yard.');
    await assert.rejects(pending, (err) => err instanceof hap.HDSProtocolError && err.reason === hap.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
});

test('an always connected camera sends the seconds before HomeKit asked, an on-demand one everything since motion', async () => {
    const { recording, sources } = delegate({ alwaysConnected: true });
    recording.updateRecordingActive(true);
    const source = sources[0];
    assert.ok(source, 'connected as soon as recording is on');
    source.giveInit();
    const now = Date.now();
    source.giveFragment('20s ago', now - 20000);
    source.giveFragment('10s ago', now - 10000);
    source.giveFragment('2s ago', now - 2000);

    const packets = await take(recording.handleRecordingStreamRequest(1, new AbortController().signal), 3);
    assert.deepEqual(packets.map((p) => p.data.toString()), ['init', '10s ago', '2s ago']);
    recording.updateRecordingActive(false);
    assert.equal(source.ended, true, 'turning recording off disconnects');
});

test('an always connected camera that drops reconnects, an on-demand one is let go when idle', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    const always = delegate({ alwaysConnected: true });
    always.recording.updateRecordingActive(true);
    always.sources[0].end('LiveKit session ended');
    timers.tick(5000);
    assert.equal(always.sources.length, 2, 'reconnected after 5s');
    always.recording.updateRecordingActive(false);

    const onDemand = delegate();
    onDemand.recording.updateRecordingActive(true);
    onDemand.recording.prepare();
    timers.tick(19000);
    assert.equal(onDemand.sources[0].ended, false);
    timers.tick(1000);
    assert.equal(onDemand.sources[0].ended, true, 'stopped 20s after motion with no recording');
});

// Date.now moved by hand, the fake timers leave it alone
function useFakeNow(t) {
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    t.after(() => { Date.now = real; });
    return (ms) => { now += ms; };
}

test('an always connected camera that keeps dropping soon after joining waits longer each time', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    const advance = useFakeNow(t);
    const { recording, sources } = delegate({ alwaysConnected: true });
    recording.updateRecordingActive(true);

    // each join is a SimpliSafe live-view call: video then a drop does not start the delays again
    for (const delay of [5000, 30000, 120000, 300000, 300000]) {
        const source = sources[sources.length - 1];
        source.giveInit();
        source.giveFragment('video');
        advance(8000);
        source.end('LiveKit session ended');
        const joins = sources.length;
        timers.tick(delay - 1);
        assert.equal(sources.length, joins, `not before ${delay / 1000}s`);
        timers.tick(1);
        assert.equal(sources.length, joins + 1, `joined again after ${delay / 1000}s`);
    }

    // one that stayed up a while joins again at once
    advance(5 * 60000);
    sources[sources.length - 1].end('LiveKit session ended');
    timers.tick(5000);
    assert.equal(sources.length, 7);
    recording.updateRecordingActive(false);
});

test('an always connected camera on battery is only woken on motion, and kept connected again once it charges', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    let onBattery = false;
    const { recording, sources } = delegate({ alwaysConnected: true, onBattery: () => onBattery });
    recording.updateRecordingActive(true);
    assert.equal(sources.length, 1);

    // a power cut: let go once no recording uses it, and not joined again
    onBattery = true;
    recording.powerChanged();
    timers.tick(20000);
    assert.equal(sources[0].ended, true);
    timers.tick(3600000);
    assert.equal(sources.length, 1);

    // motion wakes it like any battery camera, and it is let go after
    recording.prepare();
    assert.equal(sources.length, 2);
    timers.tick(20000);
    assert.equal(sources[1].ended, true);
    timers.tick(3600000);
    assert.equal(sources.length, 2);

    // charging again: connected at once and kept
    onBattery = false;
    recording.powerChanged();
    assert.equal(sources.length, 3);
    timers.tick(3600000);
    assert.equal(sources[2].ended, false);
    recording.updateRecordingActive(false);

    // started on battery: not connected until it charges
    const started = delegate({ alwaysConnected: true, onBattery: () => true });
    started.recording.updateRecordingActive(true);
    assert.equal(started.sources.length, 0);
});

test('a recording on battery stops after a minute, one while charging after three, as read when HomeKit asks', async (t) => {
    const advance = useFakeNow(t);
    let onBattery = true;
    const { recording, sources } = delegate({ onBattery: () => onBattery });
    recording.updateRecordingActive(true);
    const lastAfter = async () => {
        recording.prepare();
        const source = sources[sources.length - 1];
        source.giveInit();
        const stream = recording.handleRecordingStreamRequest(1, new AbortController().signal);
        await take(stream, 1);
        for (let seconds = 2; ; seconds += 2) {
            advance(2000);
            const next = stream.next();
            source.giveFragment(`${seconds}s`);
            if ((await next).value.isLast) {
                await stream.return();
                recording.disconnect('test over');
                return seconds;
            }
        }
    };
    assert.equal(await lastAfter(), 60);
    onBattery = false;
    assert.equal(await lastAfter(), 180);
});

test('recording off, or a closed privacy shutter, starts nothing', async () => {
    const { recording, sources } = delegate({ allowed: async () => false });
    recording.prepare();
    assert.equal(sources.length, 0, 'not while recording is off');
    recording.updateRecordingActive(true);
    await assert.rejects(take(recording.handleRecordingStreamRequest(1, new AbortController().signal), 1),
        (err) => err.reason === hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
    assert.equal(sources.length, 0);
});

test('\'Record Audio\' applies from the next recording: an idle source starts again, one being recorded is kept until it ends', async () => {
    let audio = true;
    const { recording, sources } = delegate({ alwaysConnected: true, audioActive: () => audio });
    recording.updateRecordingActive(true);
    audio = false;
    recording.update();
    assert.deepEqual(sources.map((s) => [s.audio, s.ended]), [[true, true], [false, false]], 'started again without audio');

    sources[1].giveInit();
    const abort = new AbortController();
    const stream = recording.handleRecordingStreamRequest(1, abort.signal);
    await take(stream, 1);
    audio = true;
    recording.update();
    recording.prepare();
    assert.equal(sources.length, 2, 'the recording keeps its source');
    abort.abort();
    await stream.next();
    assert.deepEqual(sources.map((s) => [s.audio, s.ended]), [[true, true], [false, true], [true, false]], 'started again once the recording ended');
    recording.updateRecordingActive(false);
});

test('an on-demand recording does not use a source started before \'Record Audio\' was turned off', async () => {
    let audio = true;
    const { recording, sources } = delegate({ audioActive: () => audio });
    recording.updateRecordingActive(true);
    recording.prepare();
    audio = false;
    const stream = recording.handleRecordingStreamRequest(1, new AbortController().signal);
    const pending = stream.next();
    await tick();
    assert.deepEqual(sources.map((s) => [s.audio, s.ended]), [[true, true], [false, false]]);
    sources[1].giveInit();
    assert.equal((await pending).value.data.toString(), 'init');
    await stream.return();
    recording.disconnect('test over');
});

test('while the camera is turned off in HomeKit nothing is started, and an always connected camera lets go until it is on again', (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    let on = false;
    const onDemand = delegate({ cameraActive: () => on });
    onDemand.recording.updateRecordingActive(true);
    onDemand.recording.prepare();
    assert.equal(onDemand.sources.length, 0, 'a motion event does not wake it');

    on = true;
    const always = delegate({ alwaysConnected: true, cameraActive: () => on });
    always.recording.updateRecordingActive(true);
    on = false;
    always.recording.update();
    assert.equal(always.sources[0].ended, true);
    timers.tick(600000);
    assert.equal(always.sources.length, 1, 'not reconnected while off');
    on = true;
    always.recording.update();
    assert.equal(always.sources.length, 2, 'connected again once on');
    always.recording.updateRecordingActive(false);
});

test('HAP\'s own recording management sends the init segment, the fragments and the end to a hub', async () => {
    const { recording, sources } = delegate();
    const management = new hap.RecordingManagement(recordingOptions(hap), recording, new Set([hap.EventTriggerOption.MOTION]));
    const events = [];
    const connection = Object.assign(new EventEmitter(), {
        remoteAddress: 'hub', addProtocolHandler() {}, removeProtocolHandler() {}, isConsideredClosed: () => false,
        sendResponse: (protocol, topic, id, status) => events.push(`response ${topic} ${status}`),
        sendEvent: (protocol, topic, event) => events.push(event.packets ? `${event.packets[0].metadata.dataType}${event.endOfStream ? ' end' : ''}` : topic),
    });

    management.recordingActive = true;
    recording.updateRecordingActive(true);
    management.selectedConfiguration = { base64: 'x', parsed: {} };
    management.handleDataSendOpen(connection, 1, { streamId: 7, type: 'ipcamera.recording', target: 'controller', reason: 'motion' });
    await tick();
    sources[0].giveInit();
    await tick();
    sources[0].giveFragment('a');
    await tick();
    sources[0].giveFragment('b');
    await tick();
    sources[0].end('test over');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(events, ['response open 0', 'mediaInitialization', 'mediaFragment', 'mediaFragment', 'mediaFragment end']);

    // a hub acknowledges the end, which closes the stream
    management.recordingStream.handleDataSendAck({ streamId: 7, endOfStream: true });
    assert.equal(management.recordingStream, undefined);
});
