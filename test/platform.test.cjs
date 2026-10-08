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

test('a name in record or alwaysConnected that is not a SimpliSafe camera is warned about, with the names to use', async () => {
    const { ctx, warnings } = createPlatform({ cameraOptions: { record: ['Side Yard', 'Backyard', 'Front Door'], alwaysConnected: ['Back Yard', 'Garage'] } });
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => device.args.at(-1).recording.enabled), [true, false]);
    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /'Backyard' in Record in HomeKit .* not the name of a SimpliSafe camera.*'Side Yard', 'Back Yard'/);
    assert.match(warnings[1], /'Front Door' in Record in HomeKit/);
    assert.match(warnings[2], /'Back Yard' is in Always Connected but not in Record in HomeKit/);
    assert.match(warnings[3], /'Garage' in Always Connected .* not the name of a SimpliSafe camera/);
});

test('names match whatever their case, spacing or Unicode form, and a comma-separated list typed into config.json works', async () => {
    const { ctx, warnings } = createPlatform({ cameraOptions: { record: 'side  yard,BACK\u00a0YARD ' } });
    await ctx.discoverSimpliSafeDevices();

    assert.deepEqual(ctx.devices.map((device) => device.args.at(-1).recording), [{ enabled: true, alwaysConnected: false }, { enabled: true, alwaysConnected: false }]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(ctx.recordingFor('Front Door'), { enabled: false, alwaysConnected: false });
});

test('record or alwaysConnected next to cameraOptions instead of inside it is pointed out', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-platform-'));
    const warnings = [];
    const log = () => {};
    log.error = () => {};
    log.warn = (...args) => warnings.push(args.join(' '));
    const api = { user: { storagePath: () => storage }, on: () => {}, hap: { uuid: { generate: (id) => id } } };
    try {
        new SS3Platform(log, { name: 'SimpliSafe Cameras', logsForClaude: false, record: ['Front Door'], cameraOptions: { alwaysConnected: ['Front Door'] } }, api);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /'record' has to be inside 'cameraOptions'/);
        warnings.length = 0;
        new SS3Platform(log, { name: 'SimpliSafe Cameras', logsForClaude: false, cameraOptions: { record: ['Front Door'] } }, api);
        assert.deepEqual(warnings, []);
    } finally {
        fs.rmSync(storage, { recursive: true, force: true });
    }
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

test('a cached alarm, sensor or lock is removed even while accessories persist, a camera is set up or kept', async () => {
    const { ctx, warnings } = createPlatform();
    ctx.persistAccessories = true;
    ctx.simplisafe.isBlocked = false;
    ctx.authManager = { isAuthenticated: () => true };
    const removed = [];
    ctx.api = {
        hap: { Service: { CameraRTPStreamManagement: { UUID: 'camera-rtp' } } },
        unregisterPlatformAccessories: (pluginName, platformName, accessories) => removed.push(pluginName, platformName, ...accessories.map((a) => a.displayName)),
    };
    ctx.cachedAccessoryConfig = [];
    ctx.initialLoad = ctx.discoverSimpliSafeDevices();

    const camera = cachedAccessory('uuid-b26f49e83ed74bbcbbca4d34f13787bb', 'Side Yard', ['camera-rtp']);
    let configured = null;
    await ctx.initialLoad;
    ctx.devices[0].setAccessory = (accessory) => { configured = accessory; };

    ctx.configureAccessory(camera);
    ctx.configureAccessory(cachedAccessory('uuid-gone-camera', 'Old Camera', ['camera-rtp']));
    ctx.configureAccessory(cachedAccessory('uuid-alarm', 'SimpliSafe 3', ['security-system']));
    await Promise.all(ctx.cachedAccessoryConfig);

    assert.equal(configured, camera);
    assert.deepEqual(ctx.accessories, [camera]);
    assert.deepEqual(removed, ['homebridge-simplisafe3-edited', 'SimpliSafe 3 Edited', 'SimpliSafe 3'], 'a camera no longer in SimpliSafe persists');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Removing 'SimpliSafe 3' from HomeKit, this plugin only has cameras/);
});

test('a cached alarm is not removed while SimpliSafe is rate limited', async () => {
    const { ctx } = createPlatform();
    ctx.persistAccessories = false;
    ctx.simplisafe.isBlocked = true;
    ctx.api = { hap: { Service: { CameraRTPStreamManagement: { UUID: 'camera-rtp' } } }, unregisterPlatformAccessories: () => assert.fail('nothing is removed while rate limited') };
    ctx.cachedAccessoryConfig = [];
    ctx.unreachableAccessories = [];
    ctx.initialLoad = Promise.resolve();

    ctx.configureAccessory(cachedAccessory('uuid-alarm', 'SimpliSafe 3', ['security-system']));
    await Promise.all(ctx.cachedAccessoryConfig);

    assert.equal(ctx.unreachableAccessories.length, 1);
});

test('with persistAccessories off, cameras are only removed once SimpliSafe has listed the cameras', async () => {
    const setup = (getCameras) => {
        const { ctx } = createPlatform();
        const removed = [];
        ctx.persistAccessories = false;
        ctx.simplisafe.isBlocked = false;
        if (getCameras) ctx.simplisafe.getCameras = getCameras;
        ctx.api = { hap: { Service: { CameraRTPStreamManagement: { UUID: 'camera-rtp' } } }, unregisterPlatformAccessories: (plugin, platform, accessories) => removed.push(...accessories.map((a) => a.displayName)) };
        ctx.cachedAccessoryConfig = [];
        // what the constructor does: a failed login or discovery is logged and initialLoad still resolves
        ctx.initialLoad = ctx.discoverSimpliSafeDevices().catch(() => {});
        return { ctx, removed };
    };
    const sideYard = () => cachedAccessory('uuid-b26f49e83ed74bbcbbca4d34f13787bb', 'Side Yard', ['camera-rtp']);
    const frontDoor = () => cachedAccessory('uuid-gone', 'Front Door', ['camera-rtp']);

    // e.g. the network is not up yet, or SimpliSafe answers 503
    const failed = setup(async () => { throw new Error('getaddrinfo EAI_AGAIN api.simplisafe.com'); });
    failed.ctx.configureAccessory(sideYard());
    failed.ctx.configureAccessory(frontDoor());
    await Promise.all(failed.ctx.cachedAccessoryConfig);
    assert.deepEqual(failed.removed, []);

    // SimpliSafe listed the cameras and Front Door is not one of them
    const listed = setup();
    listed.ctx.devices.length = 0;
    await listed.ctx.initialLoad;
    listed.ctx.devices.forEach((device) => { device.setAccessory = () => {}; });
    listed.ctx.configureAccessory(sideYard());
    listed.ctx.configureAccessory(frontDoor());
    await Promise.all(listed.ctx.cachedAccessoryConfig);
    assert.deepEqual(listed.removed, ['Front Door']);
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

test('a camera Homebridge 2 skips because the bridge already has it is explained and not kept', () => {
    const { ctx, errors } = createPlatform();
    const skipped = { UUID: 'uuid-1', _associatedHAPAccessory: { bridged: false } };
    const added = { UUID: 'uuid-2', _associatedHAPAccessory: { bridged: false } };
    ctx.devices = [
        { name: 'Side Yard', uuid: 'uuid-1', createAccessory: () => skipped },
        { name: 'Back Yard', uuid: 'uuid-2', createAccessory: () => added },
    ];
    ctx.api = {
        // Homebridge 2 only warns and leaves a duplicate off the bridge, it does not throw
        registerPlatformAccessories: (plugin, platform, [accessory]) => {
            if (accessory === added) accessory._associatedHAPAccessory.bridged = true;
        },
    };

    ctx.createNewPlatformAccessories();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Could not add 'Side Yard': this bridge already has it, probably from homebridge-simplisafe3/);
    assert.match(errors[0], /Remove Single Cached Accessory/);
    assert.deepEqual(ctx.accessories, [added]);
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
