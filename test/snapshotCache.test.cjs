const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SnapshotCache = require('../dist/lib/snapshotCache').default;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCache(overrides = {}) {
    const calls = { fetch: 0 };
    const cache = new SnapshotCache({
        name: 'Test Camera',
        refreshAge: 1000,
        budget: 50,
        timeout: 500,
        backoffInitial: 1000,
        ...overrides,
        fetch: async () => {
            calls.fetch++;
            return overrides.fetch ? overrides.fetch() : Buffer.from(`image-${calls.fetch}`);
        },
    });
    return { cache, calls };
}

test('serves a fresh cached image without asking the camera', async () => {
    const { cache, calls } = createCache();
    cache.set(Buffer.from('cached'));

    assert.equal((await cache.get()).toString(), 'cached');
    assert.equal(calls.fetch, 0);
});

test('serves a stale image straight away and refreshes it in the background', async () => {
    let now = 10000;
    const { cache, calls } = createCache({ now: () => now });
    cache.set(Buffer.from('old'), 0);

    const image = await cache.get();
    assert.equal(image.toString(), 'old');
    assert.equal(calls.fetch, 1);

    await delay(5);
    assert.equal(cache.image.toString(), 'image-1');
    assert.equal(cache.takenAt, now);
});

test('concurrent requests share one refresh', async () => {
    const { cache, calls } = createCache({ fetch: () => delay(20).then(() => Buffer.from('new')) });

    const images = await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.deepEqual(images.map(String), ['new', 'new', 'new']);
    assert.equal(calls.fetch, 1);
});

test('without an image it waits at most the budget, then resolves null and keeps refreshing', async () => {
    const { cache } = createCache({ budget: 20, fetch: () => delay(80).then(() => Buffer.from('slow')) });

    const started = Date.now();
    assert.equal(await cache.get(), null);
    assert.ok(Date.now() - started < 70, 'must not wait for the camera');

    await delay(100);
    assert.equal((await cache.get()).toString(), 'slow');
});

test('a request for an image newer than an event waits for one', async () => {
    const { cache } = createCache({ fetch: () => delay(10).then(() => Buffer.from('new')) });
    cache.set(Buffer.from('cached'), Date.now() - 1000);

    assert.equal((await cache.get(Date.now() - 500)).toString(), 'new');
});

test('an image already newer than the event is served without asking the camera', async () => {
    const { cache, calls } = createCache();
    cache.set(Buffer.from('after-event'));

    assert.equal((await cache.get(Date.now() - 500)).toString(), 'after-event');
    assert.equal(calls.fetch, 0);
});

test('falls back to the cached image when the camera is too slow for a newer one', async () => {
    const { cache } = createCache({ fetch: () => delay(200).then(() => Buffer.from('new')) });
    cache.set(Buffer.from('cached'), Date.now() - 1000);

    assert.equal((await cache.get(Date.now(), 20)).toString(), 'cached');
});

test('backs off after a failure and recovers after a success', async () => {
    let now = 0;
    let fail = true;
    const { cache, calls } = createCache({
        now: () => now,
        backoffInitial: 1000,
        fetch: () => fail ? Promise.reject(new Error('camera asleep')) : Promise.resolve(Buffer.from('ok')),
    });

    assert.equal(await cache.get(), null);
    assert.equal(calls.fetch, 1);
    assert.equal(cache.failing, true);

    // inside the backoff nothing is attempted
    now = 500;
    assert.equal(await cache.get(), null);
    assert.equal(calls.fetch, 1);

    // the backoff doubles
    now = 1000;
    assert.equal(await cache.get(), null);
    assert.equal(calls.fetch, 2);
    now = 2500;
    await cache.get();
    assert.equal(calls.fetch, 2);

    fail = false;
    now = 3000;
    assert.equal((await cache.get()).toString(), 'ok');
    assert.equal(cache.failing, false);
});

test('a request for a newer image ignores the backoff', async () => {
    let now = 0;
    let fail = true;
    const { cache, calls } = createCache({
        now: () => now,
        fetch: () => fail ? Promise.reject(new Error('down')) : Promise.resolve(Buffer.from('ok')),
    });

    await cache.get();
    fail = false;
    assert.equal((await cache.get(1)).toString(), 'ok');
    assert.equal(calls.fetch, 2);
});

test('a refresh that never settles is abandoned after the timeout', async () => {
    let hang = true;
    const { cache, calls } = createCache({
        timeout: 30,
        backoffInitial: 0,
        fetch: () => hang ? new Promise(() => {}) : Promise.resolve(Buffer.from('ok')),
    });

    assert.equal(await cache.get(false, 100), null);
    assert.equal(cache.failing, true);

    hang = false;
    assert.equal((await cache.get()).toString(), 'ok');
    assert.equal(calls.fetch, 2);
});

test('canRefresh stops refreshes, e.g. while rate limited', async () => {
    let allowed = false;
    const { cache, calls } = createCache({ canRefresh: () => allowed });

    assert.equal(await cache.get(), null);
    assert.equal(calls.fetch, 0);

    allowed = true;
    assert.equal((await cache.get()).toString(), 'image-1');
});

test('the refresh age can change, e.g. when a camera starts charging', async () => {
    let refreshAge = 10000;
    const { cache, calls } = createCache({ refreshAge: () => refreshAge });
    cache.set(Buffer.from('cached'), Date.now() - 5000);

    await cache.get();
    assert.equal(calls.fetch, 0);

    refreshAge = 1000;
    await cache.get();
    assert.equal(calls.fetch, 1);
});

test('failed refreshes never surface as unhandled rejections', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
        const { cache } = createCache({ fetch: () => Promise.reject(new Error('boom')) });
        cache.set(Buffer.from('cached'), 0);
        await cache.get();
        await delay(10);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, []);
});

test('the last image is saved to disk and loaded with its age after a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-snapshots-'));
    const file = path.join(dir, 'nested', 'camera.jpg');

    try {
        const saved = Buffer.from([0xFF, 0xD8, 0x00, 0x01, 0xFF, 0xD9]);
        const { cache } = createCache({ persistPath: file, persistInterval: 0 });
        cache.set(saved);
        await delay(20);
        assert.deepEqual(fs.readFileSync(file), saved);
        assert.ok(!fs.existsSync(`${file}.tmp`));

        const past = new Date(Date.now() - 60000);
        fs.utimesSync(file, past, past);

        const { cache: restarted, calls } = createCache({ persistPath: file, refreshAge: 1000 });
        assert.deepEqual(restarted.image, saved);
        assert.ok(restarted.age() >= 59000);

        // served at once, and refreshed because it is old
        assert.deepEqual(await restarted.get(), saved);
        assert.equal(calls.fetch, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('saving is throttled to spare SD cards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-snapshots-'));
    const file = path.join(dir, 'camera.jpg');

    try {
        const { cache } = createCache({ persistPath: file, persistInterval: 60000 });
        cache.set(Buffer.from('first'));
        await delay(20);
        cache.set(Buffer.from('second'));
        await delay(20);
        assert.equal(fs.readFileSync(file).toString(), 'first');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the backoff limit can depend on the camera, e.g. longer on battery', async () => {
    let now = 0;
    let max = 1000;
    const { cache } = createCache({
        now: () => now,
        backoffInitial: 1000,
        backoffMax: () => max,
        fetch: () => Promise.reject(new Error('down')),
    });

    await cache.get();
    now = 1000; await cache.get();
    now = 2000; await cache.get();
    assert.equal(cache.failures, 3, 'capped at 1s, so every second is tried');

    max = 60000;
    now = 3000; await cache.get();
    now = 4000; await cache.get();
    assert.equal(cache.failures, 4, 'the next wait follows the new limit');
});

test('a saved file that is not a complete JPEG is ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-snapshots-'));
    const file = path.join(dir, 'camera.jpg');

    try {
        fs.writeFileSync(file, Buffer.from([0xFF, 0xD8, 0x01, 0x02])); // cut off before the end marker
        const { cache } = createCache({ persistPath: file });
        assert.equal(cache.image, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
