const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseFfmpegOptions,
    applyFfmpegOptions,
    flattenFfmpegArgs,
    redactFfmpegArgs,
} = require('../dist/lib/ffmpegArgs');

test('parses option strings, including flags and negative numbers', () => {
    assert.deepEqual(parseFfmpegOptions('-fpsprobesize 0 -re -itsoffset -0.5 -flags low_delay'), [
        ['-fpsprobesize', '0'],
        ['-re', undefined],
        ['-itsoffset', '-0.5'],
        ['-flags', 'low_delay'],
    ]);
    assert.deepEqual(parseFfmpegOptions('  -tune   false '), [['-tune', 'false']]);
    assert.deepEqual(parseFfmpegOptions(''), []);
    assert.deepEqual(parseFfmpegOptions(undefined), []);
});

test('accepts the old object form', () => {
    assert.deepEqual(parseFfmpegOptions({ '-preset': 'fast', '-tune': false }), [['-preset', 'fast'], ['-tune', false]]);
});

test('replaces, removes and adds input options', () => {
    const args = [['-analyzeduration', '1000000'], ['-headers', 'h'], ['-i', 'url']];
    const result = applyFfmpegOptions(args, '-analyzeduration 500000 -headers false -re', 'input');

    assert.deepEqual(result, [['-re'], ['-analyzeduration', '500000'], ['-i', 'url']]);
    assert.deepEqual(args[0], ['-analyzeduration', '1000000'], 'the defaults must not be changed in place');
});

test('"false" as a string removes an argument, as the README documents', () => {
    const args = [['-map', '0:v:0'], ['-tune', 'zerolatency'], ['srtp://out']];
    assert.deepEqual(applyFfmpegOptions(args, '-tune false', 'output'), [['-map', '0:v:0'], ['srtp://out']]);
});

test('new output options go before the output URL so ffmpeg applies them', () => {
    const args = [['-map', '0:v:0'], ['-f', 'rtp'], ['srtp://out']];
    const result = applyFfmpegOptions(args, '-crf 23 -x264-params keyint=40', 'output');

    assert.deepEqual(result, [['-map', '0:v:0'], ['-f', 'rtp'], ['-crf', '23'], ['-x264-params', 'keyint=40'], ['srtp://out']]);
});

test('flattens groups into spawn arguments', () => {
    assert.deepEqual(flattenFfmpegArgs([['-r', 20], [' -i ', ' url '], ['-re']]), ['-r', '20', '-i', 'url', '-re']);
});

test('redacts the access token from logged arguments', () => {
    assert.deepEqual(
        redactFfmpegArgs(['-headers', 'Authorization: Bearer eyJhbGciOi.abc.def', '-i', 'https://1.2.3.4/v1/x/flv']),
        ['-headers', 'Authorization: Bearer [REDACTED]', '-i', 'https://1.2.3.4/v1/x/flv']
    );
});
