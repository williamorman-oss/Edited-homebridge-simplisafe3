import path from 'path';
import SimpliSafe3, { SYSTEM_UPDATED, RateLimitError } from './simplisafe';
import SimpliSafe3AuthenticationManager from './lib/authManager';
import DiagnosticLog, { diagnosticsFilename } from './lib/diagnosticLog';
import { cameraCapabilities } from './lib/diagnosticLines';
import Camera from './accessories/camera';
import UnreachableAccessory from './accessories/unreachableAccessory';

// Named apart from homebridge-simplisafe3 so both can be installed and run side by side. This plugin only
// has the cameras, the alarm, sensors and locks stay with the original
const PLUGIN_NAME = 'homebridge-simplisafe3-edited';
const PLATFORM_NAME = 'SimpliSafe 3 Edited';

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
        this.cameraOptions = config.cameraOptions || null;
        this.debug = config.debug || false;
        this.persistAccessories = config.persistAccessories !== undefined ? config.persistAccessories : true;
        this.excludedDevices = config.excludedDevices || [];
        this.devices = [];
        this.accessories = [];
        this.api = api;

        this.cachedAccessoryConfig = [];
        this.unreachableAccessories = [];
        this.discovered = false; // whether SimpliSafe has listed the cameras, nothing is removed before that

        if (config.camerasOnly === false) {
            this.log.warn('This plugin only adds cameras, Cameras Only is no longer a setting. The alarm, sensors and locks are for homebridge-simplisafe3.');
        }

        this.snapshotDir = path.join(this.api.user.storagePath(), `${PLUGIN_NAME}-snapshots`);
        this.authManager = new SimpliSafe3AuthenticationManager(this.api.user.storagePath(), log, this.debug);
        this.simplisafe = new SimpliSafe3(this.authManager, this.api.user.storagePath(), log, this.debug);

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
                        this.simplisafe.startListening().catch(err => this.log.error('SimpliSafe real time events could not start:', err));
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
                        if (this.debug) this.log(`Initializing camera '${device.name ? device.name : device.uuid}' with cached accessory`);
                        device.setAccessory(accessory);
                        this.accessories.push(accessory);
                    } else {
                        if (this.debug) this.log(`Cached accessory {${accessory.UUID}} not matched to a SimpliSafe camera`);
                        if (!accessory.services.find(s => s.UUID == this.api.hap.Service.CameraRTPStreamManagement.UUID)) {
                            // an alarm, sensor or lock from before this plugin was camera-only can never be updated
                            // again: kept, it would answer HomeKit with its last state, and on a shared bridge it would
                            // stop homebridge-simplisafe3 adding its own (same UUID)
                            this.log.warn(`Removing '${accessory.displayName}' from HomeKit, this plugin only has cameras. The alarm, sensors and locks are for homebridge-simplisafe3.`);
                            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                        } else {
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
            // a failed login or discovery lists no cameras, that does not mean they are gone
            if (!this.persistAccessories && !this.simplisafe.isBlocked && this.discovered) {
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
                if (this.debug) this.log(`Initializing camera '${device.name}' with new accessory.`);
                let accessory = device.createAccessory(); // from SimpliSafe3Accessory
                // a camera is the same accessory in homebridge-simplisafe3, and one bridge can only have it once
                const alreadyOnBridge = `Could not add '${device.name}': this bridge already has it, probably from homebridge-simplisafe3. Run this plugin as a child bridge (Bridge Settings), or turn off cameras in homebridge-simplisafe3 and remove its camera accessories (Settings, Remove Single Cached Accessory).`;
                try {
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    // Homebridge 2 skips an accessory whose UUID the bridge already has, with only a warning
                    if (accessory._associatedHAPAccessory && accessory._associatedHAPAccessory.bridged === false) {
                        this.log.error(alreadyOnBridge);
                        continue;
                    }
                    this.accessories.push(accessory);
                } catch (err) {
                    if (/same UUID/i.test(String(err && err.message))) {
                        this.log.error(alreadyOnBridge);
                    } else {
                        this.log.error('An error occurred while adding accessory:', err.toJSON ? err.toJSON() : err);
                    }
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
        return (this.devices || []).map(camera => camera.diagnostics()).join('\n');
    }

    // Camera details, e.g. battery level, are only fetched with the alarm system, so pass on every update
    // and ask for one now and then in case nothing else does
    startCameraRefresh() {
        if (this.cameraRefreshIntervalID) return;

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
            let details = cameras.find(camera => camera.uuid === device.id);
            if (details) device.updateCameraDetails(details);
        }
    }

    async discoverSimpliSafeDevices() {
        if (this.debug) this.log('Discovering cameras from SimpliSafe');
        try {
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
                        { snapshotDir: this.snapshotDir, recording: this.recordingFor(cameraName) }
                    );
                    if (cameraAccessory.isUnsupported()) this.log.warn(`Detected unsupported camera ${cameraName}, some features will be disabled.`);

                    this.devices.push(cameraAccessory);
                }
            }
            this.discovered = true;
        } catch (err) {
            if (err instanceof RateLimitError) {
                this.log.error('Camera discovery failed due to rate limiting or connectivity:', err.toJSON ? err.toJSON() : err);
                this.log.info('Note: this error can also occur if you are not signed up for a SimpliSafe monitoring plan.');
            } else {
                this.log.error('An error occurred while discovering cameras:', err.toJSON ? err.toJSON() : err);
            }
            throw err;
        }

    }

    // HomeKit Secure Video is switched on per camera, by name, in cameraOptions.record and alwaysConnected
    recordingFor(cameraName) {
        const options = this.cameraOptions || {};
        const listed = list => (Array.isArray(list) ? list : []).some(name => String(name).trim().toLowerCase() === cameraName.trim().toLowerCase());
        const enabled = listed(options.record);
        return { enabled, alwaysConnected: enabled && listed(options.alwaysConnected) };
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
