const test = require('node:test');
const assert = require('node:assert/strict');

const streamingDelegatePath = require.resolve('../dist/lib/streamingDelegate');
require.cache[streamingDelegatePath] = {
    id: streamingDelegatePath,
    filename: streamingDelegatePath,
    loaded: true,
    exports: {
        __esModule: true,
        default: class StreamingDelegate {
            constructor() {
                this.controller = {};
            }
        },
    },
};

const SS3Camera = require('../dist/accessories/camera').default;

test('supportsPrivacyShutter reflects the camera feature flag', () => {
    const withShutter = SS3Camera.prototype.supportsPrivacyShutter.call({
        cameraDetails: { supportedFeatures: { privacyShutter: true } },
    });
    const withoutShutter = SS3Camera.prototype.supportsPrivacyShutter.call({
        cameraDetails: { supportedFeatures: { privacyShutter: false } },
    });

    assert.equal(withShutter, true);
    assert.equal(withoutShutter, false);
});

const withProvider = (webRTCProvider) => ({
    cameraDetails: { cameraSettings: { admin: webRTCProvider === undefined ? {} : { webRTCProvider } } },
    getStreamProvider: SS3Camera.prototype.getStreamProvider,
    getWebRTCProvider: SS3Camera.prototype.getWebRTCProvider,
});

test('getStreamProvider maps webRTCProvider to a streaming path', () => {
    // SimpliCam / Video Doorbell Pro
    assert.equal(SS3Camera.prototype.getStreamProvider.call(withProvider('simplisafe')), 'legacy');
    // Video Doorbell Series 2 ('mockingbird')
    assert.equal(SS3Camera.prototype.getStreamProvider.call(withProvider('mist')), 'livekit');
    // Something we have not seen
    assert.equal(SS3Camera.prototype.getStreamProvider.call(withProvider('kvs')), 'none');
    // Older payloads with no provider fall back to the legacy path
    assert.equal(SS3Camera.prototype.getStreamProvider.call(withProvider(undefined)), 'legacy');
    assert.equal(SS3Camera.prototype.getStreamProvider.call({
        cameraDetails: {}, getWebRTCProvider: SS3Camera.prototype.getWebRTCProvider,
    }), 'legacy');
});

test('isUnsupported only flags providers we cannot stream', () => {
    assert.equal(SS3Camera.prototype.isUnsupported.call(withProvider('simplisafe')), false);
    assert.equal(SS3Camera.prototype.isUnsupported.call(withProvider('mist')), false);
    assert.equal(SS3Camera.prototype.isUnsupported.call(withProvider('kvs')), true);
});

test('isDoorbell uses the feature flag rather than the model string', () => {
    const isDoorbell = (supportedFeatures) => SS3Camera.prototype.isDoorbell.call({ cameraDetails: { supportedFeatures } });

    assert.equal(isDoorbell({ doorbell: true }), true);
    assert.equal(isDoorbell({ doorbell: false }), false);
    assert.equal(isDoorbell({}), false);
    assert.equal(SS3Camera.prototype.isDoorbell.call({ cameraDetails: {} }), false);
});

test('_validateEvent accepts direct and internal camera matches', () => {
    const ctx = {
        accessory: {},
        id: 'camera-1',
        debug: false,
        log: () => {},
        name: 'Front Door',
    };

    assert.equal(
        SS3Camera.prototype._validateEvent.call(ctx, 'CAMERA_MOTION', { sensorSerial: 'camera-1' }),
        true
    );
    assert.equal(
        SS3Camera.prototype._validateEvent.call(ctx, 'CAMERA_MOTION', {
            sensorSerial: 'other-camera',
            internal: { mainCamera: 'camera-1' },
        }),
        true
    );
    assert.equal(
        SS3Camera.prototype._validateEvent.call(ctx, 'CAMERA_MOTION', { sensorSerial: 'other-camera' }),
        false
    );
});

test('_validateEvent rejects missing accessory or empty payloads', () => {
    assert.equal(
        SS3Camera.prototype._validateEvent.call({ accessory: null, id: 'camera-1', debug: false, log: () => {} }, 'CAMERA_MOTION', {
            sensorSerial: 'camera-1',
        }),
        false
    );
    assert.equal(
        SS3Camera.prototype._validateEvent.call({ accessory: {}, id: 'camera-1', debug: false, log: () => {} }, 'CAMERA_MOTION', null),
        false
    );
});

test('getState returns an error when the API is rate limited', () => {
    let callbackArgs;
    SS3Camera.prototype.getState.call(
        { simplisafe: { isBlocked: true, nextAttempt: Date.now() + 1000 } },
        (...args) => { callbackArgs = args; },
        {},
        'MotionDetected'
    );

    assert.equal(callbackArgs.length, 1);
    assert.match(callbackArgs[0].message, /rate limited/i);
});

test('getState returns the characteristic value when unblocked', () => {
    let callbackArgs;
    const service = {
        getCharacteristic: () => ({ value: true }),
    };

    SS3Camera.prototype.getState.call(
        { simplisafe: { isBlocked: false, nextAttempt: 0 } },
        (...args) => { callbackArgs = args; },
        service,
        'MotionDetected'
    );

    assert.deepEqual(callbackArgs, [null, true]);
});

test('getWebRTCProvider surfaces the raw value so unsupported cameras can be reported', () => {
    assert.equal(SS3Camera.prototype.getWebRTCProvider.call(withProvider('kvs')), 'kvs');
    assert.equal(SS3Camera.prototype.getWebRTCProvider.call({ cameraDetails: {} }), undefined);
});

test('battery cameras are recognised from their features, charging from their state', () => {
    const camera = (details) => ({ cameraDetails: details });
    const outdoor = { supportedFeatures: { wired: false, battery: true }, currentState: { batteryCharging: true }, cameraStatus: { batteryPercentage: 89.6 } };
    const doorbell = { supportedFeatures: { wired: true, battery: false }, cameraStatus: { batteryPercentage: 100 } };

    assert.equal(SS3Camera.prototype.isBatteryPowered.call(camera(outdoor)), true);
    assert.equal(SS3Camera.prototype.isBatteryPowered.call(camera(doorbell)), false);
    assert.equal(SS3Camera.prototype.isBatteryPowered.call(camera({})), false);
    assert.equal(SS3Camera.prototype.isCharging.call(camera(outdoor)), true);
    assert.equal(SS3Camera.prototype.isCharging.call(camera(doorbell)), false);
    assert.equal(SS3Camera.prototype.batteryLevel.call(camera(outdoor)), 90);
    assert.equal(SS3Camera.prototype.batteryLevel.call(camera({})), null);
});

test('_validateEvent also matches the camera by its short serial', () => {
    const ctx = {
        accessory: {},
        id: 'b26f49e83ed74bbcbbca4d34f13787bb',
        cameraDetails: { serial: 'f13787bb' },
        debug: false,
        log: () => {},
    };

    assert.equal(SS3Camera.prototype._validateEvent.call(ctx, 'CAMERA_MOTION', { sensorSerial: 'f13787bb' }), true);
    assert.equal(SS3Camera.prototype._validateEvent.call(ctx, 'MOTION', { sensorSerial: 'f13787bb' }), true);
    assert.equal(SS3Camera.prototype._validateEvent.call(ctx, 'MOTION', { sensorSerial: '01ab98fa' }), false);
});

test('a motion sensor event that names a linked camera does not trigger that camera', () => {
    const ctx = { accessory: {}, id: 'camera-1', cameraDetails: {}, debug: false, log: () => {} };

    assert.equal(SS3Camera.prototype._validateEvent.call(ctx, 'MOTION', { sensorSerial: 'motion-sensor', internal: { mainCamera: 'camera-1' } }), false);
    assert.equal(SS3Camera.prototype._validateEvent.call(ctx, 'CAMERA_MOTION', { sensorSerial: 'base', internal: { mainCamera: 'camera-1' } }), true);
});

test('the battery service reports level, low battery and charging', () => {
    const updates = {};
    const service = { updateCharacteristic: (name, value) => { updates[name] = value; } };
    const Characteristic = {
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: Object.assign('StatusLowBattery', { BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0 }),
        ChargingState: Object.assign('ChargingState', { CHARGING: 1, NOT_CHARGING: 0 }),
    };
    const ctx = (details) => Object.assign(Object.create(SS3Camera.prototype), {
        cameraDetails: details,
        accessory: { getService: () => service },
        api: { hap: { Service: { Battery: 'Battery' }, Characteristic } },
    });

    ctx({ supportedFeatures: { battery: true }, cameraStatus: { batteryPercentage: 15 }, currentState: { batteryCharging: false } }).updateBatteryService();
    assert.deepEqual(updates, { BatteryLevel: 15, StatusLowBattery: 1, ChargingState: 0 });

    const camera = ctx({ supportedFeatures: { battery: true }, cameraStatus: { batteryPercentage: 15 }, currentState: {} });
    camera.updateCameraDetails({ supportedFeatures: { battery: true }, cameraStatus: { batteryPercentage: 100 }, currentState: { batteryCharging: true } });
    assert.deepEqual(updates, { BatteryLevel: 100, StatusLowBattery: 0, ChargingState: 1 });
    assert.equal(camera.cameraDetails.cameraStatus.batteryPercentage, 100);
});

test('a sleeping battery camera reads as asleep in the logs, not just offline', () => {
    const camera = (details) => Object.assign(Object.create(SS3Camera.prototype), { name: 'Back Yard', cameraDetails: details });

    assert.match(camera({ model: 'SSOBCM4', status: 'offline', supportedFeatures: { battery: true }, cameraStatus: { batteryPercentage: 84 } }).diagnostics(),
        /^Back Yard: SSOBCM4 via simplisafe, battery 84%, asleep or offline$/);
    assert.match(camera({ model: 'SS002', status: 'offline', supportedFeatures: { wired: true } }).diagnostics(), /status offline$/);
});
