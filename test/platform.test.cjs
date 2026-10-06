const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');

// Accessories are replaced by stubs that record what discovery created
function stubAccessory(file, extra = {}) {
    const modulePath = path.join(distDir, 'accessories', `${file}.js`);
    const Stub = class {
        constructor(...args) {
            this.kind = file;
            this.args = args;
            this.name = args[0];
            this.id = args[1];
        }
    };
    Object.assign(Stub.prototype, extra);
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { __esModule: true, default: Stub } };
}

for (const file of ['alarm', 'entrySensor', 'motionSensor', 'smokeDetector', 'coDetector', 'waterSensor', 'freezeSensor', 'doorLock', 'unreachableAccessory']) {
    stubAccessory(file);
}
stubAccessory('camera', {
    isUnsupported() { return false; },
    updateCameraDetails(details) { this.updated = details; },
});

const plugin = require(path.join(distDir, 'index.js')).default;
let SS3Platform;
plugin({
    hap: { uuid: { generate: (id) => `uuid-${id}` } },
    registerPlatform: (pluginName, platformName, constructor) => { SS3Platform = constructor; },
});

function createPlatform({ camerasOnly = false } = {}) {
    const warnings = [];
    const log = () => {};
    log.error = () => {};
    log.info = () => {};
    log.warn = (...args) => warnings.push(args.join(' '));

    const ctx = Object.assign(Object.create(SS3Platform.prototype), {
        camerasOnly,
        enableCameras: true,
        debug: false,
        log,
        excludedDevices: [],
        devices: [],
        accessories: [],
        cameraOptions: null,
        authManager: {},
        api: {},
        snapshotDir: '/tmp/snapshots',
        simplisafe: {
            getSubscription: async () => ({ location: { system: { serial: 'base' } } }),
            getSensors: async () => [
                { type: 5, serial: 'entry', name: 'Front Door', setting: {} },
                { type: 17, serial: 'f11a9cfb', name: 'Back Yard', setting: {} },
                { type: 23, serial: 'f13787bb', name: 'Side Yard', setting: {} },
            ],
            getLocks: async () => [{ serial: 'lock', name: 'Lock' }],
            getCameras: async () => [{ uuid: 'b26f49e83ed74bbcbbca4d34f13787bb', serial: 'f13787bb', cameraSettings: { cameraName: 'Side Yard' } }],
        },
    });
    return { ctx, warnings };
}

test('discovery sets up outdoor cameras as cameras only, without "not supported" sensor warnings', async () => {
    const { ctx, warnings } = createPlatform();
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => device.kind).sort(), ['alarm', 'camera', 'doorLock', 'entrySensor']);
    assert.deepEqual(warnings, []);
});

test('camerasOnly discovers just the cameras', async () => {
    const { ctx } = createPlatform({ camerasOnly: true });
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => device.kind), ['camera']);
    assert.deepEqual(ctx.devices[0].args.at(-1), { snapshotDir: '/tmp/snapshots' });
});

test('camera details from a system refresh reach the camera', async () => {
    const { ctx } = createPlatform({ camerasOnly: true });
    await ctx.discoverSimpliSafeDevices();

    const details = { uuid: 'b26f49e83ed74bbcbbca4d34f13787bb', cameraStatus: { batteryPercentage: 42 } };
    ctx.updateCameraDetails([details, { uuid: 'other' }]);

    assert.equal(ctx.devices[0].updated, details);
});

test('this edition only adds cameras unless told otherwise', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-platform-'));
    const log = () => {};
    log.error = () => {};
    const api = { user: { storagePath: () => storage }, on: () => {}, hap: { uuid: { generate: (id) => id } } };

    try {
        const byDefault = new SS3Platform(log, { name: 'SimpliSafe Cameras' }, api);
        assert.equal(byDefault.camerasOnly, true);
        assert.equal(byDefault.enableCameras, true);

        const everything = new SS3Platform(log, { name: 'SimpliSafe', camerasOnly: false }, api);
        assert.equal(everything.camerasOnly, false);
        assert.equal(everything.enableCameras, false);
    } finally {
        fs.rmSync(storage, { recursive: true, force: true });
    }
});
