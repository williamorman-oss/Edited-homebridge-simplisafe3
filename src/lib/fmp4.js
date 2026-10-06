// Splits fragmented MP4 (ffmpeg's '-movflags frag_keyframe+empty_moov+default_base_moof') into what
// HomeKit Secure Video takes: one initialization segment (ftyp and moov), then fragments of one moof and
// its mdat, each starting at a keyframe
const headerSize = 8;

function readBox(buffer, offset) {
    if (buffer.length - offset < headerSize) return null;
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = headerSize;

    if (size === 1) {
        if (buffer.length - offset < 16) return null;
        const large = buffer.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MP4 box '${type}' is too large`);
        size = Number(large);
        header = 16;
    } else if (size === 0) {
        throw new Error(`MP4 box '${type}' has no size, the output is not fragmented`);
    }
    if (size < header) throw new Error(`MP4 box '${type}' has an invalid size ${size}`);
    if (buffer.length - offset < size) return null;
    return { type, size };
}

class Mp4Fragmenter {
    constructor({ maxBoxSize = 32 * 1024 * 1024 } = {}) {
        this.pending = Buffer.alloc(0);
        this.init = [];
        this.initDone = false;
        this.moof = null;
        this.maxBoxSize = maxBoxSize;
    }

    // Takes the next bytes of ffmpeg's output and returns the segments they complete:
    // { type: 'init' | 'fragment', data }
    push(chunk) {
        this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        const segments = [];
        let offset = 0;

        for (;;) {
            if (this.pending.length - offset >= headerSize) {
                const declared = this.pending.readUInt32BE(offset);
                if (declared > this.maxBoxSize) throw new Error(`MP4 box of ${declared} bytes is larger than expected`);
            }
            const box = readBox(this.pending, offset);
            if (!box) break;
            const data = this.pending.subarray(offset, offset + box.size);
            offset += box.size;

            if (!this.initDone) {
                if (box.type === 'moof') {
                    // ffmpeg writes ftyp and moov first, anything before the first moof belongs to them
                    this.initDone = true;
                    segments.push({ type: 'init', data: Buffer.concat(this.init) });
                    this.init = null;
                    this.moof = Buffer.from(data);
                } else {
                    this.init.push(Buffer.from(data));
                    if (box.type === 'moov') {
                        this.initDone = true;
                        segments.push({ type: 'init', data: Buffer.concat(this.init) });
                        this.init = null;
                    }
                }
            } else if (box.type === 'moof') {
                this.moof = Buffer.from(data);
            } else if (box.type === 'mdat' && this.moof) {
                segments.push({ type: 'fragment', data: Buffer.concat([this.moof, data]) });
                this.moof = null;
            }
            // other boxes after the moov (e.g. sidx, mfra) are not needed
        }

        this.pending = offset ? Buffer.from(this.pending.subarray(offset)) : this.pending;
        return segments;
    }
}

export default Mp4Fragmenter;
