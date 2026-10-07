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
            this.uuid = `uuid-${args[1]}`;
        }
    };
    Object.assign(Stub.prototype, extra);
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { __esModule: true, default: Stub } };
}

stubAccessory('unreachableAccessory');
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

function createPlatform({ cameraOptions } = {}) {
    const warnings = [];
    const errors = [];
    const log = () => {};
    log.error = (...args) => errors.push(args.join(' '));
    log.info = () => {};
    log.warn = (...args) => warnings.push(args.join(' '));

    const ctx = Object.assign(Object.create(SS3Platform.prototype), {
        debug: false,
        log,
        excludedDevices: [],
        devices: [],
        accessories: [],
        cameraOptions: cameraOptions || null,
        authManager: {},
        api: {},
        snapshotDir: '/tmp/snapshots',
        // only what the cameras need: anything for the alarm, sensors or locks would throw
        simplisafe: {
            getCameras: async () => [
                { uuid: 'b26f49e83ed74bbcbbca4d34f13787bb', serial: 'f13787bb', cameraSettings: { cameraName: 'Side Yard' } },
                { uuid: 'e15534806fb14446be20a948f11a9cfb', serial: 'f11a9cfb', cameraSettings: { cameraName: 'Back Yard' } },
            ],
        },
    });
    return { ctx, warnings, errors };
}

test('discovery sets up the cameras and nothing else', async () => {
    const { ctx, warnings } = createPlatform();
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => [device.kind, device.name]), [['camera', 'Side Yard'], ['camera', 'Back Yard']]);
    assert.deepEqual(ctx.devices[0].args.at(-1), { snapshotDir: '/tmp/snapshots', recording: { enabled: false, alwaysConnected: false } });
    assert.deepEqual(warnings, []);
});

test('an excluded camera is left out', async () => {
    const { ctx } = createPlatform();
    ctx.excludedDevices = ['f11a9cfb'];
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => device.name), ['Side Yard']);
});

test('recording is switched on per camera by name, and always connected only for cameras that record', async () => {
    const { ctx } = createPlatform({ cameraOptions: { record: [' side yard ', 'Front Door'], alwaysConnected: ['Side Yard', 'Back Yard'] } });
    await ctx.discoverSimpliSafeDevices();
    assert.deepEqual(ctx.devices[0].args.at(-1).recording, { enabled: true, alwaysConnected: true });

    assert.deepEqual(ctx.recordingFor('Back Yard'), { enabled: false, alwaysConnected: false }, 'always connected alone does not record');
    assert.deepEqual(ctx.recordingFor('Front Door'), { enabled: true, alwaysConnected: false });
});

test('camera details from a system refresh reach the camera', async () => {
    const { ctx } = createPlatform();
    await ctx.discoverSimpliSafeDevices();

    const details = { uuid: 'b26f49e83ed74bbcbbca4d34f13787bb', cameraStatus: { batteryPercentage: 42 } };
    ctx.updateCameraDetails([details, { uuid: 'other' }]);

    assert.equal(ctx.devices[0].updated, details);
});

function cachedAccessory(UUID, displayName, serviceUUIDs) {
    return { UUID, displayName, services: serviceUUIDs.map((uuid) => ({ UUID: uuid })) };
}

test('a cached accessory that is not a camera is kept but not set up, and a camera is', async () => {
    const { ctx, warnings } = createPlatform();
    ctx.persistAccessories = true;
    ctx.simplisafe.isBlocked = false;
    ctx.authManager = { isAuthenticated: () => true };
    ctx.api = { hap: { Service: { CameraRTPStreamManagement: { UUID: 'camera-rtp' } } }, unregisterPlatformAccessories: () => assert.fail('nothing is removed while accessories persist') };
    ctx.cachedAccessoryConfig = [];
    ctx.initialLoad = ctx.discoverSimpliSafeDevices();

    const camera = cachedAccessory('uuid-b26f49e83ed74bbcbbca4d34f13787bb', 'Side Yard', ['camera-rtp']);
    let configured = null;
    await ctx.initialLoad;
    ctx.devices[0].setAccessory = (accessory) => { configured = accessory; };

    ctx.configureAccessory(camera);
    ctx.configureAccessory(cachedAccessory('uuid-alarm', 'SimpliSafe 3', ['security-system']));
    await Promise.all(ctx.cachedAccessoryConfig);

    assert.equal(configured, camera);
    assert.deepEqual(ctx.accessories, [camera]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'SimpliSafe 3' is kept but no longer updated, this plugin only has cameras/);
});

test('a camera another plugin on the same bridge already has is explained', () => {
    const { ctx, errors } = createPlatform();
    ctx.devices = [{ name: 'Side Yard', uuid: 'uuid-1', createAccessory: () => ({ UUID: 'uuid-1' }) }];
    ctx.api = {
        registerPlatformAccessories: () => {
            throw new Error('Cannot add a bridged Accessory with the same UUID as another bridged Accessory: uuid-1');
        },
    };

    ctx.createNewPlatformAccessories();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Could not add 'Side Yard': this bridge already has it, probably from homebridge-simplisafe3/);
    assert.deepEqual(ctx.accessories, []);
});

test('the platform only takes camera settings', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-platform-'));
    const warnings = [];
    const log = () => {};
    log.error = () => {};
    log.warn = (...args) => warnings.push(args.join(' '));
    const api = { user: { storagePath: () => storage }, on: () => {}, hap: { uuid: { generate: (id) => id } } };

    try {
        const platform = new SS3Platform(log, { name: 'SimpliSafe Cameras', logsForClaude: false }, api);
        assert.equal(platform.camerasOnly, undefined);
        assert.deepEqual(warnings, []);

        // an older setting that asked for the alarm and sensors as well is pointed at the original plugin
        new SS3Platform(log, { name: 'SimpliSafe', camerasOnly: false, sensorRefresh: 30, logsForClaude: false }, api);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /only adds cameras/);
    } finally {
        fs.rmSync(storage, { recursive: true, force: true });
    }
});
