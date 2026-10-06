const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const hap = require('@homebridge/hap-nodejs');
const SS3Camera = require('../dist/accessories/camera').default;
const { useFakeTimers } = require('./helpers/fake-timers.cjs');

const log = () => {};
log.error = () => {};
log.warn = () => {};

function cameraDetails({ doorbell = false, provider = 'mist' } = {}) {
    return {
        uuid: 'b26f49e83ed74bbcbbca4d34f13787bb', serial: 'f13787bb', model: 'olympus',
        supportedFeatures: { doorbell, battery: true, wired: false },
        currentState: { batteryCharging: true },
        cameraSettings: { cameraName: 'Side Yard', pictureQuality: '1080p', admin: { fps: 20, bitRate: 2000, webRTCProvider: provider, firmwareVersion: '1.0' } },
    };
}

function camera(recording, details = cameraDetails()) {
    const simplisafe = Object.assign(new EventEmitter(), { isBlocked: false, nextAttempt: 0, getCurrentAlarmState: async () => 'OFF' });
    return new SS3Camera('Side Yard', details.uuid, details, {}, log, false, simplisafe, { accessToken: 't' }, { hap }, { recording });
}

// what the plugin built before recording existed, after a trip through Homebridge's cache
function cachedAccessory(details) {
    const accessory = new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid));
    camera({ enabled: false }, details).setAccessory(accessory);
    return hap.Accessory.deserialize(JSON.parse(JSON.stringify(hap.Accessory.serialize(accessory))));
}

const count = (accessory, service) => accessory.services.filter((s) => s.UUID === service.UUID).length;

test('switching recording on for a camera HomeKit already knows adds the recording services and links its own motion sensor', () => {
    const accessory = cachedAccessory(cameraDetails());
    assert.equal(count(accessory, hap.Service.CameraRecordingManagement), 0);

    const cam = camera({ enabled: true });
    cam.setAccessory(accessory);

    assert.equal(count(accessory, hap.Service.CameraRecordingManagement), 1);
    assert.equal(count(accessory, hap.Service.CameraOperatingMode), 1);
    assert.equal(count(accessory, hap.Service.DataStreamTransportManagement), 1);
    assert.equal(count(accessory, hap.Service.MotionSensor), 1, 'no second motion sensor');
    const motion = accessory.getService(hap.Service.MotionSensor);
    const recordingService = accessory.getService(hap.Service.CameraRecordingManagement);
    assert.ok(recordingService.linkedServices.includes(motion), 'the visible motion sensor triggers recordings');
    assert.ok(cam.recording, 'the camera has a recording delegate');
});

test('the Doorbell Pro keeps its doorbell when recording is switched on', () => {
    const details = cameraDetails({ doorbell: true, provider: 'simplisafe' });
    const accessory = cachedAccessory(details);
    assert.doesNotThrow(() => camera({ enabled: true }, details).setAccessory(accessory));
    assert.equal(count(accessory, hap.Service.Doorbell), 1);
    assert.equal(count(accessory, hap.Service.MotionSensor), 1);
});

test('switching recording off again removes the recording services and keeps the camera', () => {
    const details = cameraDetails();
    const recorded = new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid));
    camera({ enabled: true }, details).setAccessory(recorded);
    const restored = hap.Accessory.deserialize(JSON.parse(JSON.stringify(hap.Accessory.serialize(recorded))));

    camera({ enabled: false }, details).setAccessory(restored);
    assert.equal(count(restored, hap.Service.CameraRecordingManagement), 0);
    assert.equal(count(restored, hap.Service.MotionSensor), 1);
    assert.equal(count(restored, hap.Service.CameraRTPStreamManagement), 2);
});

test('a motion event starts the camera for a recording and holds the motion sensor on while events continue', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    const details = cameraDetails();
    const cam = camera({ enabled: true }, details);
    cam.setAccessory(new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid)));
    let prepared = 0;
    cam.recording.prepare = () => { prepared++; };
    const motion = cam.accessory.getService(hap.Service.MotionSensor).getCharacteristic(hap.Characteristic.MotionDetected);

    cam.simplisafe.emit('CAMERA_MOTION', { sensorSerial: 'f13787bb' });
    assert.equal(prepared, 1);
    assert.equal(motion.value, true);
    timers.tick(15000);
    cam.simplisafe.emit('CAMERA_MOTION', { sensorSerial: 'f13787bb' });
    timers.tick(15000);
    assert.equal(motion.value, true, 'a new event keeps it on');
    timers.tick(5000);
    assert.equal(motion.value, false, 'off 20s after the last event');
});
