import ffmpegPath from 'ffmpeg-for-homebridge';
import isDocker from 'is-docker';
import path from 'path';

import SimpliSafe3Accessory from './ss3Accessory';
import { EVENT_TYPES } from '../simplisafe';

import StreamingDelegate from '../lib/streamingDelegate';
import { eventClip, eventTime } from '../lib/diagnosticLines';

const lowBatteryLevel = 20; // %

class SS3Camera extends SimpliSafe3Accessory {
    constructor(name, id, cameraDetails, cameraOptions, log, debug, simplisafe, authManager, api, platformOptions = {}) {
        super(name, id, log, debug, simplisafe, api);
        this.cameraDetails = cameraDetails;
        this.cameraOptions = cameraOptions;
        this.authManager = authManager;
        this.reachable = true;
        this.nSocketConnectFailures = 0;
        this.lastEventAt = 0;
        // from SimpliSafe's camera status messages: whether the camera is awake, and since when
        this.liveStatus = null;
        this.liveStatusAt = 0;
        // the last snapshot is kept on disk so tiles have an image straight after a restart
        if (platformOptions.snapshotDir) this.snapshotPath = path.join(platformOptions.snapshotDir, `${id}.jpg`);

        this.ffmpegPath = isDocker() ? 'ffmpeg' : ffmpegPath;
        if (this.debug && isDocker()) this.log('Detected running in docker, initializing with docker-bundled ffmpeg');
        if (this.cameraOptions && this.cameraOptions.ffmpegPath) {
            this.ffmpegPath = this.cameraOptions.ffmpegPath;
        }

        const delegate = new StreamingDelegate(this);
        this.streamingDelegate = delegate;
        this.controller = delegate.controller;

        if (this.isUnsupported()) {
            this.log.warn(`Camera '${this.name}' streams via '${this.getWebRTCProvider()}' which is not supported yet. Please report it, with debug logs, at https://github.com/homebridge-simplisafe3/homebridge-simplisafe3/discussions/240`);
        }

        this.startListening();
    }

    setAccessory(accessory) {
        super.setAccessory(accessory);

        this.accessory.getService(this.api.hap.Service.AccessoryInformation)
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'SimpliSafe')
            .setCharacteristic(this.api.hap.Characteristic.Model, this.cameraDetails.model)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.id)
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, this.cameraDetails.cameraSettings.admin.firmwareVersion);

        this.accessory.configureController(this.controller);

        // add motion sensor after configureController as HKSV creates it own linked motion service
        if (!this.accessory.getService(this.api.hap.Service.MotionSensor)) this.accessory.addService(this.api.hap.Service.MotionSensor);
        this.accessory.getService(this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on('get', callback => this.getState(callback, this.accessory.getService(this.api.hap.Service.MotionSensor), this.api.hap.Characteristic.MotionDetected));

        // add doorbell after configureController as HKSV creates it own linked motion service
        if (this.isDoorbell()) {
            if (!this.accessory.getService(this.api.hap.Service.Doorbell)) this.accessory.addService(this.api.hap.Service.Doorbell);
            this.accessory.getService(this.api.hap.Service.Doorbell)
                .getCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent)
                .on('get', callback => this.getState(callback, this.accessory.getService(this.api.hap.Service.Doorbell), this.api.hap.Characteristic.ProgrammableSwitchEvent));
        }

        if (this.isBatteryPowered()) {
            const BatteryService = this.batteryServiceType();
            if (!this.accessory.getService(BatteryService)) this.accessory.addService(BatteryService);
            this.updateBatteryService();
        }
    }

    // One line on this camera's state, for the logs
    diagnostics() {
        const parts = [`${this.name}: ${this.cameraDetails.model || 'camera'} via ${this.getWebRTCProvider() || 'simplisafe'}`];
        if (this.isBatteryPowered()) {
            const level = this.batteryLevel();
            parts.push(`battery ${level === null ? '?' : level}%${this.isCharging() ? ' charging' : ''}`);
        }
        if (this.cameraDetails.status) {
            // SimpliSafe reports a sleeping battery camera as offline
            const asleep = this.isBatteryPowered() && this.cameraDetails.status === 'offline';
            parts.push(asleep ? 'asleep or offline' : `status ${this.cameraDetails.status}`);
        }
        if (this.streamingDelegate) parts.push(this.streamingDelegate.diagnostics());
        return parts.join(', ');
    }

    // Older HAP-NodeJS only has BatteryService
    batteryServiceType() {
        return this.api.hap.Service.Battery || this.api.hap.Service.BatteryService;
    }

    // Takes newer camera details, e.g. battery level and charging state, from a periodic refresh
    updateCameraDetails(cameraDetails) {
        if (!cameraDetails) return;
        this.cameraDetails = cameraDetails;
        this.updateBatteryService();
    }

    updateBatteryService() {
        if (!this.accessory || !this.isBatteryPowered()) return;
        const service = this.accessory.getService(this.batteryServiceType());
        const level = this.batteryLevel();
        if (!service || level === null) return;

        const { Characteristic } = this.api.hap;
        service.updateCharacteristic(Characteristic.BatteryLevel, level);
        service.updateCharacteristic(Characteristic.StatusLowBattery, level <= lowBatteryLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        service.updateCharacteristic(Characteristic.ChargingState, this.isCharging() ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    }

    getState(callback, service, characteristicType) {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            callback(new Error('Request blocked (rate limited)'));
            return;
        }
        let characteristic = service.getCharacteristic(characteristicType);
        callback(null, characteristic.value);
    }

    async updateReachability() {
        try {
            let cameras = await this.simplisafe.getCameras();
            let camera = cameras.find(cam => cam.uuid === this.id);
            if (!camera) {
                this.reachable = false;
            } else {
                this.reachable = camera.status == 'online';
            }

            return this.reachable;
        } catch (err) {
            this.log.error(`An error occurred while updating reachability for ${this.name}`);
            this.log.error(err);
        }
    }

    supportsPrivacyShutter() {
        // so far SS001 & SS003
        return this.cameraDetails.supportedFeatures && this.cameraDetails.supportedFeatures.privacyShutter;
    }

    // 'legacy' streams FLV from media.simplisafe.com, 'livekit' uses LiveKit keyed on admin.webRTCProvider,
    // not model (newer cameras use codenames e.g. 'mockingbird')
    getWebRTCProvider() {
        return this.cameraDetails.cameraSettings
            && this.cameraDetails.cameraSettings.admin
            && this.cameraDetails.cameraSettings.admin.webRTCProvider;
    }

    getStreamProvider() {
        const provider = this.getWebRTCProvider();

        if (!provider || provider === 'simplisafe') return 'legacy';
        if (provider === 'mist') return 'livekit';
        return 'none';
    }

    isUnsupported() {
        return this.getStreamProvider() === 'none';
    }

    isDoorbell() {
        return !!(this.cameraDetails.supportedFeatures && this.cameraDetails.supportedFeatures.doorbell);
    }

    // e.g. Outdoor Camera, which sleeps between events to save its battery
    isBatteryPowered() {
        const features = this.cameraDetails.supportedFeatures;
        return !!(features && (features.battery === true || features.wired === false));
    }

    // plugged in or on a solar panel
    isCharging() {
        return !!(this.cameraDetails.currentState && this.cameraDetails.currentState.batteryCharging);
    }

    batteryLevel() {
        const level = this.cameraDetails.cameraStatus && this.cameraDetails.cameraStatus.batteryPercentage;
        return typeof level === 'number' ? Math.max(0, Math.min(100, Math.round(level))) : null;
    }

    // Seconds between SimpliSafe's timestamp for an event and now, when it reached the plugin. Events only
    // carry whole seconds, so this is approximate
    eventDelay(data) {
        const time = eventTime(data);
        return time === null ? null : (Date.now() - time) / 1000;
    }

    // For debug logs: how late an event arrived, what the camera was doing, and the clip SimpliSafe records
    describeEvent(data) {
        const delay = this.eventDelay(data);
        const parts = [delay === null ? 'with no timestamp' : `about ${delay.toFixed(1)}s after SimpliSafe's timestamp`];
        // when the camera itself was triggered, if SimpliSafe says
        const trigger = eventTime({ eventTimestamp: data.internal && data.internal.triggerTimestamp });
        if (trigger !== null) parts.push(`${((Date.now() - trigger) / 1000).toFixed(1)}s after the camera was triggered`);
        if (this.liveStatus) parts.push(`camera ${this.liveStatus} for ${Math.round((Date.now() - this.liveStatusAt) / 1000)}s`);
        const clip = eventClip(data);
        if (clip) parts.push(`SimpliSafe clip starts ${typeof clip.preroll === 'number' ? clip.preroll : '?'}s before it`);
        return parts.join(', ');
    }

    onCameraStatus(data) {
        if (!data || data.uuid !== this.id || typeof data.status !== 'string') return;
        // checked once here, every log line that mentions it prints this value
        const status = /^[a-z_]{1,24}$/i.test(data.status) ? data.status : 'unknown';
        if (status === this.liveStatus) return;

        const previous = this.liveStatus;
        this.liveStatus = status;
        this.liveStatusAt = Date.now();
        if (this.debug) {
            const delay = this.eventDelay(data);
            this.log(`'${this.name}' is ${status}${previous ? ` (was ${previous})` : ''}${delay === null ? '' : `, reported ${delay.toFixed(1)}s after the camera's timestamp`}`);
        }
    }

    // With the motionTest option, measures how soon video could follow a motion or doorbell event
    runMotionTest(data, receivedAt) {
        if (!this.cameraOptions || !this.cameraOptions.motionTest || !this.streamingDelegate) return;
        this.streamingDelegate.runMotionTest(data, receivedAt).catch(err => {
            this.log.error(`Motion test for '${this.name}' failed:`, err && err.message);
        });
    }

    startListening() {
        this.simplisafe.on(EVENT_TYPES.CAMERA_STATUS, data => this.onCameraStatus(data));

        const onMotion = event => (data) => {
            if (!this._validateEvent(event, data)) return;
            const receivedAt = Date.now();
            this.lastEventAt = receivedAt;
            if (this.debug) this.log(`Motion: '${this.name}' event arrived ${this.describeEvent(data)}`);
            if (this.streamingDelegate && this.streamingDelegate.noteEvent) this.streamingDelegate.noteEvent(data, receivedAt);
            this.runMotionTest(data, receivedAt);
            this.accessory.getService(this.api.hap.Service.MotionSensor).updateCharacteristic(this.api.hap.Characteristic.MotionDetected, true);
            this.motionIsTriggered = true;
            setTimeout(() => {
                this.accessory.getService(this.api.hap.Service.MotionSensor).updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false);
                this.motionIsTriggered = false;
            }, 5000);
        };
        this.simplisafe.on(EVENT_TYPES.CAMERA_MOTION, onMotion(EVENT_TYPES.CAMERA_MOTION));
        // cameras paired to the base station (e.g. Outdoor Camera) may report motion like a sensor, matched by serial below
        this.simplisafe.on(EVENT_TYPES.MOTION, onMotion(EVENT_TYPES.MOTION));
        this.simplisafe.on(EVENT_TYPES.DOORBELL, (data) => {
            if (!this._validateEvent(EVENT_TYPES.DOORBELL, data)) return;
            const receivedAt = Date.now();
            this.lastEventAt = receivedAt;
            const doorbell = this.accessory.getService(this.api.hap.Service.Doorbell);
            if (this.debug) this.log(`Doorbell: '${this.name}' pressed, event arrived ${this.describeEvent(data)}${doorbell ? ', notifying HomeKit' : ', but it has no doorbell in HomeKit'}`);
            if (this.streamingDelegate && this.streamingDelegate.noteEvent) this.streamingDelegate.noteEvent(data, receivedAt);
            if (doorbell) doorbell.getCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent).setValue(0);
            this.runMotionTest(data, receivedAt);
        });
    }

    _validateEvent(event, data) {
        let valid;
        if (!this.accessory || !data) valid = false;
        else {
            let eventCameraIds = [data.sensorSerial];
            // a sensor's motion event may name a linked camera, only the reporting device counts here
            if (data.internal && event !== EVENT_TYPES.MOTION) eventCameraIds.push(data.internal.mainCamera);
            // events can name the camera by its uuid or by its short serial
            let cameraIds = [this.id, this.cameraDetails && this.cameraDetails.serial].filter(id => id);
            valid = eventCameraIds.some(id => id && cameraIds.indexOf(id) > -1);
        }

        if (this.debug && valid) this.log(`${this.name} camera received event: ${event}`);
        return valid;
    }
}

export default SS3Camera;
