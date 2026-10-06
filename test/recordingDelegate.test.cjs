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
        createSource: () => { const s = new FakeSource(); sources.push(s); return s; },
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

test('recording off, or a closed privacy shutter, starts nothing', async () => {
    const { recording, sources } = delegate({ allowed: async () => false });
    recording.prepare();
    assert.equal(sources.length, 0, 'not while recording is off');
    recording.updateRecordingActive(true);
    await assert.rejects(take(recording.handleRecordingStreamRequest(1, new AbortController().signal), 1),
        (err) => err.reason === hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
    assert.equal(sources.length, 0);
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
