// Opus packets (RFC 6716 section 3) re-cut for HomeKit. The Outdoor Cameras send 100 ms packets holding
// five 20 ms frames, timed on WebRTC's 48 kHz clock. HomeKit plays nothing unless each packet lasts the
// packet time it asked for (20 or 60 ms) and timestamps count at the sample rate it asked for (e.g. 24 kHz),
// whatever the audio's real rate. Frames are moved between packets as they are, nothing is re-encoded

// ms one frame plays, from the TOC byte's configuration
export function opusFrameDuration(toc) {
    const config = toc >> 3;
    if (config < 12) return [10, 20, 40, 60][config % 4];
    if (config < 16) return [10, 20][config % 2];
    return [2.5, 5, 10, 20][config % 4];
}

// A frame length as coded in a packet: one byte below 252, otherwise two
function readLength(packet, offset) {
    if (offset >= packet.length) return null;
    const first = packet[offset];
    if (first < 252) return { length: first, size: 1 };
    if (offset + 1 >= packet.length) return null;
    return { length: first + 4 * packet[offset + 1], size: 2 };
}

function writeLength(length) {
    if (length < 252) return Buffer.from([length]);
    const first = 252 + (length & 3);
    return Buffer.from([first, (length - first) >> 2]);
}

// The TOC byte and frames of a packet, or null if it is not valid Opus
export function opusFrames(packet) {
    if (!packet || !packet.length) return null;
    const toc = packet[0];
    const code = toc & 3;
    const body = packet.subarray(1);

    if (code === 0) return { toc, frames: [body] };
    if (code === 1) {
        if (body.length % 2) return null;
        return { toc, frames: [body.subarray(0, body.length / 2), body.subarray(body.length / 2)] };
    }
    if (code === 2) {
        const first = readLength(packet, 1);
        if (!first || 1 + first.size + first.length > packet.length) return null;
        const start = 1 + first.size;
        return { toc, frames: [packet.subarray(start, start + first.length), packet.subarray(start + first.length)] };
    }

    // code 3: a frame count, optional padding, then frames all the same size (CBR) or each with a length (VBR)
    if (packet.length < 2) return null;
    const vbr = (packet[1] & 0x80) !== 0;
    const padded = (packet[1] & 0x40) !== 0;
    const count = packet[1] & 0x3f;
    if (!count || count * opusFrameDuration(toc) > 120) return null;

    let offset = 2;
    let padding = 0;
    if (padded) {
        for (;;) {
            if (offset >= packet.length) return null;
            const value = packet[offset++];
            padding += value === 255 ? 254 : value;
            if (value !== 255) break;
        }
    }

    const lengths = [];
    if (vbr) {
        for (let i = 0; i < count - 1; i++) {
            const length = readLength(packet, offset);
            if (!length) return null;
            lengths.push(length.length);
            offset += length.size;
        }
    }

    const available = packet.length - offset - padding;
    if (available < 0) return null;
    if (vbr) {
        const last = available - lengths.reduce((sum, length) => sum + length, 0);
        if (last < 0) return null;
        lengths.push(last);
    } else {
        if (available % count) return null;
        for (let i = 0; i < count; i++) lengths.push(available / count);
    }

    const frames = [];
    for (const length of lengths) {
        frames.push(packet.subarray(offset, offset + length));
        offset += length;
    }
    return { toc, frames };
}

// One packet of frames that share a TOC: code 0 for one frame, code 3 VBR without padding for more
export function opusPacket(toc, frames) {
    if (frames.length === 1) return Buffer.concat([Buffer.from([toc & ~3]), frames[0]]);
    const header = Buffer.from([toc | 3, 0x80 | frames.length]);
    const lengths = frames.slice(0, -1).map(frame => writeLength(frame.length));
    return Buffer.concat([header, ...lengths, ...frames]);
}

// Re-cuts a stream of Opus RTP packets into packets of HomeKit's packet time, with HomeKit's timestamps and
// its own sequence numbers. push() takes one received packet and returns the packets to send, each
// { payload, timestamp, sequenceNumber }
export class OpusRepacker {
    constructor({ packetTime = 20, sampleRate = 24, clockRate = 48000 } = {}) {
        this.packetTime = Number(packetTime) || 20;
        this.samplesPerMs = Number(sampleRate) || 24; // HomeKit gives the rate in kHz, i.e. samples per ms
        this.clockRate = clockRate;
        this.sequenceNumber = Math.floor(Math.random() * 0x10000);
        this.pending = null; // { toc, frames, timestamp }
        this.lastInput = null;
        this.elapsed = 0; // input clock ticks since the first packet, so wrap-around never matters
        this.lastDurationMs = 0;
        this.ssrc = undefined;
        this.invalid = 0;
        this.late = 0;
    }

    push(rtp) {
        const parsed = opusFrames(rtp.payload);
        if (!parsed) {
            this.invalid++;
            return [];
        }

        const frameMs = opusFrameDuration(parsed.toc);
        if (this.lastInput !== null) {
            const resync = 5 * this.clockRate; // a jump this big is a new timestamp base, not time passing
            const delta = (rtp.header.timestamp - this.lastInput) | 0;
            if (rtp.header.ssrc !== this.ssrc || Math.abs(delta) > resync) {
                // a new stream, e.g. the camera published again: carry on from where the last one ended
                this.elapsed += Math.round(this.lastDurationMs * this.clockRate / 1000);
            } else if (delta <= 0) {
                // a duplicate or a packet that arrived after a newer one: dropped, as if lost, so timestamps only go forward
                this.late++;
                return [];
            } else {
                this.elapsed += delta;
            }
        }
        this.lastInput = rtp.header.timestamp;
        this.ssrc = rtp.header.ssrc;
        this.lastDurationMs = parsed.frames.length * frameMs;

        const startMs = this.elapsed * 1000 / this.clockRate;
        const output = [];

        parsed.frames.forEach((frame, i) => {
            const frameStart = startMs + i * frameMs;
            const pending = this.pending;
            // frames only share a packet when they share a configuration and arrive in order
            if (pending && ((pending.toc & 0xfc) !== (parsed.toc & 0xfc) || Math.abs(pending.endMs - frameStart) > frameMs / 2)) {
                output.push(this.flush());
            }
            if (!this.pending) this.pending = { toc: parsed.toc, frames: [], startMs: frameStart, endMs: frameStart };
            this.pending.frames.push(frame);
            this.pending.endMs = frameStart + frameMs;
            if (this.pending.endMs - this.pending.startMs >= this.packetTime - 0.01) output.push(this.flush());
        });

        return output;
    }

    flush() {
        const pending = this.pending;
        this.pending = null;
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
        return {
            payload: opusPacket(pending.toc, pending.frames),
            timestamp: Math.round(pending.startMs * this.samplesPerMs) >>> 0,
            sequenceNumber: this.sequenceNumber
        };
    }
}
