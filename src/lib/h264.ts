// Drafted by Claude Opus 5.5

const startCode = Buffer.from([0, 0, 0, 1]);

// Subset of werift's RtpHeader that depacketization needs
export interface RtpHeaderFields {
    timestamp: number;
    marker: boolean;
    sequenceNumber: number;
}

interface Fragment {
    type: number;
    chunks: Buffer[];
    nextSequence: number;
}

// Collects a whole keyframe out of RTP payloads so a snapshot can be decoded from
// the live stream. Depacketization only, no decoding.
// A keyframe is usually several slices sharing one RTP timestamp, so NALs are
// gathered per access unit rather than kept individually
class KeyframeCollector {
    declare private sps: Buffer | null;
    declare private pps: Buffer | null;
    declare private keyframe: Buffer | null;
    declare private currentTimestamp: number | null;
    declare private accessUnit: Buffer[];
    declare private fragment: Fragment | null;

    constructor() {
        this.reset();
    }

    reset(): void {
        this.sps = null;
        this.pps = null;
        this.keyframe = null;
        this.currentTimestamp = null;
        this.accessUnit = [];
        this.fragment = null;
    }

    get complete(): boolean {
        return !!this.keyframe;
    }

    annexB(): Buffer | null {
        return this.keyframe;
    }

    push(payload: Buffer | null | undefined, header: RtpHeaderFields | null | undefined): void {
        if (!payload || !payload.length || !header) return;
        const { timestamp, marker, sequenceNumber } = header;

        if (this.currentTimestamp !== null && timestamp !== this.currentTimestamp) {
            this._endAccessUnit();
        }
        this.currentTimestamp = timestamp;

        const type = payload[0] & 0x1f;

        if (type >= 1 && type <= 23) {
            this._store(Buffer.from(payload));
        } else if (type === 24) { // STAP-A, several NALs in one packet
            let offset = 1;
            while (offset + 2 <= payload.length) {
                const length = payload.readUInt16BE(offset);
                offset += 2;
                if (offset + length > payload.length) break;
                this._store(Buffer.from(payload.subarray(offset, offset + length)));
                offset += length;
            }
        } else if (type === 28) { // FU-A, one NAL split across packets
            const fuHeader = payload[1];
            const nalType = fuHeader & 0x1f;

            if (fuHeader & 0x80) { // start
                this.fragment = {
                    type: nalType,
                    chunks: [Buffer.from([(payload[0] & 0x60) | nalType]), Buffer.from(payload.subarray(2))],
                    nextSequence: (sequenceNumber + 1) & 0xffff
                };
            } else if (this.fragment && this.fragment.type === nalType) {
                // A gap means a lost or reordered fragment. Concatenating across it
                // yields a corrupt NAL and a smeared picture, so drop the whole frame
                if (sequenceNumber !== this.fragment.nextSequence) {
                    this.fragment = null;
                    this.accessUnit = [];
                    return;
                }
                this.fragment.chunks.push(Buffer.from(payload.subarray(2)));
                this.fragment.nextSequence = (sequenceNumber + 1) & 0xffff;
                if (fuHeader & 0x40) { // end
                    this._store(Buffer.concat(this.fragment.chunks));
                    this.fragment = null;
                }
            }
        }

        if (marker) this._endAccessUnit();
    }

    private _store(nal: Buffer): void {
        if (!nal.length) return;
        const type = nal[0] & 0x1f;

        // Parameter sets are sent repeatedly, keep the latest outside the access unit
        if (type === 7) this.sps = nal;
        else if (type === 8) this.pps = nal;
        else this.accessUnit.push(nal);
    }

    // An access unit holding an IDR is a complete keyframe, emit every slice of it
    private _endAccessUnit(): void {
        if (this.keyframe) { this.accessUnit = []; return; }

        const hasIdr = this.accessUnit.some(nal => (nal[0] & 0x1f) === 5);
        if (hasIdr && this.sps && this.pps) {
            const parts = [startCode, this.sps, startCode, this.pps];
            for (const nal of this.accessUnit) parts.push(startCode, nal);
            this.keyframe = Buffer.concat(parts);
        }

        this.accessUnit = [];
        this.fragment = null;
    }
}

// The NAL units an H.264 RTP payload starts or carries (RFC 6184): one NAL, a STAP-A aggregate, or the
// first fragment of an FU-A (whose data is not complete, so it is null)
export function rtpNalUnits(payload: Buffer | null | undefined): Array<{ type: number; data: Buffer | null }> {
    if (!payload || !payload.length) return [];
    const type = payload[0] & 0x1f;

    if (type >= 1 && type <= 23) return [{ type, data: payload }];
    if (type === 24) {
        const units: Array<{ type: number; data: Buffer | null }> = [];
        let offset = 1;
        while (offset + 2 < payload.length) {
            const size = payload.readUInt16BE(offset);
            const nal = payload.subarray(offset + 2, offset + 2 + size);
            if (nal.length) units.push({ type: nal[0] & 0x1f, data: nal });
            offset += 2 + size;
        }
        return units;
    }
    if (type === 28 && payload.length > 1 && payload[1] & 0x80) return [{ type: payload[1] & 0x1f, data: null }];
    return [];
}

const profiles: Record<number, string> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' };

// Profile and level from a sequence parameter set, e.g. 'Main 4.0'
export function describeSps(sps: Buffer | null | undefined): string | null {
    if (!sps || sps.length < 4) return null;
    const profileIdc = sps[1];
    const constrained = profileIdc === 66 && (sps[2] & 0x40) ? 'Constrained ' : '';
    const level = sps[3] === 11 && (sps[2] & 0x10) ? '1b' : (sps[3] / 10).toFixed(1);
    return `${constrained}${profiles[profileIdc] || `profile ${profileIdc}`} ${level}`;
}

export default KeyframeCollector;
