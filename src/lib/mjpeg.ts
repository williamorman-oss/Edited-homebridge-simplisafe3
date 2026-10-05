import https from 'https';
import type http from 'http';

export interface MjpegFrameRequest {
    host: string;
    port?: number;
    path: string;
    headers?: Record<string, string>;
    timeout: number; // ms for the whole fetch
    maxBytes?: number;
    transport?: typeof https | typeof http; // tests use plain http
}

const soi = Buffer.from([0xFF, 0xD8]);
const eoi = Buffer.from([0xFF, 0xD9]);
const defaultMaxBytes = 5 * 1024 * 1024;

// Pulls the first JPEG out of an MJPEG stream, then closes the connection.
// Unlike jpeg-extract it gives up after `timeout` and never leaves the stream open.
export function fetchMjpegFrame(request: MjpegFrameRequest): Promise<Buffer> {
    const transport = request.transport || https;
    const maxBytes = request.maxBytes || defaultMaxBytes;

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        let start = -1;

        // only ever called from the request's callbacks, after req and timeoutID exist
        function finish(err: Error | null, image?: Buffer) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutID);
            req.destroy();
            if (err) reject(err);
            else resolve(image as Buffer);
        }

        const req = transport.request({
            host: request.host,
            port: request.port,
            path: request.path,
            method: 'GET',
            headers: request.headers,
            rejectUnauthorized: false // connecting by IP, see streamingDelegate
        }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                finish(new Error(`Snapshot request failed with HTTP ${res.statusCode}`));
                return;
            }

            res.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);

                if (start < 0) {
                    start = buffer.indexOf(soi);
                    if (start < 0) {
                        buffer = buffer.subarray(-1); // an SOI may straddle chunks
                        return;
                    }
                }

                const end = buffer.indexOf(eoi, start + soi.length);
                if (end >= 0) {
                    finish(null, Buffer.from(buffer.subarray(start, end + eoi.length)));
                } else if (buffer.length - start > maxBytes) {
                    finish(new Error('No complete JPEG in snapshot stream'));
                }
            });
            res.on('end', () => finish(new Error('Snapshot stream ended before a complete JPEG')));
            res.on('error', err => finish(err));
        });

        req.on('error', err => finish(err));
        const timeoutID = setTimeout(() => finish(new Error(`Timed out after ${request.timeout / 1000}s waiting for a snapshot`)), request.timeout);
        req.end();
    });
}
