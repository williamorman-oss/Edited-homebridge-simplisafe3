const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetchMjpegFrame } = require('../dist/lib/mjpeg');

const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from('frame-data'), Buffer.from([0xFF, 0xD9])]);

async function withServer(handler, run) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await run(server.address().port, sockets);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

test('returns the first JPEG of a multipart stream, even when split across chunks', async () => {
    let auth;
    await withServer((req, res) => {
        auth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
        res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
        res.write(jpeg.subarray(0, 1)); // SOI split over two chunks
        res.write(jpeg.subarray(1, 7));
        setTimeout(() => res.write(Buffer.concat([jpeg.subarray(7), Buffer.from('\r\n--frame\r\n'), jpeg])), 10);
        // the stream stays open like a camera's, the client must close it
    }, async (port) => {
        const image = await fetchMjpegFrame({ host: '127.0.0.1', port, path: '/mjpg', headers: { Authorization: 'Bearer token' }, timeout: 1000, transport: http });
        assert.deepEqual(image, jpeg);
        assert.equal(auth, 'Bearer token');
    });
});

test('rejects on an HTTP error status', async () => {
    await withServer((req, res) => {
        res.writeHead(401);
        res.end('Unauthorized');
    }, async (port) => {
        await assert.rejects(
            fetchMjpegFrame({ host: '127.0.0.1', port, path: '/mjpg', timeout: 1000, transport: http }),
            /HTTP 401/
        );
    });
});

test('gives up after the timeout and closes the connection', async () => {
    await withServer((req, res) => {
        res.writeHead(200);
        res.write('--frame\r\n'); // never sends a picture
    }, async (port, sockets) => {
        const started = Date.now();
        await assert.rejects(
            fetchMjpegFrame({ host: '127.0.0.1', port, path: '/mjpg', timeout: 50, transport: http }),
            /Timed out/
        );
        assert.ok(Date.now() - started < 500);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(sockets.size, 0, 'the stream must not be left open');
    });
});

test('rejects when the stream ends before a whole JPEG', async () => {
    await withServer((req, res) => {
        res.writeHead(200);
        res.end(jpeg.subarray(0, 5));
    }, async (port) => {
        await assert.rejects(
            fetchMjpegFrame({ host: '127.0.0.1', port, path: '/mjpg', timeout: 1000, transport: http }),
            /ended before a complete JPEG/
        );
    });
});

test('rejects when the server cannot be reached', async () => {
    await assert.rejects(fetchMjpegFrame({ host: '127.0.0.1', port: 1, path: '/mjpg', timeout: 1000, transport: http }));
});
