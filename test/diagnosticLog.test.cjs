const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { default: DiagnosticLog, redact, readDiagnostics, diagnosticsFilename } = require('../dist/lib/diagnosticLog');

const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';

function createLogger() {
    const calls = [];
    const log = (...args) => calls.push(['log', ...args]);
    for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (...args) => calls.push([level, ...args]);
    log.prefix = 'SimpliSafe Cameras';
    return { log, calls };
}

async function withStorage(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-logs-'));
    try {
        return await run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('removes credentials, email addresses, MAC addresses, Wi-Fi names and account numbers', () => {
    const lines = [
        `ffmpeg -re -headers Authorization: Bearer ${fakeJwt} -i https://1.2.3.4/v1/cam/flv`,
        `{"accessToken":"abc123","refreshToken":"def456","codeVerifier":"ghi789"}`,
        'wss://livekit.example/rtc?access_token=xyz987&auto_subscribe=1',
        `token ${fakeJwt}`,
        '{"uuid":"e15534806fb14446be20a948f11a9cfb","uid":2085122,"sid":5252572,"wlanMac":"a4:da:22:3f:01:9c","wifiSsid":"Home Network 5G","serial":"f11a9cfb"}',
        "join: ['uid:2085122'] for owner@example.com",
        'Specifying account number: 5252572',
        'Initializing child bridge 0E:6C:79:96:92:75',
    ];

    const redacted = lines.map(redact).join('\n');

    for (const secret of [fakeJwt, 'abc123', 'def456', 'ghi789', 'xyz987', '2085122', '5252572', 'a4:da:22:3f:01:9c', 'Home Network 5G', 'owner@example.com', '0E:6C:79:96:92:75']) {
        assert.ok(!redacted.includes(secret), `${secret} must be removed`);
    }
    // what is needed to follow camera events stays
    assert.ok(redacted.includes('"serial":"f11a9cfb"'));
    assert.ok(redacted.includes('e15534806fb14446be20a948f11a9cfb'));
    assert.ok(redacted.includes('https://1.2.3.4/v1/cam/flv'));
});

test('keeps useful values that only look like secrets', () => {
    for (const line of [
        'Sensor refresh received an error: { statusCode: 409 }',
        'FFmpeg exited with code 255',
        'LiveKit: Back Yard cameraStatus offline',
        'SSAPI event 1170 (activity) from sensor type 17 serial f11a9cfb',
    ]) {
        assert.equal(redact(line), line);
    }
});

test('the wrapped logger still logs everything and keeps a redacted copy', () => withStorage((dir) => {
    const { log, calls } = createLogger();
    const diagnostics = new DiagnosticLog({ file: path.join(dir, diagnosticsFilename), version: '1.2.3', flushDelay: 60000 });
    const wrapped = diagnostics.wrap(log);

    wrapped('Discovered camera %s', 'Back Yard');
    wrapped.error('Request failed with Bearer secret-token');
    wrapped.warn('slow');

    assert.deepEqual(calls.map((call) => call[0]), ['log', 'error', 'warn']);
    assert.equal(calls[1][1], 'Request failed with Bearer secret-token', 'the Homebridge log itself is unchanged');
    assert.equal(wrapped.prefix, 'SimpliSafe Cameras');

    const contents = diagnostics.contents();
    assert.match(contents, /INFO Discovered camera Back Yard/);
    assert.match(contents, /ERROR Request failed with Bearer \[REMOVED\]/);
    assert.ok(!contents.includes('secret-token'));
}));

test('keeps a bounded number of lines and says how many were dropped', () => {
    const diagnostics = new DiagnosticLog({ file: '/dev/null', version: '1', maxLines: 3, flushDelay: 60000 });
    for (let i = 1; i <= 5; i++) diagnostics.record('info', [`line ${i}`]);

    const contents = diagnostics.contents();
    assert.match(contents, /3 log lines, 2 older lines dropped/);
    assert.ok(!contents.includes('line 2'));
    assert.ok(contents.includes('line 5'));
});

test('long lines are cut and ffmpeg progress lines are thinned out', () => {
    let now = 0;
    const diagnostics = new DiagnosticLog({ file: '/dev/null', version: '1', flushDelay: 60000, now: () => now });

    diagnostics.record('info', ['x'.repeat(5000)]);
    diagnostics.record('info', ['frame=   11 fps=0.0 q=36.0']);
    now = 500;
    diagnostics.record('info', ['frame=   21 fps= 21 q=31.0']);
    now = 11000;
    diagnostics.record('info', ['frame=  221 fps= 20 q=24.0']);

    const contents = diagnostics.contents();
    assert.match(contents, /3000 characters cut/);
    assert.ok(contents.includes('frame=   11'));
    assert.ok(!contents.includes('frame=   21'));
    assert.ok(contents.includes('frame=  221'));
});

test('the file starts with the camera summary and is written atomically', () => withStorage(async (dir) => {
    const file = path.join(dir, diagnosticsFilename);
    const diagnostics = new DiagnosticLog({
        file,
        version: '1.2.3',
        flushDelay: 10,
        summary: () => 'Side Yard: olympus via mist, battery 100% charging, snapshot 12s old',
    });

    diagnostics.record('info', ['hello']);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const contents = fs.readFileSync(file, 'utf8');
    assert.match(contents, /^homebridge-simplisafe3-edited 1\.2\.3 logs, written /);
    assert.match(contents, /Cameras:\nSide Yard: olympus via mist, battery 100% charging/);
    assert.match(contents, /INFO hello\n$/);
    assert.ok(!fs.existsSync(`${file}.tmp`));
}));

test('a sync flush at shutdown writes what is pending', () => withStorage((dir) => {
    const file = path.join(dir, diagnosticsFilename);
    const diagnostics = new DiagnosticLog({ file, version: '1', flushDelay: 60000 });
    diagnostics.record('warn', ['shutting down']);

    diagnostics.flush(true);
    assert.match(fs.readFileSync(file, 'utf8'), /WARN shutting down/);
}));

test('readDiagnostics returns the redacted file for the settings page, or explains why there is none', () => withStorage((dir) => {
    assert.throws(() => readDiagnostics(dir), /No logs yet/);

    // a file written by anything older is redacted again when read
    fs.writeFileSync(path.join(dir, diagnosticsFilename), `header\n2026-10-06T05:00:00.000Z INFO token=abc123\n2026-10-06T05:00:01.000Z INFO ok\n`);
    const result = readDiagnostics(dir);

    assert.equal(result.lines, 2);
    assert.ok(!result.text.includes('abc123'));
    assert.ok(result.updatedAt > 0);
}));

test('removes HomeKit stream keys, from request dumps and ffmpeg commands', () => {
    const dump = "{ video: { port: 57857, srtp_key: <Buffer 57 d3 08 22 01 a8>, srtp_salt: <Buffer 0e 7f c0 f0> } }";
    const command = 'ffmpeg -i x -srtp_out_params c2VjcmV0LWtleQ== srtp://192.168.1.145:57857';

    const redacted = redact(dump) + redact(command);
    for (const secret of ['57 d3 08 22', '0e 7f c0 f0', 'c2VjcmV0LWtleQ==']) assert.ok(!redacted.includes(secret));
    assert.ok(redacted.includes('port: 57857'));
    assert.ok(redacted.includes('srtp://192.168.1.145:57857'));
});

test('the once-a-minute socket heartbeat is kept only every 15 minutes', () => {
    let now = 0;
    const diagnostics = new DiagnosticLog({ file: '/dev/null', version: '1', flushDelay: 60000, now: () => now });

    for (let minute = 0; minute <= 30; minute++) {
        now = minute * 60000;
        diagnostics.record('info', ['SSAPI socket `heartbeat`']);
    }

    assert.match(diagnostics.contents(), /--- 3 log lines ---/);
});
