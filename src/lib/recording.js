import { spawn } from 'child_process';
import dgram from 'dgram';
import https from 'https';
import { EventEmitter } from 'events';
import { RtpHeader, RtpPacket } from 'werift';

import Mp4Fragmenter from './fmp4';
import { rtpNalUnits } from './h264';

// HomeKit Secure Video. HomeKit asks for a recording when the camera's motion sensor goes off and takes
// fragmented MP4: an initialization segment, then fragments each starting at a keyframe.
// The cameras already send H.264 HomeKit accepts (High 4.0 with a keyframe every 2s, the Doorbell Pro Main),
// so video is copied and only audio is converted to AAC

// Never derived from a camera's details: HomeKit forgets the user's recording choice whenever these change
export function recordingOptions(hap) {
    return {
        prebufferLength: 8000, // what an always connected camera can give, see alwaysConnected
        mediaContainerConfiguration: [{ type: hap.MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 }],
        video: {
            type: hap.VideoCodecType.H264,
            parameters: {
                profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0]
            },
            resolutions: [[1920, 1080, 30], [1920, 1080, 24], [1920, 1080, 15], [1280, 720, 30], [1280, 720, 24], [1280, 720, 15]]
        },
        audio: {
            codecs: [{ type: hap.AudioRecordingCodecType.AAC_LC, samplerate: hap.AudioRecordingSamplerate.KHZ_16, audioChannels: 1 }]
        }
    };
}

const fragmentHistory = 16000; // ms of fragments kept, enough for the pre-roll of an always connected camera
const ffmpegStartDelay = 300; // ms for ffmpeg to open its RTP ports before packets are sent
const audioGap = 500; // ms without the camera's audio, which comes every 100 ms, before it counts as not sent
// ffmpeg holds video back until it has the audio of the same moment, by default for up to 10s: a pause in the
// camera's audio would hold back HomeKit's fragments that long
const mp4Output = ['-max_interleave_delta', '1000000', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer', '-flush_packets', '1', 'pipe:1'];

function bindPort(port) {
    return new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => {
            // Node keeps the socket's file descriptor open after a failed bind until it is closed
            try { socket.close(); } catch (e) { /* already closed */ }
            resolve(null);
        });
        socket.bind(port, '127.0.0.1', () => resolve(socket));
    });
}

// Even UDP ports for ffmpeg to receive RTP on, each with the next port free too: ffmpeg takes that for RTCP
async function freeRtpPorts(count) {
    const held = [];
    const ports = [];
    try {
        for (let tries = 0; ports.length < count && tries < 50; tries++) {
            const port = 20000 + 2 * Math.floor(Math.random() * 20000);
            const rtp = await bindPort(port);
            if (!rtp) continue;
            const rtcp = await bindPort(port + 1);
            held.push(rtp);
            if (!rtcp) continue;
            held.push(rtcp);
            ports.push(port);
        }
    } finally {
        await Promise.all(held.map(socket => new Promise(resolve => socket.close(resolve))));
    }
    if (ports.length < count) throw new Error('no free ports for ffmpeg');
    return ports;
}

// A running conversion of one camera's video to fragmented MP4. Keeps the last few seconds of fragments,
// emits 'fragment' for each new one and 'end' once when it stops for any reason
export class RecordingSource extends EventEmitter {
    constructor({ name, log, debug, ffmpegPath, audio = true }) {
        super();
        this.name = name;
        this.log = log;
        this.debug = debug;
        this.ffmpegPath = ffmpegPath;
        this.audio = audio;
        this.init = null;
        this.fragments = [];
        this.ended = false;
        this.startedAt = Date.now();
        this.fragmenter = new Mp4Fragmenter();
        this.cmd = null;
    }

    // Runs ffmpeg with the given input arguments, fragmenting what it writes
    spawnFfmpeg(inputArgs, outputArgs) {
        const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs, ...outputArgs, ...mp4Output];
        const cmd = spawn(this.ffmpegPath, args, { env: process.env });
        this.cmd = cmd;
        let stderr = '';

        cmd.stdout.on('data', chunk => {
            let segments;
            try {
                segments = this.fragmenter.push(chunk);
            } catch (err) {
                this.end(`unreadable MP4 from ffmpeg: ${err.message}`);
                return;
            }
            for (const segment of segments) {
                if (segment.type === 'init') {
                    this.init = segment.data;
                    this.emit('init', segment.data);
                } else {
                    const fragment = { data: segment.data, at: Date.now() };
                    this.fragments.push(fragment);
                    while (this.fragments.length > 1 && fragment.at - this.fragments[0].at > fragmentHistory) this.fragments.shift();
                    this.emit('fragment', fragment);
                }
            }
        });
        cmd.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
        cmd.stdin.on('error', () => {}); // ffmpeg exited first
        cmd.on('error', err => this.end(`ffmpeg could not start: ${err.message}`));
        cmd.on('close', code => {
            // only the last line, ffmpeg's errors can quote its input, which for the FLV holds no secrets but is noise
            const last = stderr.trim().split('\n').pop() || '';
            this.end(code === 0 || code === null || code === 255 ? 'ffmpeg stopped' : `ffmpeg exited with ${code}${last ? `: ${last.slice(0, 200)}` : ''}`);
        });
        return cmd;
    }

    // The fragments that started at or after the given time
    fragmentsSince(time) {
        return this.fragments.filter(fragment => fragment.at >= time);
    }

    end(reason) {
        if (this.ended) return;
        this.ended = true;
        this.endReason = reason;
        this.stopInput();
        if (this.cmd) {
            try { this.cmd.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
        this.emit('end', reason);
    }

    stopInput() {}

    // 'Record Audio' was turned off while this source is recorded. True if no more audio reaches ffmpeg
    stopAudio() {
        return false;
    }
}

// An Outdoor Camera, through the LiveKit connection it shares with live views and snapshots. RTP is
// re-sent to ffmpeg on this machine starting at a keyframe, with the camera's own parameter sets in the SDP
// so ffmpeg does not have to probe
export class LiveKitRecordingSource extends RecordingSource {
    constructor(options, { acquire, release }) {
        super(options);
        this.acquire = acquire;
        this.release = release;
        this.lease = null;
        this.sps = null;
        this.pps = null;
        this.pending = []; // packets of the current access unit until a keyframe starts
        this.queue = null; // packets waiting for ffmpeg to open its ports
        this.audioAt = 0; // when the camera's audio last came
        this.socket = null;
        this.ports = null;
        this.streams = {}; // per kind: the camera's SSRC, where its numbering starts and the numbers sent lately
    }

    start() {
        this.lease = this.acquire();
        const source = this.lease.source;
        this.onVideo = rtp => this.handleVideo(rtp);
        this.onAudio = rtp => this.handleAudio(rtp);
        this.onEnded = reason => this.end(`LiveKit session ended: ${reason}`);
        source.on('video', this.onVideo);
        source.on('audio', this.onAudio);
        source.on('ended', this.onEnded);

        this.lease.ready.then(() => {
            if (this.ended) return;
            // joining a stream that is already running: ask for a keyframe to start from
            if (source.streaming) source.requestKeyframe();
        }, err => this.end(`no video: ${err.message}`));
        return this;
    }

    handleVideo(rtp) {
        if (this.ended || !rtp.payload || !rtp.payload.length) return;
        if (this.ports) {
            this.send('video', rtp);
            return;
        }
        // ffmpeg is starting: keep everything from the keyframe on
        if (this.queue) {
            this.queue.push(['video', rtp]);
            return;
        }

        // before ffmpeg runs: collect the parameter sets and wait for a keyframe
        const units = rtpNalUnits(rtp.payload);
        for (const unit of units) {
            if (unit.type === 7 && unit.data) this.sps = Buffer.from(unit.data);
            if (unit.type === 8 && unit.data) this.pps = Buffer.from(unit.data);
        }
        if (this.pending.length && this.pending[0].header.timestamp !== rtp.header.timestamp) this.pending = [];
        this.pending.push(rtp);

        if (units.some(unit => unit.type === 5) && this.sps && this.pps && !this.queue) {
            // with audio, ffmpeg writes nothing at all until audio comes, so audio is recorded only if the camera
            // is sending it: its microphone can be off. Audio that only starts after the keyframe is left out as
            // well, ffmpeg would line it up with the keyframe. Just after joining a running stream none may have
            // come yet, the next keyframe tells
            if (this.audio && !(Date.now() - this.audioAt < audioGap)) {
                if (Date.now() - this.startedAt < audioGap) {
                    this.lease.source.requestKeyframe();
                    return;
                }
                this.audio = false;
                if (this.debug) this.log(`Recording source for '${this.name}' has no audio: the camera is not sending any`);
            }
            this.queue = this.pending.map(packet => ['video', packet]);
            this.pending = [];
            this.startFfmpeg().catch(err => this.end(`could not start recording: ${err.message}`));
        }
    }

    // ffmpeg keeps writing the video without it, see -max_interleave_delta
    stopAudio() {
        this.audio = false;
        return true;
    }

    handleAudio(rtp) {
        if (this.ended || !this.audio || !rtp.payload || !rtp.payload.length) return;
        this.audioAt = Date.now();
        // audio only from the first keyframe on, so both start together
        if (this.ports) this.send('audio', rtp);
        else if (this.queue) this.queue.push(['audio', rtp]);
    }

    async startFfmpeg() {
        const [videoPort, audioPort] = await freeRtpPorts(2);
        if (this.ended) return;
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', () => {});

        const profileLevel = this.sps.subarray(1, 4).toString('hex');
        const sdp = [
            'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=SimpliSafe', 'c=IN IP4 127.0.0.1', 't=0 0',
            `m=video ${videoPort} RTP/AVP 96`,
            'a=rtpmap:96 H264/90000',
            `a=fmtp:96 packetization-mode=1;profile-level-id=${profileLevel};sprop-parameter-sets=${this.sps.toString('base64')},${this.pps.toString('base64')}`,
            ...(this.audio ? [`m=audio ${audioPort} RTP/AVP 111`, 'a=rtpmap:111 opus/48000/2'] : []),
            ''
        ].join('\r\n');

        const output = ['-map', '0:v:0', '-c:v', 'copy'];
        // a lost Opus packet (only video is retransmitted) is filled with silence, so the AAC keeps time with
        // the video when played back to back, not only by its timestamps
        if (this.audio) output.push('-map', '0:a:0?', '-af', 'aresample=async=1:min_hard_comp=0.02', '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '16000', '-ac', '1', '-b:a', '32k');
        else output.push('-an');

        // -max_delay: how long ffmpeg waits for a late (retransmitted) packet before skipping the gap
        const cmd = this.spawnFfmpeg(['-protocol_whitelist', 'pipe,udp,rtp', '-max_delay', '300000', '-analyzeduration', '500000', '-probesize', '200000', '-f', 'sdp', '-i', 'pipe:0'], output);
        cmd.stdin.end(sdp);

        await new Promise(resolve => setTimeout(resolve, ffmpegStartDelay));
        if (this.ended) return;
        this.ports = { video: videoPort, audio: audioPort };
        const queued = this.queue;
        this.queue = null;
        for (const [kind, packet] of queued) this.send(kind, packet);
    }

    send(kind, rtp) {
        const { ssrc, sequenceNumber } = rtp.header;
        if (!this.streams[kind]) this.streams[kind] = { ssrc, base: sequenceNumber - 1, recent: [] };
        const stream = this.streams[kind];
        // the camera published again: new numbering and timestamps would break ffmpeg's timeline,
        // a new source starts clean from the new stream's keyframe
        if (ssrc !== stream.ssrc) {
            this.end(`the camera started a new ${kind} stream`);
            return;
        }
        // a packet that came twice, e.g. retransmitted although it had arrived: ffmpeg would use it twice
        const slot = sequenceNumber % 1024;
        if (stream.recent[slot] === sequenceNumber) return;
        stream.recent[slot] = sequenceNumber;
        // plain RTP for ffmpeg. The camera's own numbering, so ffmpeg puts a late (retransmitted) packet back
        // in its place, counted from the first packet sent so packets dropped before the keyframe are not a gap
        const header = new RtpHeader({
            ...rtp.header,
            payloadType: kind === 'video' ? 96 : 111,
            sequenceNumber: (sequenceNumber - stream.base) & 0xffff,
            extension: false,
            extensions: [],
            padding: false,
            paddingSize: 0
        });
        try {
            this.socket.send(new RtpPacket(header, rtp.payload).serialize(), this.ports[kind], '127.0.0.1');
        } catch (e) { /* socket closed */ }
    }

    stopInput() {
        if (this.lease) {
            const source = this.lease.source;
            source.off('video', this.onVideo);
            source.off('audio', this.onAudio);
            source.off('ended', this.onEnded);
            this.release(this.lease);
            this.lease = null;
        }
        if (this.socket) {
            try { this.socket.close(); } catch (e) { /* already closed */ }
            this.socket = null;
        }
    }
}

// The Video Doorbell Pro and SimpliCam, from media.simplisafe.com. The stream is fetched here, with the
// certificate checked, and piped into ffmpeg, which copies its H.264 and AAC-LC audio as they are
export class FlvRecordingSource extends RecordingSource {
    constructor(options, { uuid, accessToken, transport = https }) {
        super(options);
        this.uuid = uuid;
        this.accessToken = accessToken;
        this.transport = transport;
        this.request = null;
    }

    start() {
        const path = `/v1/${this.uuid}/flv?x=1920&audioEncoding=AAC`;
        try {
            this.request = this.transport.get({ host: 'media.simplisafe.com', path, headers: { Authorization: `Bearer ${this.accessToken()}` }, timeout: 15000 }, res => {
                if (res.statusCode !== 200) {
                    res.resume();
                    this.end(`media.simplisafe.com answered HTTP ${res.statusCode}`);
                    return;
                }
                const output = ['-map', '0:v:0', '-c:v', 'copy'];
                if (this.audio) output.push('-map', '0:a:0?', '-c:a', 'copy');
                else output.push('-an');
                const cmd = this.spawnFfmpeg(['-fpsprobesize', '0', '-f', 'flv', '-i', 'pipe:0'], output);
                // what keeping this camera connected all the time would cost
                const openedAt = Date.now();
                let bytes = 0;
                res.on('data', chunk => { bytes += chunk.length; });
                this.once('end', () => {
                    const seconds = (Date.now() - openedAt) / 1000;
                    if (this.debug && seconds >= 5) this.log(`Recording source for '${this.name}' received ${Math.round(bytes * 8 / seconds / 1000)} kbps over ${Math.round(seconds)}s`);
                });
                // when the stream ends, ffmpeg finishes what it was given and stops on its own
                res.pipe(cmd.stdin);
                res.on('error', () => this.end('the stream was interrupted'));
            });
        } catch (err) {
            // on the next tick, once the recording delegate is listening, so an always connected camera tries again
            process.nextTick(() => this.end(`could not open the stream: ${err.message}`));
            return this;
        }
        this.request.on('timeout', () => this.end('media.simplisafe.com did not answer'));
        this.request.on('error', err => this.end(`could not open the stream: ${err.code || err.message}`));
        return this;
    }

    stopInput() {
        if (this.request) {
            this.request.destroy();
            this.request = null;
        }
    }
}
