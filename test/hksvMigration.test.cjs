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

test('taking recording away while the camera is Off in HomeKit leaves its motion sensor active', async () => {
    const details = cameraDetails();
    const recorded = new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid));
    const cam = camera({ enabled: true }, details);
    cam.setAccessory(recorded);
    // Off in the Home app: HAP mirrors it to the motion sensor
    await cam.controller.recordingManagement.operatingModeService.getCharacteristic(hap.Characteristic.HomeKitCameraActive).handleSetRequest(0);
    assert.equal(recorded.getService(hap.Service.MotionSensor).getCharacteristic(hap.Characteristic.StatusActive).value, false);
    const restored = hap.Accessory.deserialize(JSON.parse(JSON.stringify(hap.Accessory.serialize(recorded))));

    camera({ enabled: false }, details).setAccessory(restored);
    assert.equal(count(restored, hap.Service.CameraOperatingMode), 0);
    assert.equal(restored.getService(hap.Service.MotionSensor).getCharacteristic(hap.Characteristic.StatusActive).value, true);
});

test('a motion event starts the camera for a recording and holds the motion sensor on while events continue', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    const details = cameraDetails();
    const cam = camera({ enabled: true }, details);
    cam.setAccessory(new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid)));
    cam.recording.updateRecordingActive(true);
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

test('\'Record Audio\' and turning the camera off or on in the Home app reach the recording', async () => {
    const details = cameraDetails();
    const cam = camera({ enabled: true, alwaysConnected: true }, details);
    const sources = [];
    cam.streamingDelegate.createRecordingSource = (options) => {
        const source = Object.assign(new EventEmitter(), { audio: options.audio, ended: false });
        source.end = (reason) => { if (!source.ended) { source.ended = true; source.emit('end', reason); } };
        sources.push(source);
        return source;
    };
    cam.setAccessory(new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid)));
    const { recordingManagementService, operatingModeService } = cam.controller.recordingManagement;
    const hub = { remoteAddress: 'hub' }; // a write from a HomeKit controller, not from the plugin
    const write = (service, characteristic, value) => service.getCharacteristic(characteristic).handleSetRequest(value, hub);

    // a hub may turn recording on before it turns on 'Record Audio'
    await write(recordingManagementService, hap.Characteristic.Active, 1);
    await write(recordingManagementService, hap.Characteristic.RecordingAudioActive, 1);
    assert.deepEqual(sources.map((s) => [s.audio, s.ended]), [[false, true], [true, false]]);

    await write(operatingModeService, hap.Characteristic.HomeKitCameraActive, 0);
    assert.equal(sources[1].ended, true, 'let go while the camera is off');
    cam.simplisafe.emit('CAMERA_MOTION', { sensorSerial: 'f13787bb' });
    assert.equal(sources.length, 2, 'motion does not wake it either');
    await write(operatingModeService, hap.Characteristic.HomeKitCameraActive, 1);
    assert.equal(sources.length, 3, 'connected again once on');
    cam.recording.updateRecordingActive(false);
});

test('while HomeKit is not recording, motion is held 5s like any camera and a doorbell press is not motion', async (t) => {
    const timers = useFakeTimers();
    t.after(() => timers.restore());
    const details = cameraDetails({ doorbell: true, provider: 'simplisafe' });
    const cam = camera({ enabled: true }, details);
    cam.setAccessory(new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid)));
    const motion = cam.accessory.getService(hap.Service.MotionSensor).getCharacteristic(hap.Characteristic.MotionDetected);

    // e.g. 'Stream' chosen in the Home app while someone is home
    cam.simplisafe.emit('DOORBELL', { sensorSerial: 'f13787bb' });
    assert.equal(motion.value, false, 'a press is only motion while HomeKit records');
    cam.simplisafe.emit('CAMERA_MOTION', { sensorSerial: 'f13787bb' });
    assert.equal(motion.value, true);
    timers.tick(5000);
    assert.equal(motion.value, false, 'off 5s after the event');

    cam.recording.updateRecordingActive(true);
    cam.recording.prepare = () => {};
    cam.simplisafe.emit('DOORBELL', { sensorSerial: 'f13787bb' });
    assert.equal(motion.value, true, 'someone at the door is recorded');
    timers.tick(20000);
    assert.equal(motion.value, false);
});

test('recording turned on again after the bridge is removed from the Home app and added back reaches the plugin', async () => {
    const details = cameraDetails({ doorbell: true, provider: 'simplisafe' });
    const cam = camera({ enabled: true }, details);
    const accessory = new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid));
    cam.setAccessory(accessory);
    const active = cam.controller.recordingManagement.recordingManagementService.getCharacteristic(hap.Characteristic.Active);
    const hub = { remoteAddress: 'hub' };
    const calls = [];
    const update = cam.recording.updateRecordingActive.bind(cam.recording);
    cam.recording.updateRecordingActive = (value) => { calls.push(value); update(value); };

    await active.handleSetRequest(1, hub);
    accessory.handleAccessoryUnpairedForControllers(); // HAP, once the last pairing is removed
    assert.equal(cam.isRecording(), false);
    await active.handleSetRequest(1, hub); // added back, 'Stream & Allow Recording' chosen
    assert.equal(cam.isRecording(), true);
    await active.handleSetRequest(0, hub);
    assert.equal(cam.isRecording(), false);
    assert.deepEqual(calls, [true, false, true, false], 'each change is passed on once');
});

test('restored recording settings start an always connected camera once, with the restored audio, or not at all while it is off', () => {
    for (const cameraOn of [true, false]) {
        const saved = {
            configurationHash: undefined, selectedConfiguration: undefined, recordingActive: true,
            recordingAudioActive: true, eventSnapshotsActive: true, homeKitCameraActive: cameraOn, periodicSnapshotsActive: true,
        };
        const details = cameraDetails();
        const cam = camera({ enabled: true, alwaysConnected: true }, details);
        const sources = [];
        cam.streamingDelegate.createRecordingSource = (options) => {
            const source = Object.assign(new EventEmitter(), { audio: options.audio, ended: false });
            source.end = (reason) => { if (!source.ended) { source.ended = true; source.emit('end', reason); } };
            sources.push(source);
            return source;
        };
        // a new accessory is set up before Homebridge adds it to the bridge, which then restores HAP's saved state
        const accessory = new hap.Accessory('Side Yard', hap.uuid.generate(details.uuid));
        cam.setAccessory(accessory);
        const management = cam.controller.recordingManagement;
        saved.configurationHash = { algorithm: 'sha256', hash: management.computeConfigurationHash('sha256') };
        accessory.controllerStorage.enqueueSaveRequest = () => {}; // nothing is written to disk here
        accessory.controllerStorage.init([{ type: cam.controller.controllerId(), controllerData: { data: { streamManagements: [], recordingManagement: saved } } }]);

        assert.equal(cam.isRecording(), true);
        assert.deepEqual(sources.map((s) => [s.audio, s.ended]), cameraOn ? [[true, false]] : [], `camera ${cameraOn ? 'on' : 'off'}`);
        cam.recording.updateRecordingActive(false);
    }
});

test('a camera with a privacy shutter is never kept connected, even when listed in alwaysConnected', () => {
    const details = {
        uuid: 'a26f49e83ed74bbcbbca4d34f13787aa', serial: 'f13787aa', model: 'SS001',
        supportedFeatures: { privacyShutter: true },
        cameraSettings: { cameraName: 'Living Room', pictureQuality: '720p', shutterOff: 'closed', shutterHome: 'closed', shutterAway: 'open', admin: { fps: 20, bitRate: 300, webRTCProvider: 'simplisafe', firmwareVersion: '1.0' } },
    };
    const warnings = [];
    const warnLog = Object.assign(() => {}, { error: () => {}, warn: (message) => warnings.push(message) });
    const simplisafe = Object.assign(new EventEmitter(), { isBlocked: false, nextAttempt: 0, getCurrentAlarmState: async () => 'OFF' });
    const cam = new SS3Camera('Living Room', details.uuid, details, {}, warnLog, false, simplisafe, { accessToken: 't' }, { hap }, { recording: { enabled: true, alwaysConnected: true } });
    let started = 0;
    cam.streamingDelegate.createRecordingSource = () => { started++; throw new Error('must not start'); };
    cam.setAccessory(new hap.Accessory('Living Room', hap.uuid.generate(details.uuid)));

    assert.equal(cam.recording.alwaysConnected, false);
    assert.match(warnings.join('\n'), /privacy shutter/);
    cam.recording.updateRecordingActive(true);
    assert.equal(started, 0, 'not started when HomeKit turns recording on');

    const outdoor = camera({ enabled: true, alwaysConnected: true });
    outdoor.setAccessory(new hap.Accessory('Side Yard', hap.uuid.generate(cameraDetails().uuid)));
    assert.equal(outdoor.recording.alwaysConnected, true, 'other plugged-in cameras still can be');
});
