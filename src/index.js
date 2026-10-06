import path from 'path';
import SimpliSafe3, { SENSOR_TYPES, SYSTEM_UPDATED, RateLimitError } from './simplisafe';
import SimpliSafe3AuthenticationManager from './lib/authManager';
import DiagnosticLog, { diagnosticsFilename } from './lib/diagnosticLog';
import { cameraCapabilities } from './lib/diagnosticLines';
import Alarm from './accessories/alarm';
import EntrySensor from './accessories/entrySensor';
import MotionSensor from './accessories/motionSensor';
import SmokeDetector from './accessories/smokeDetector';
import CODetector from './accessories/coDetector';
import WaterSensor from './accessories/waterSensor';
import FreezeSensor from './accessories/freezeSensor';
import DoorLock from './accessories/doorLock';
import Camera from './accessories/camera';
import UnreachableAccessory from './accessories/unreachableAccessory';

// Named apart from homebridge-simplisafe3 so both can be installed and run side by side
const PLUGIN_NAME = 'homebridge-simplisafe3-edited';
const PLATFORM_NAME = 'SimpliSafe 3 Edited';
// this edition is meant to run the cameras next to the original plugin, which keeps the alarm and sensors
const DEFAULT_CAMERAS_ONLY = true;

const cameraRefreshInterval = 10 * 60 * 1000; // ms, keeps camera battery and charging state current

let PLUGIN_VERSION = 'unknown';
try {
    PLUGIN_VERSION = require('./package.json').version; // package.json sits next to index.js once built
} catch (err) { /* running from source */ }

let UUIDGen;

class SS3Platform {

    constructor(log, config, api) {
        log = this.keepLogsForClaude(log, config, api);
        this.log = log;
        this.name = config.name;
        // only cameras, e.g. to run them on their own bridge next to another instance with the alarm and sensors
        this.camerasOnly = config.camerasOnly !== undefined ? !!config.camerasOnly : DEFAULT_CAMERAS_ONLY;
        this.enableCameras = config.cameras || this.camerasOnly;
        this.cameraOptions = config.cameraOptions || null;
        this.debug = config.debug || false;
        this.persistAccessories = config.persistAccessories !== undefined ? config.persistAccessories : true;
        this.excludedDevices = config.excludedDevices || [];
        this.devices = [];
        this.accessories = [];
        this.api = api;

        this.cachedAccessoryConfig = [];
        this.unreachableAccessories = [];

        let refreshInterval = 15000;
        if (config.sensorRefresh) {
            refreshInterval = config.sensorRefresh * 1000;
        }

        this.snapshotDir = path.join(this.api.user.storagePath(), `${PLUGIN_NAME}-snapshots`);
        this.authManager = new SimpliSafe3AuthenticationManager(this.api.user.storagePath(), log, this.debug);
        this.simplisafe = new SimpliSafe3(refreshInterval, this.authManager, this.api.user.storagePath(), log, this.debug);

        if (config.subscriptionId) {
            if (this.debug) this.log(`Specifying account number: ${config.subscriptionId}`);
            this.simplisafe.setDefaultSubscription(config.subscriptionId);
        }

        if (config.auth && config.auth.username && config.auth.password && !this.authManager.accountsFileExists()) {
            // this will flag authManager to try username / pw login
            this.authManager.username = config.auth.username;
            this.authManager.password = config.auth.password;
        }

        this.initialLoad = this.authManager.refreshCredentials()
            .then(() => {
                return this.discoverSimpliSafeDevices();
            })
            .catch(err => {
                if (err instanceof RateLimitError) {
                    this.log.error('Initial load failed due to rate limiting or connectivity, trying again later');
                    setTimeout(async () => {
                        await this.retryBlockedAccessories();
                    }, this.simplisafe.nextAttempt - Date.now());
                } else {
                    this.log.error('SimpliSafe login failed with error:', err.toJSON ? err.toJSON() : err);
                    this.log.error('See the plugin README for more information on authenticating with SimpliSafe.');
                }
            });

        this.api.on('didFinishLaunching', () => {
            if (this.debug) this.log(`Found ${this.cachedAccessoryConfig.length} cached accessories to be configured.`);
            if (this.debug) this.log('Attempting intial SimpliSafe credentials refresh.');
            this.initialLoad
                .then(() => {
                    return Promise.all(this.cachedAccessoryConfig);
                })
                .then(() => {
                    if (!this.authManager.isAuthenticated()) throw new Error('Not authenticated with SimpliSafe.');
                    else {
                        this.simplisafe.startListening();
                        this.createNewPlatformAccessories();
                        this.startCameraRefresh();
                    }
                })
                .catch(err => {
                    this.log.error('Initial accessories refresh failed with error:', err.toJSON ? err.toJSON() : err);
                });
        });
    }

    configureAccessory(accessory) {
        let config = new Promise((resolve, reject) => {
            this.initialLoad
                .then(() => {
                    if (this.simplisafe.isBlocked) {
                        let unreachableAccessory = new UnreachableAccessory(accessory, this.api);
                        this.unreachableAccessories.push(unreachableAccessory);

                        return resolve();
                    }

                    let device = this.devices.find(device => device.uuid === accessory.UUID);

                    if (device) {
                        if (this.debug) this.log(`Initializing device ${device.constructor.name} '${device.name ? device.name : device.uuid}' with cached accessory`);
                        device.setAccessory(accessory);
                        this.accessories.push(accessory);
                    } else {
                        if (this.debug) this.log(`Cached accessory {${accessory.UUID}} not matched to a SimpliSafe device`);
                        if (!this.authManager.isAuthenticated() && accessory.services.find(s => s.UUID == this.api.hap.Service.SecuritySystem.UUID) &&
                            accessory._associatedPlugin == PLUGIN_NAME) {
                            // In the case of initial auth failure instantiate the cached alarm and set fault
                            const alarmAccessory = new Alarm(
                                'SimpliSafe 3',
                                '000',
                                this.log,
                                this.debug,
                                this.simplisafe,
                                this.api
                            );
                            
                            this.devices.push(alarmAccessory);
                            alarmAccessory.setAccessory(accessory);
                            alarmAccessory.setFault();
                        } else {
                            if (this.camerasOnly && this.persistAccessories && !accessory.services.find(s => s.UUID == this.api.hap.Service.CameraRTPStreamManagement.UUID)) {
                                this.log.warn(`'${accessory.displayName}' is kept but no longer updated because Cameras Only is on. Remove it from Homebridge (Settings, Remove Single Cached Accessory) if you don't need it.`);
                            }
                            this.removeAccessory(accessory);
                        }
                    }

                    resolve();
                })
                .catch(err => {
                    reject(err);
                });
        });

        this.cachedAccessoryConfig.push(config);
    }

    removeAccessory(accessory) {
        if (accessory) {
            if (!this.persistAccessories && !this.simplisafe.isBlocked) {
                if (this.debug) this.log('Removing accessory', accessory.name ?? accessory.UUID);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            if (this.accessories.indexOf(accessory) > -1) {
                this.accessories.splice(this.accessories.indexOf(accessory), 1);
            }
        }
    }

    createNewPlatformAccessories() {
        for (let device of this.devices) {
            let existingAccessory = this.accessories.find(acc => acc.UUID == device.uuid);
            if (!existingAccessory) {
                if (this.debug) this.log(`Initializing SS device '${device.name}' with new accessory.`);
                let accessory = device.createAccessory(); // from SimpliSafe3Accessory
                try {
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    this.accessories.push(accessory);
                } catch (err) {
                    this.log.error('An error occurred while adding accessory:', err.toJSON ? err.toJSON() : err);
                }
            }
        }
    }

    // Keeps this plugin's recent log lines, without secrets, for the settings page's 'Logs for Claude' card
    keepLogsForClaude(log, config, api) {
        if (config.logsForClaude === false) return log;

        this.diagnosticLog = new DiagnosticLog({
            file: path.join(api.user.storagePath(), diagnosticsFilename),
            version: PLUGIN_VERSION,
            summary: () => this.cameraSummary()
        });
        api.on('shutdown', () => this.diagnosticLog.flush(true));
        return this.diagnosticLog.wrap(log);
    }

    cameraSummary() {
        const cameras = (this.devices || []).filter(device => device instanceof Camera);
        if (!cameras.length) return '';
        return cameras.map(camera => camera.diagnostics()).join('\n');
    }

    // Camera details, e.g. battery level, are only fetched with the alarm system, so pass on every update
    // and ask for one now and then in case nothing else does
    startCameraRefresh() {
        if (!this.enableCameras || this.cameraRefreshIntervalID) return;

        this.simplisafe.on(SYSTEM_UPDATED, system => {
            try {
                this.updateCameraDetails(system.cameras);
            } catch (err) {
                this.log.error('An error occurred while updating camera details:', err);
            }
        });

        this.cameraRefreshIntervalID = setInterval(() => {
            this.simplisafe.getCameras().catch(err => {
                if (this.debug && !(err instanceof RateLimitError)) this.log.error('Camera details refresh failed:', err.message || err);
            });
        }, cameraRefreshInterval);
    }

    updateCameraDetails(cameras) {
        if (!Array.isArray(cameras)) return;
        for (let device of this.devices) {
            if (!(device instanceof Camera)) continue;
            let details = cameras.find(camera => camera.uuid === device.id);
            if (details) device.updateCameraDetails(details);
        }
    }

    async discoverSimpliSafeDevices() {
        if (this.debug) this.log('Discovering devices from SimpliSafe');
        try {
            let subscription = await this.simplisafe.getSubscription();
            if (subscription.location.system.serial == null) throw new Error('System serial not found.');
            let uuid = UUIDGen.generate(subscription.location.system.serial);
            let alarm = this.accessories.find(acc => acc.UUID === uuid);

            if (!alarm && !this.camerasOnly) {
                const alarmAccessory = new Alarm(
                    'SimpliSafe 3',
                    subscription.location.system.serial,
                    this.log,
                    this.debug,
                    this.simplisafe,
                    this.api
                );

                this.devices.push(alarmAccessory);
            }

            let sensors = this.camerasOnly ? [] : await this.simplisafe.getSensors();
            for (let sensor of sensors) {
                if (sensor.type == SENSOR_TYPES.KEYPAD ||
                    sensor.type == SENSOR_TYPES.KEYCHAIN ||
                    sensor.type == SENSOR_TYPES.PANIC_BUTTON ||
                    sensor.type == SENSOR_TYPES.GLASSBREAK_SENSOR ||
                    sensor.type == SENSOR_TYPES.SIREN ||
                    sensor.type == SENSOR_TYPES.SIREN_2 ||
                    sensor.type == SENSOR_TYPES.DOORLOCK ||
                    sensor.type == SENSOR_TYPES.DOORLOCK_2 ||
                    sensor.type == SENSOR_TYPES.OUTDOOR_CAMERA ||
                    sensor.type == SENSOR_TYPES.OUTDOOR_CAMERA_2) {
                    // Ignore as no data is provided by SimpliSafe
                    // Door locks are configured below, cameras with the other cameras
                    continue;
                }

                let uuid = UUIDGen.generate(sensor.serial);
                let accessory = this.accessories.find(acc => acc.UUID === uuid);
                let sensorName = sensor.name;
                if (this.debug) {
                    this.log(`Discovered sensor '${sensor.name}' from SimpliSafe:`, JSON.stringify(sensor));
                }

                if (sensor.serial && this.excludedDevices.includes(sensor.serial)) {
                    this.log.info(`Excluding sensor with serial '${sensor.serial}'`);
                    continue;
                }

                if (sensor.type == SENSOR_TYPES.ENTRY_SENSOR) {
                    if (!accessory) {
                        sensorName = sensorName || `Entry Sensor ${sensor.serial}`;
                        const sensorAccessory = new EntrySensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type == SENSOR_TYPES.CO_SENSOR) {
                    if (!accessory) {
                        sensorName = sensorName || `CO Detector ${sensor.serial}`;
                        const sensorAccessory = new CODetector(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type == SENSOR_TYPES.SMOKE_SENSOR) {
                    if (!accessory) {
                        sensorName = sensorName || `Smoke Detector ${sensor.serial}`;
                        const sensorAccessory = new SmokeDetector(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type == SENSOR_TYPES.WATER_SENSOR) {
                    if (!accessory) {
                        sensorName = sensorName || `Water Sensor ${sensor.serial}`;
                        const sensorAccessory = new WaterSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type == SENSOR_TYPES.FREEZE_SENSOR) {
                    if (!accessory) {
                        sensorName = sensorName || `Freeze Sensor ${sensor.serial}`;
                        const sensorAccessory = new FreezeSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type == SENSOR_TYPES.MOTION_SENSOR) {
                    sensorName = sensorName || `Motion Sensor ${sensor.serial}`;
                    // Check if secret alerts are enabled
                    if (sensor.setting.off == 0 || sensor.setting.home == 0 || sensor.setting.away == 0) {
                        this.log.warn(`Motion Sensor '${sensorName}' requires secret alerts to be enabled in SimpliSafe before you can add it to Homebridge.`);
                        continue;
                    }
                    if (!accessory) {
                        const sensorAccessory = new MotionSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else {
                    this.log.warn(`Sensor not (yet) supported: ${sensor.name}`);
                    this.log.warn(sensor);
                }
            }

            let locks = this.camerasOnly ? [] : await this.simplisafe.getLocks();
            for (let lock of locks) {
                let lockName = lock.name || `Smart Lock ${lock.serial}`;
                let uuid = UUIDGen.generate(lock.serial);

                if (this.debug) {
                    this.log(`Discovered door lock '${lockName}' from SimpliSafe:`, JSON.stringify(lock));
                }

                let accessory = this.accessories.find(acc => acc.UUID === uuid);
                if (!accessory) {
                    const lockAccessory = new DoorLock(
                        lockName,
                        lock.serial,
                        this.log,
                        this.debug,
                        this.simplisafe,
                        this.api
                    );

                    this.devices.push(lockAccessory);
                }

            }

            if (this.enableCameras) {
                let cameras = await this.simplisafe.getCameras();

                for (let camera of cameras) {
                    let cameraName = camera.cameraSettings.cameraName || `Camera ${camera.uuid}`;
                    let uuid = UUIDGen.generate(camera.uuid);

                    if (this.debug) {
                        this.log(`Discovered camera '${cameraName}' from SimpliSafe:`, JSON.stringify(camera));
                        // the details above are too long for Logs for Claude, this is what matters in them
                        this.log(`Camera '${cameraName}' ${cameraCapabilities(camera)}`);
                    }

                    if (camera.serial && this.excludedDevices.includes(camera.serial)) {
                        this.log.info(`Excluding camera with serial '${camera.serial}'`);
                        continue;
                    }

                    let cameraAccessory = this.accessories.find(acc => acc.UUID === uuid);
                    if (!cameraAccessory) {
                        const cameraAccessory = new Camera(
                            cameraName,
                            camera.uuid,
                            camera,
                            this.cameraOptions,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.authManager,
                            this.api,
                            { snapshotDir: this.snapshotDir }
                        );
                        if (cameraAccessory.isUnsupported()) this.log.warn(`Detected unsupported camera ${cameraName}, some features will be disabled.`);

                        this.devices.push(cameraAccessory);
                    }
                }
            }
        } catch (err) {
            if (err instanceof RateLimitError) {
                this.log.error('Accessory refresh failed due to rate limiting or connectivity:', err.toJSON ? err.toJSON() : err);
                this.log.info('Note: this error can also occur if you are not signed up for a SimpliSafe monitoring plan.');
            } else {
                this.log.error('An error occurred while refreshing accessories:', err.toJSON ? err.toJSON() : err);
            }
            throw err;
        }

    }

    updateAccessoriesReachability() {
        if (this.debug) this.log('Updating reacahability');
        for (let accessory of this.accessories) {
            accessory.updateReachability();
        }
    }

    async retryBlockedAccessories() {
        try {
            await this.authManager.refreshCredentials();
            if (this.debug) this.log('Recovered from 403 rate limit!');
            await this.discoverSimpliSafeDevices();
            this.cachedAccessoryConfig = [];
            for (let accessory of this.unreachableAccessories) {
                accessory.clearAccessory();
                this.configureAccessory(accessory.accessory);
            }
            await Promise.all(this.cachedAccessoryConfig);
            this.createNewPlatformAccessories();
        } catch (err) {
            if (err instanceof RateLimitError) {
                this.log.error('Credentials refresh attempt failed, still rate limited');
                setTimeout(async () => {
                    await this.retryBlockedAccessories();
                }, this.simplisafe.nextAttempt - Date.now());
            } else {
                this.log.error('An error occurred while refreshing credentials again:', err.toJSON ? err.toJSON() : err);
            }
        }
    }

}

const homebridge = homebridge => {
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SS3Platform, true);
};

export default homebridge;
