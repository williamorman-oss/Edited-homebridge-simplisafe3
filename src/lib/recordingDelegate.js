// HomeKit Secure Video for one camera: what HAP-NodeJS calls when HomeKit turns recording on or off and when
// it asks for a recording. The camera is started on SimpliSafe's motion event (prepare), a moment before
// HomeKit asks, or kept connected all the time (alwaysConnected) so a recording can start with the seconds
// before SimpliSafe's event, which reaches the plugin 4-8s after the motion
const initTimeout = 15000; // ms for the camera's first video
const idleStop = 20000; // ms an on-demand camera stays connected with no recording, e.g. HomeKit never asked
const alwaysConnectedPreroll = 12000; // ms before HomeKit's request, covering SimpliSafe's late event
const reconnectDelays = [5000, 30000, 120000, 300000]; // ms, for an always connected camera that dropped
// ms a connection has to stay up before a drop starts the delays again. Each join is a SimpliSafe live-view
// call, and too many get the whole account blocked, alarm plugin included
const stableConnection = 300000;
const maxDuration = 180000; // ms a recording runs at most
const batteryMaxDuration = 60000; // ms, a camera on battery is kept awake for the whole recording
const waitStep = 1000; // ms, how often a waiting recording checks whether it was closed

class RecordingDelegate {
    constructor({ name, log, debug, hap, createSource, alwaysConnected = false, onBattery = () => false, audioActive = () => true, cameraActive = () => true, allowed = async () => true }) {
        this.name = name;
        this.log = log;
        this.debug = debug;
        this.hap = hap;
        this.createSource = createSource;
        this.alwaysConnected = alwaysConnected;
        this.onBattery = onBattery;
        this.audioActive = audioActive;
        this.cameraActive = cameraActive;
        this.allowed = allowed;

        this.active = false;
        this.configuration = null;
        this.source = null;
        this.sourceAudio = null; // the 'Record Audio' setting the source was started with
        this.streams = 0;
        this.idleTimer = null;
        this.reconnectTimer = null;
        this.reconnects = 0;
        this.closeRequest = null; // ends the newest recording request
    }

    // HomeKit: 'Stream & Allow Recording' was chosen or left for the current mode
    updateRecordingActive(active) {
        this.active = !!active;
        if (this.debug) this.log(`HomeKit recording for '${this.name}' is ${this.active ? 'on' : 'off'}`);
        this.update();
    }

    // Also called when 'Record Audio' or the camera itself is turned on or off in HomeKit, which HAP does not
    // tell the delegate. HAP refuses every recording while the camera is off, so it is not kept streaming then
    update() {
        if (!this.active || !this.cameraActive()) this.disconnect(this.active ? 'camera turned off in HomeKit' : 'recording turned off');
        else if (this.keepConnected()) this.connect();
    }

    updateRecordingConfiguration(configuration) {
        this.configuration = configuration || null;
    }

    // alwaysConnected is for plugged-in cameras. One on battery (a power cut, a solar panel at night) is only
    // woken on motion like the others, streaming all the time would drain it
    keepConnected() {
        return this.alwaysConnected && !this.onBattery();
    }

    // The camera started or stopped charging, from SimpliSafe's camera details
    powerChanged() {
        if (!this.alwaysConnected || !this.active) return;
        const keep = this.keepConnected();
        this.log(`'${this.name}' is ${keep ? 'charging again and is kept connected' : 'on battery and is only woken on motion until it charges again'}`);
        if (keep) {
            clearTimeout(this.idleTimer); // set while it was on battery
            this.update();
        } else {
            clearTimeout(this.reconnectTimer);
            this.scheduleIdleStop(); // let go once no recording uses it
        }
    }

    // A SimpliSafe motion or doorbell event: start the camera now, HomeKit asks a moment later. Not while
    // the privacy shutter is closed, e.g. for an event that arrives late, after a disarm closed it
    async prepare() {
        if (!this.active || !this.cameraActive()) return;
        // a camera that is already running is kept while the shutter is checked, which can take seconds,
        // so its idle stop does not end it just before this event's recording needs it
        if (this.source) this.scheduleIdleStop();
        let allowed = false;
        try {
            allowed = await this.allowed();
        } catch (e) {
            // HomeKit's request fails the same way, so there is nothing to start for
        }
        if (!allowed || !this.active || !this.cameraActive()) return;
        this.connect();
        this.scheduleIdleStop();
    }

    connect() {
        clearTimeout(this.reconnectTimer);
        const audio = this.audioActive();
        const previous = this.source && !this.source.ended ? this.source : null;
        // a source keeps the 'Record Audio' setting it started with, so one with the old setting is replaced,
        // but only once no recording is using it
        if (previous && (this.sourceAudio === audio || this.streams)) return previous;

        const source = this.createSource({ audio });
        const startedAt = Date.now();
        this.source = source;
        this.sourceAudio = audio;
        // stopped after the new one started, so a LiveKit camera's connection is shared, not joined again
        if (previous) previous.end('record audio changed');
        source.once('end', reason => {
            if (this.debug || this.streams) this.log(`Recording source for '${this.name}' stopped: ${reason}`);
            // one let go by disconnect() or replaced is no longer the current source, and is not reconnected
            if (this.source !== source) return;
            this.source = null;
            if (this.active && this.keepConnected()) {
                // a connection that keeps dropping soon after joining waits longer each time
                if (Date.now() - startedAt >= stableConnection) this.reconnects = 0;
                const delay = reconnectDelays[Math.min(this.reconnects, reconnectDelays.length - 1)];
                this.reconnects++;
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
                if (this.reconnectTimer.unref) this.reconnectTimer.unref();
            }
        });
        return source;
    }

    disconnect(reason) {
        clearTimeout(this.idleTimer);
        clearTimeout(this.reconnectTimer);
        const source = this.source;
        this.source = null;
        if (source) source.end(reason);
    }

    // An on-demand camera is let go once no recording has used it for a while, so it can sleep
    scheduleIdleStop() {
        if (this.keepConnected()) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.streams && this.source) this.disconnect('no recording');
        }, idleStop);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    async *handleRecordingStreamRequest(streamId, signal) {
        const requestedAt = Date.now();
        // older HAP (Homebridge 1.x) passes no signal and only calls closeRecordingStream, so the request has its
        // own signal that either one ends. HAP runs one recording at a time, so the newest request is the open one
        const closer = new AbortController();
        const close = () => closer.abort();
        this.closeRequest = close;
        if (signal) signal.addEventListener('abort', close);
        const closed = closer.signal;

        // as in prepare(), a running camera is not let go while the shutter is checked
        if (this.source) this.scheduleIdleStop();
        const allowed = await this.allowed();
        // closed during the privacy check, which can take seconds: the camera is not needed
        if (closed.aborted) return;
        // HomeKit turned recording off during the check, which HAP does not close the request for
        if (!this.active || !this.cameraActive()) {
            if (this.debug) this.log(`Declined HomeKit recording for '${this.name}': recording was turned off`);
            throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
        }
        if (!allowed) {
            if (this.debug) this.log(`Declined HomeKit recording for '${this.name}': the privacy shutter is closed`);
            throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
        }

        // before this recording is counted, so it does not keep a source with the old 'Record Audio' setting
        const source = this.connect();
        this.streams++;
        clearTimeout(this.idleTimer);
        // a source that was connected already has the seconds before the request
        const preroll = this.keepConnected() ? alwaysConnectedPreroll : Infinity;
        const queue = source.fragmentsSince(requestedAt - preroll);
        let ended = source.ended;
        let wake = null;
        const notify = () => {
            if (wake) wake();
        };
        const onFragment = fragment => {
            queue.push(fragment);
            notify();
        };
        const onEnd = () => {
            ended = true;
            notify();
        };
        source.on('fragment', onFragment);
        source.on('end', onEnd);
        source.on('init', notify);
        closed.addEventListener('abort', notify);

        const wait = () => new Promise(resolve => {
            const timer = setTimeout(resolve, waitStep);
            wake = () => {
                clearTimeout(timer);
                wake = null;
                resolve();
            };
        });

        try {
            while (!source.init && !ended && !closed.aborted && Date.now() - requestedAt < initTimeout) await wait();
            if (closed.aborted) return;
            if (!source.init) {
                this.log.error(`HomeKit asked '${this.name}' for a recording, but no video came: ${source.endReason || `nothing within ${initTimeout / 1000}s`}`);
                throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
            }

            if (this.debug) this.log(`Recording '${this.name}' for HomeKit: video ${((Date.now() - requestedAt) / 1000).toFixed(1)}s after it asked, ${queue.length} fragment(s) from before`);
            yield { data: source.init, isLast: false };

            const deadline = requestedAt + (this.onBattery() ? batteryMaxDuration : maxDuration);
            for (;;) {
                if (closed.aborted) return;
                if (queue.length) {
                    const fragment = queue.shift();
                    // at the time limit the next fragment is the last, so the recording ends cleanly
                    const last = Date.now() >= deadline || (ended && !queue.length);
                    yield { data: fragment.data, isLast: last };
                    if (last) return;
                    continue;
                }
                if (ended) {
                    // the camera went away with nothing left to send: HomeKit still needs to hear the end
                    yield { data: Buffer.alloc(1), isLast: true };
                    return;
                }
                await wait();
            }
        } finally {
            source.off('fragment', onFragment);
            source.off('end', onEnd);
            source.off('init', notify);
            closed.removeEventListener('abort', notify);
            if (signal) signal.removeEventListener('abort', close);
            this.streams--;
            this.scheduleIdleStop();
            // 'Record Audio' may have changed during the recording, an always connected camera takes it up now
            if (this.keepConnected() && this.source) this.connect();
        }
    }

    acknowledgeStream() {}

    closeRecordingStream(streamId, reason) {
        if (this.debug) this.log(`HomeKit closed the recording of '${this.name}'${reason !== undefined && reason !== 0 ? ` (reason ${reason})` : ''}`);
        if (this.closeRequest) this.closeRequest();
    }
}

export default RecordingDelegate;
