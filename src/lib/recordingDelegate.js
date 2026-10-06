// HomeKit Secure Video for one camera: what HAP-NodeJS calls when HomeKit turns recording on or off and when
// it asks for a recording. The camera is started on SimpliSafe's motion event (prepare), a moment before
// HomeKit asks, or kept connected all the time (alwaysConnected) so a recording can start with the seconds
// before SimpliSafe's event, which reaches the plugin 4-8s after the motion
const initTimeout = 15000; // ms for the camera's first video
const idleStop = 20000; // ms an on-demand camera stays connected with no recording, e.g. HomeKit never asked
const alwaysConnectedPreroll = 12000; // ms before HomeKit's request, covering SimpliSafe's late event
const reconnectDelays = [5000, 30000, 120000, 300000]; // ms, for an always connected camera that dropped
const waitStep = 1000; // ms, how often a waiting recording checks whether it was closed

class RecordingDelegate {
    constructor({ name, log, debug, hap, createSource, alwaysConnected = false, maxDuration = 180000, audioActive = () => true, allowed = async () => true }) {
        this.name = name;
        this.log = log;
        this.debug = debug;
        this.hap = hap;
        this.createSource = createSource;
        this.alwaysConnected = alwaysConnected;
        this.maxDuration = maxDuration;
        this.audioActive = audioActive;
        this.allowed = allowed;

        this.active = false;
        this.configuration = null;
        this.source = null;
        this.streams = 0;
        this.idleTimer = null;
        this.reconnectTimer = null;
        this.reconnects = 0;
    }

    // HomeKit: 'Stream & Allow Recording' was chosen or left for the current mode
    updateRecordingActive(active) {
        this.active = !!active;
        if (this.debug) this.log(`HomeKit recording for '${this.name}' is ${this.active ? 'on' : 'off'}`);
        if (this.active && this.alwaysConnected) this.connect();
        if (!this.active) this.disconnect('recording turned off');
    }

    updateRecordingConfiguration(configuration) {
        this.configuration = configuration || null;
    }

    // A SimpliSafe motion or doorbell event: start the camera now, HomeKit asks a moment later
    prepare() {
        if (!this.active) return;
        this.connect();
        this.scheduleIdleStop();
    }

    connect() {
        clearTimeout(this.reconnectTimer);
        if (this.source && !this.source.ended) return this.source;

        const source = this.createSource({ audio: this.audioActive() });
        this.source = source;
        source.once('end', reason => {
            if (this.source === source) this.source = null;
            if (this.debug || this.streams) this.log(`Recording source for '${this.name}' stopped: ${reason}`);
            if (this.alwaysConnected && this.active) {
                const delay = reconnectDelays[Math.min(this.reconnects, reconnectDelays.length - 1)];
                this.reconnects++;
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
                if (this.reconnectTimer.unref) this.reconnectTimer.unref();
            }
        });
        source.once('fragment', () => { this.reconnects = 0; });
        return source;
    }

    disconnect(reason) {
        clearTimeout(this.idleTimer);
        clearTimeout(this.reconnectTimer);
        if (this.source) this.source.end(reason);
        this.source = null;
    }

    // An on-demand camera is let go once no recording has used it for a while, so it can sleep
    scheduleIdleStop() {
        if (this.alwaysConnected) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.streams && this.source) this.disconnect('no recording');
        }, idleStop);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    async *handleRecordingStreamRequest(streamId, signal) {
        const requestedAt = Date.now();
        if (!(await this.allowed())) {
            if (this.debug) this.log(`Declined HomeKit recording for '${this.name}': the privacy shutter is closed`);
            throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
        }

        this.streams++;
        clearTimeout(this.idleTimer);
        const source = this.connect();
        // a source that was connected already has the seconds before the request
        const preroll = this.alwaysConnected ? alwaysConnectedPreroll : Infinity;
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
        if (signal) signal.addEventListener('abort', notify);

        const wait = () => new Promise(resolve => {
            const timer = setTimeout(resolve, waitStep);
            wake = () => {
                clearTimeout(timer);
                wake = null;
                resolve();
            };
        });

        try {
            while (!source.init && !ended && !(signal && signal.aborted) && Date.now() - requestedAt < initTimeout) await wait();
            if (signal && signal.aborted) return;
            if (!source.init) {
                this.log.error(`HomeKit asked '${this.name}' for a recording, but no video came: ${source.endReason || `nothing within ${initTimeout / 1000}s`}`);
                throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
            }

            if (this.debug) this.log(`Recording '${this.name}' for HomeKit: video ${((Date.now() - requestedAt) / 1000).toFixed(1)}s after it asked, ${queue.length} fragment(s) from before`);
            yield { data: source.init, isLast: false };

            const deadline = requestedAt + this.maxDuration;
            for (;;) {
                if (signal && signal.aborted) return;
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
            if (signal) signal.removeEventListener('abort', notify);
            this.streams--;
            this.scheduleIdleStop();
        }
    }

    acknowledgeStream() {}

    closeRecordingStream(streamId, reason) {
        if (this.debug) this.log(`HomeKit closed the recording of '${this.name}'${reason !== undefined && reason !== 0 ? ` (reason ${reason})` : ''}`);
    }
}

export default RecordingDelegate;
