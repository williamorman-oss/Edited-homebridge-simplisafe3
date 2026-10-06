import axios from 'axios';
import axiosRetry from 'axios-retry';
import WebSocket from 'ws';
import EventEmitter from 'events';
import { AUTH_EVENTS } from './lib/authManager';
import { eventShape } from './lib/diagnosticLines';

export const VALID_ALARM_STATES = [
    'off',
    'home',
    'away'
];

export const VALD_LOCK_STATES = [
    'lock',
    'unlock'
];

export const SENSOR_TYPES = {
    'APP': 0,
    'KEYPAD': 1,
    'KEYCHAIN': 2,
    'PANIC_BUTTON': 3,
    'MOTION_SENSOR': 4,
    'ENTRY_SENSOR': 5,
    'GLASSBREAK_SENSOR': 6,
    'CO_SENSOR': 7,
    'SMOKE_SENSOR': 8,
    'WATER_SENSOR': 9,
    'FREEZE_SENSOR': 10,
    'SIREN': 11,
    'SIREN_2': 13,
    'DOORLOCK': 16,
    // cameras paired to the base station are listed as sensors too, they are set up from the camera list
    'OUTDOOR_CAMERA': 17,
    'OUTDOOR_CAMERA_2': 23,
    'DOORLOCK_2': 253
};

export const EVENT_TYPES = {
    ALARM_TRIGGER: 'ALARM_TRIGGER',
    ALARM_OFF: 'ALARM_OFF',
    ALARM_DISARM: 'ALARM_DISARM',
    ALARM_CANCEL: 'ALARM_CANCEL',
    HOME_EXIT_DELAY: 'HOME_EXIT_DELAY',
    HOME_ARM: 'HOME_ARM',
    AWAY_EXIT_DELAY: 'AWAY_EXIT_DELAY',
    AWAY_ARM: 'AWAY_ARM',
    MOTION: 'MOTION',
    ENTRY: 'ENTRY',
    CAMERA_MOTION: 'CAMERA_MOTION',
    DOORBELL: 'DOORBELL',
    DOORLOCK_LOCKED: 'DOORLOCK_LOCKED',
    DOORLOCK_UNLOCKED: 'DOORLOCK_UNLOCKED',
    DOORLOCK_ERROR: 'DOORLOCK_ERROR',
    POWER_OUTAGE: 'POWER_OUTAGE',
    POWER_RESTORED: 'POWER_RESTORED',
    USER_INITIATED_TEST: 'USER_INITIATED_TEST',
    // a camera woke up, went to sleep, went offline or came back
    CAMERA_STATUS: 'CAMERA_STATUS',
};

// Emitted with the alarm system whenever it is fetched, it also carries the cameras' battery and charging state
export const SYSTEM_UPDATED = 'SYSTEM_UPDATED';

export class RateLimitError extends Error {
    constructor(...params) {
        super(...params);
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, RateLimitError);
        }
        this.name = 'RateLimitError';
    }
}

const subscriptionCacheTime = 3000; // ms
const sensorCacheTime = 3000; // ms
const rateLimitInitialInterval = 60000; // ms
const rateLimitMaxInterval = 2 * 60 * 60 * 1000; // ms
const sensorRefreshLockoutDuration = 20000; // ms
const errorSuppressionDuration = 5 * 60 * 1000; // ms
const alarmRefreshInterval = 62000; // ms, avoid overlap with sensor refresh
const alarmStateTrustTime = 10000; // ms an alarm state is relied on for the privacy shutter before asking again
const apiTimeout = 30000; // ms
const appHubTimeout = 15000; // ms

const wsUrl = 'wss://socketlink.prd.aser.simplisafe.com';
const socketRetryInterval = 1000; //ms
const socketHeartbeatInterval = 60 * 1000; //ms

const ssApi = axios.create({
    baseURL: 'https://api.simplisafe.com/v1',
    timeout: apiTimeout
});

const pluginUserAgent = 'homebridge-simplisafe3';
const appHubApi = axios.create({
    baseURL: 'https://app-hub.prd.aser.simplisafe.com',
    timeout: appHubTimeout,
    headers: {
        'User-Agent': pluginUserAgent,
        'Accept': 'application/json, text/plain, */*'
    }
});

class SimpliSafe3 extends EventEmitter {

    authManager;
    userId;
    subId;
    accountNumber;
    socket;
    lastSubscriptionRequests = {};
    lastSensorRequest;
    lastLockRequest;
    alarmRefreshIntervalID;
    alarmSubscriptions = [];
    sensorRefreshIntervalID;
    sensorRefreshTime;
    refreshLockoutTimeoutID;
    refreshLockoutEnabled = false;
    sensorSubscriptions = [];
    errorSupperessionTimeoutID;
    nSuppressedErrors;
    storagePath;
    nSocketConnectFailures = 0;
    socketHeartbeatIntervalID;
    socketIsAlive;
    isAwaitingSocketReconnect;
    isBlocked;
    nextBlockInterval = rateLimitInitialInterval;
    nextAttempt = 0;
    lastAlarmState = null;
    lastAlarmStateAt = 0;
    lastAlarmEventAt = 0;
    alarmStateRefresh = null;

    constructor(sensorRefreshTime = 15000, authManager, storagePath, log, debug) {
        super();
        this.sensorRefreshTime = sensorRefreshTime;
        this.log = log || console.log;
        this.debug = debug;
        this.storagePath = storagePath;
        this.authManager = authManager;
        this.authManager.on(AUTH_EVENTS.REFRESH_CREDENTIALS_FAILURE, () => {
            if (this.socket) this.handleSocketConnectionFailure();
        });
        
        axiosRetry(ssApi, { retries: 2 });

        this.resetRateLimitHandler();

        // every camera and sensor listens for events
        this.setMaxListeners(100);
        this.trackAlarmState();
    }

    // Keeps the alarm state from realtime events so camera snapshots can decide on the privacy shutter.
    // An arm or disarm event from a source the state can't be read from clears it, so it is asked for again
    trackAlarmState() {
        const controls = [SENSOR_TYPES.APP, SENSOR_TYPES.KEYPAD, SENSOR_TYPES.KEYCHAIN, SENSOR_TYPES.DOORLOCK, SENSOR_TYPES.DOORLOCK_2];
        const fromControl = data => data && controls.includes(Number(data.sensorType));
        const states = {
            [EVENT_TYPES.ALARM_DISARM]: 'OFF',
            [EVENT_TYPES.ALARM_CANCEL]: 'OFF',
            [EVENT_TYPES.ALARM_OFF]: 'OFF',
            [EVENT_TYPES.HOME_ARM]: 'HOME',
            [EVENT_TYPES.AWAY_ARM]: 'AWAY',
            [EVENT_TYPES.HOME_EXIT_DELAY]: 'HOME_COUNT',
            [EVENT_TYPES.AWAY_EXIT_DELAY]: 'AWAY_COUNT'
        };
        for (const [event, state] of Object.entries(states)) {
            this.on(event, data => {
                if (fromControl(data)) this.recordAlarmState(state, Date.now(), true);
                else this.forgetAlarmState();
            });
        }
        this.on(EVENT_TYPES.ALARM_TRIGGER, () => this.recordAlarmState('ALARM', Date.now(), true));
    }

    // observedAt is when the state was true, an API reply never overrides a newer event
    recordAlarmState(state, observedAt = Date.now(), fromEvent = false) {
        if (!state) return;
        if (fromEvent) this.lastAlarmEventAt = observedAt;
        else if (observedAt < this.lastAlarmEventAt) return;
        this.lastAlarmState = state;
        this.lastAlarmStateAt = observedAt;
    }

    forgetAlarmState() {
        this.lastAlarmState = null;
        this.lastAlarmStateAt = 0;
        this.lastAlarmEventAt = Date.now();
    }

    // The current alarm state, asking SimpliSafe unless it was seen in the last few seconds.
    // Resolves null if it cannot be found within timeout ms, it never falls back to an older state
    async getCurrentAlarmState(timeout = 3000) {
        const trusted = () => this.lastAlarmState && Date.now() - this.lastAlarmStateAt < alarmStateTrustTime ? this.lastAlarmState : null;
        if (trusted()) return trusted();

        if (!this.alarmStateRefresh) {
            this.alarmStateRefresh = this.getAlarmSystem()
                .finally(() => { this.alarmStateRefresh = null; });
            this.alarmStateRefresh.catch(() => {});
        }

        let timeoutID;
        try {
            await Promise.race([
                this.alarmStateRefresh,
                new Promise(resolve => { timeoutID = setTimeout(resolve, timeout); })
            ]);
            return trusted();
        } catch (err) {
            return null;
        } finally {
            clearTimeout(timeoutID);
        }
    }

    resetRateLimitHandler() {
        this.isBlocked = false;
        this.nextBlockInterval = rateLimitInitialInterval;
    }

    // grow is false for timeouts, which are not a sign of being rate limited
    setRateLimitHandler(grow = true) {
        this.isBlocked = true;
        this.nextAttempt = Date.now() + (grow ? this.nextBlockInterval : rateLimitInitialInterval);
        if (grow && this.nextBlockInterval < rateLimitMaxInterval) {
            this.nextBlockInterval = this.nextBlockInterval * 2;
        }
    }

    async request(params) {
        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Blocking request: rate limited');
            throw err;
        }

        if (!this.authManager.isAuthenticated()) {
            try {
                await this.authManager.refreshCredentials();
                if (this.debug) this.log('Credentials refreshed successfully after failed request');
            } catch (credentialsErr) {
                if (this.debug) this.log.error('Recovery credentials refresh failed with error:', credentialsErr.toJSON ? credentialsErr.toJSON() : credentialsErr);
                if (credentialsErr.isAxiosError) {
                    throw new Error(`${credentialsErr.response.status}: ${credentialsErr.response.statusText}`);
                } else {
                    throw credentialsErr;
                }
            }
        }

        try {
            const response = await ssApi.request({
                ...params,
                headers: {
                    ...params.headers,
                    Authorization: `${this.authManager.tokenType} ${this.authManager.accessToken}`
                }
            });
            this.resetRateLimitHandler();
            return response.data;
        } catch (err) {
            if (!err.response) {
                let rateLimitError = new RateLimitError(err);
                const timedOut = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
                this.log.error(timedOut ? 'SSAPI request timed out, retrying later.' : 'SSAPI request failed, request blocked (rate limit or auth failure?).');
                this.setRateLimitHandler(!timedOut);
                throw rateLimitError;
            }

            let statusCode = err.response.status;
            if (statusCode == 403) {
                this.log.error('SSAPI request failed, request blocked (rate limit or auth failure?).');
                if (this.debug) this.log.error('SSAPI request received a response error with code 403:', err.response.statusText);
                this.setRateLimitHandler();
                throw new RateLimitError(err.response.data);
            } else {
                throw err.response.data;
            }
        }
    }

    async getUserId() {
        if (this.userId) {
            return this.userId;
        }

        let data = await this.request({
            method: 'GET',
            url: '/api/authCheck'
        });
        this.userId = data.userId;
        return this.userId;
    }

    async getSubscriptions() {
        let userId = await this.getUserId();
        let data = await this.request({
            method: 'GET',
            url: `/users/${userId}/subscriptions?activeOnly=false`
        });

        // sStatus 7: Unmonitored & self-monitoring
        // sStatus 10: Standard
        // sStatus 20: Interactive
        let subscriptions = data.subscriptions.filter(s => [7, 10, 20].includes(s.sStatus));

        if (this.accountNumber) {
            subscriptions = subscriptions.filter(s => s.location.account === this.accountNumber);
        }

        // Free trials can have same accountNumber but only one should be "activated"
        if (subscriptions.length > 1) subscriptions = subscriptions.filter(s => s.activated > 0);

        if (subscriptions.length == 1) {
            this.subId = subscriptions[0].sid;
        }

        return subscriptions;
    }

    async getSubscription(forceRefresh = false) {
        let subscriptionId = this.subId;

        if (!subscriptionId) {
            let subs = await this.getSubscriptions();
            if (subs.length == 1) {
                subscriptionId = subs[0].sid;
            } else if (subs.length == 0) {
                throw new Error('No matching monitoring plans found. Check your account and ensure you have an active plan.');
            } else {
                let accountNumbers = subs.map(s => s.location.account);
                throw new Error(`Multiple accounts found. You must specify an account number in the plugin settings. See README https://github.com/homebridge-simplisafe3/homebridge-simplisafe3#subscriptionid-account-number for more info. The account numbers found were: ${accountNumbers.join(', ')}.`);
            }
        }

        if (forceRefresh || !this.lastSubscriptionRequests[subscriptionId]) {
            this.lastSubscriptionRequests[subscriptionId] = await this.request({
                method: 'GET',
                url: `/subscriptions/${subscriptionId}/`
            })
                .then(sub => {
                    return sub;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSubscriptionRequests[subscriptionId] = null;
                    }, subscriptionCacheTime);
                });
        }

        let data = this.lastSubscriptionRequests[subscriptionId];
        return data.subscription;
    }

    setDefaultSubscription(accountNumber) {
        if (!accountNumber) {
            throw new Error('Account Number not defined');
        }

        this.accountNumber = accountNumber;
    }

    async getAlarmSystem(forceRefresh = false) {
        // a cached subscription can be up to subscriptionCacheTime older than this request
        let requestedAt = Date.now() - (forceRefresh ? 0 : subscriptionCacheTime);
        let subscription = await this.getSubscription(forceRefresh);

        if (subscription.location && subscription.location.system) {
            let system = subscription.location.system;
            this.recordAlarmState(system.alarmState, requestedAt);
            this.emit(SYSTEM_UPDATED, system);
            return system;
        } else {
            throw new Error('Subscription format not understood:', subscription);
        }
    }

    async setAlarmState(newState) {
        let state = newState.toLowerCase();

        if (VALID_ALARM_STATES.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.request({
            method: 'POST',
            url: `/ss3/subscriptions/${this.subId}/state/${state}`
        });

        this.handleSensorRefreshLockout();
        
        return data;
    }

    async getSensors(forceUpdate = false, forceRefresh = false) {
        if (!this.subId) {
            await this.getSubscription();
        }

        if (forceRefresh || !this.lastSensorRequest) {
            this.lastSensorRequest = await this.request({
                method: 'GET',
                url: `/ss3/subscriptions/${this.subId}/sensors?forceUpdate=${forceUpdate ? 'true' : 'false'}`
            })
                .then(data => {
                    return data;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSensorRequest = null;
                    }, sensorCacheTime);
                });
        }

        let data = this.lastSensorRequest;
        return data.sensors;
    }

    async getCameras(forceRefresh = false) {
        let system = await this.getAlarmSystem(forceRefresh);

        if (system.cameras) {
            return system.cameras;
        } else {
            throw new Error('Error getting alarm system');
        }
    }

    // Returns LiveKit room details for cameras (internally 'MIST')
    // token is short lived so it must be fetched per stream, not cached
    async getCameraLiveView(cameraUuid) {
        if (this.isBlocked && Date.now() < this.nextAttempt) {
            throw new RateLimitError('Blocking request: rate limited');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        if (!this.authManager.isAuthenticated()) {
            await this.authManager.refreshCredentials();
        }

        try {
            const response = await appHubApi.request({
                method: 'GET',
                url: `/v2/cameras/${cameraUuid}/${this.subId}/live-view`,
                headers: {
                    Authorization: `${this.authManager.tokenType} ${this.authManager.accessToken}`
                }
            });
            this.resetRateLimitHandler();

            const details = response.data && response.data.liveKitDetails;
            if (!details || !details.liveKitURL || !details.userToken) {
                // only field names: the reply can hold signed links and credentials
                const data = response.data && typeof response.data === 'object' ? response.data : {};
                const fields = object => Object.keys(object).filter(key => /^[A-Za-z_]+$/.test(key)).join(',') || 'none';
                const inner = details && typeof details === 'object' ? ` (liveKitDetails has ${fields(details)})` : '';
                const status = typeof data.cameraStatus === 'string' && /^[a-z_]{1,24}$/i.test(data.cameraStatus) ? `, cameraStatus ${data.cameraStatus}` : '';
                throw new Error(`Unexpected live-view response: fields ${fields(data)}${inner}${status}`);
            }

            return { ...details, cameraStatus: response.data.cameraStatus };
        } catch (err) {
            if (err.response && err.response.status === 403) {
                this.setRateLimitHandler();
                throw new RateLimitError(err.response.data);
            }
            throw err;
        }
    }

    async getLocks(forceRefresh) {
        if (!this.subId) {
            await this.getSubscription();
        }

        if (forceRefresh || !this.lastLockRequest) {
            this.lastLockRequest = await this.request({
                method: 'GET',
                url: `/doorlock/${this.subId}`
            })
                .then(data => {
                    return data;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastLockRequest = null;
                    }, sensorCacheTime);
                });
        }

        let data = this.lastLockRequest;
        this.refreshLockoutEnabled = data.length > 0;
        return data;

    }

    async setLockState(lockId, newState) {
        let state = newState.toLowerCase();

        if (VALD_LOCK_STATES.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.request({
            method: 'POST',
            url: `/doorlock/${this.subId}/${lockId}/state`,
            data: {
                state: state
            }
        });

        return data;
    }

    async startListening() {
        if (this.socket) return;

        if (!this.authManager.isAuthenticated()) {
            this.log.error('Socket connect ignored: Not authenticated with SimpliSafe');
            this.handleSocketConnectionFailure();
            return;
        }

        let userId = await this.getUserId();
        this.socket = new WebSocket(wsUrl, {
            handshakeTimeout: 5000
        });

        this.socket.on('open', () => {
            if (this.debug) this.log('SSAPI socket `open`');
            this.socket.send(JSON.stringify({
                'datacontenttype': 'application/json',
                'type': 'com.simplisafe.connection.identify',
                'time': new Date().toISOString(),
                'id': `ts:${Date.now()}`,
                'specversion': '1.0',
                'source': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
                'data': {
                    'auth': {
                        'schema': 'bearer',
                        'token': this.authManager.accessToken,
                    },
                    'join': [`uid:${userId}`]
                }
            }));
        });

        this.socket.on('close', () => {
            if (this.debug) this.log.error('SSAPI socket `closed`');
            this.log.warn('SimpliSafe real time events disconnected.');
            this.handleSocketConnectionFailure();
        });

        this.socket.on('error', (err) => {
            if (this.debug) this.log.error('SSAPI socket `error`:', err);
            this.log.warn('SimpliSafe real time events disconnected.');
            this.handleSocketConnectionFailure();
        });

        this.socket.on('unexpected-response', (reason) => {
            if (this.debug) this.log('SSAPI socket received unexpected-response:', reason);
            this.handleSocketConnectionFailure();
        });

        this.socket.on('pong', () => {
            if (this.debug) this.log('SSAPI socket `heartbeat`');
            this.socketIsAlive = true;
        });

        this.socket.on('message', (message) => {
            message = JSON.parse(message);

            if (this.debug && !['service', 'messagequeue'].includes(message.source)) this.log('SSAPI socket received message:', message);

            if (message.source == 'service') {
                switch (message.type) {
                case 'com.simplisafe.service.hello':
                    if (this.debug) this.log('SSAPI socket `hello`');
                    break;
                case 'com.simplisafe.service.registered':
                    if (this.debug) this.log('SSAPI socket `registered`');
                    break;
                case 'com.simplisafe.namespace.subscribed':
                    if (this.debug) this.log('SSAPI socket `subscribed`');
                    this.log('SimpliSafe real time events connected.');
                    this.nSocketConnectFailures = 0;
                    this.socketIsAlive = true;
                    
                    // heartbeat
                    this.socketHeartbeatIntervalID = setInterval(() => {
                        if (!this.socketIsAlive) {
                            if (this.debug) this.log('SSAPI socket heartbeat lost');
                            this.handleSocketConnectionFailure();
                            return;
                        } else {
                            this.socketIsAlive = false;
                            this.socket.ping();
                        }
                    }, socketHeartbeatInterval + (5000 * Math.random()));
                    break;
                default:
                    if (this.debug) this.log('Received unknown service message:', message);
                }
            } else if (message.source == 'messagequeue') {
                let data = message.data;
                if (data.sid != this.subId) {
                    // Ignore event as it doesn't relate to this account
                    return;
                }
                if (this.debug) {
                    if (data.eventType === 'cameraStatus') {
                        // arrives every few seconds while cameras wake and sleep, show what one holds once
                        if (!this.loggedCameraStatus) this.log('SSAPI cameraStatus message (only the first is logged):', JSON.stringify(data).slice(0, 1500));
                        this.loggedCameraStatus = true;
                    } else {
                        this.log(`SSAPI event ${data.eventCid} (${data.eventType}) from sensor type ${data.sensorType} serial ${data.sensorSerial}${data.internal && data.internal.mainCamera ? `, camera ${data.internal.mainCamera}` : ''}`);
                        // what SimpliSafe records for camera events, e.g. how much of its clip is from before the motion
                        if (data.video || data.eventCid == 1170 || data.eventCid == 1458) this.log(`SSAPI event ${data.eventCid} shape: ${eventShape(data)}`);
                    }
                }

                switch (data.eventType) {
                case 'alarm':
                    if (data.eventCid == 1601) {
                        this.emit(EVENT_TYPES.USER_INITIATED_TEST, data);
                    } else {
                        this.emit(EVENT_TYPES.ALARM_TRIGGER, data);
                    }
                    break;
                case 'alarmCancel':
                    this.emit(EVENT_TYPES.ALARM_OFF, data);
                    break;
                case 'cameraStatus':
                    this.emit(EVENT_TYPES.CAMERA_STATUS, data);
                    break;
                case 'activity':
                case 'activityQuiet':
                default:
                    // if it's not an alarm event, check by eventCid
                    switch (data.eventCid) {
                    case 1400:
                    case 1407:
                        // 1400 is disarmed with Master PIN, 1407 is disarmed with Remote
                        this.emit(EVENT_TYPES.ALARM_DISARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1406:
                        this.emit(EVENT_TYPES.ALARM_CANCEL, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1409:
                        this.emit(EVENT_TYPES.MOTION, data);
                        break;
                    case 9441:
                        this.emit(EVENT_TYPES.HOME_EXIT_DELAY, data);
                        break;
                    case 3441:
                    case 3491:
                        this.emit(EVENT_TYPES.HOME_ARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 9401:
                    case 9407:
                        // 9401 is for Keypad, 9407 is for Remote
                        this.emit(EVENT_TYPES.AWAY_EXIT_DELAY, data);
                        break;
                    case 3401:
                    case 3407:
                    case 3487:
                    case 3481:
                        // 3401 is for Keypad, 3407 is for Remote
                        this.emit(EVENT_TYPES.AWAY_ARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1429:
                        this.emit(EVENT_TYPES.ENTRY, data);
                        break;
                    case 1110:
                    case 1154:
                    case 1159:
                    case 1162:
                    case 1132:
                    case 1134:
                    case 1120:
                        this.emit(EVENT_TYPES.ALARM_TRIGGER, data);
                        break;
                    case 1170:
                        this.emit(EVENT_TYPES.CAMERA_MOTION, data);
                        break;
                    case 1301:
                        this.emit(EVENT_TYPES.POWER_OUTAGE, data);
                        break;
                    case 3301:
                        this.emit(EVENT_TYPES.POWER_RESTORED, data);
                        break;
                    case 1458:
                        this.emit(EVENT_TYPES.DOORBELL, data);
                        break;
                    case 9700:
                        this.emit(EVENT_TYPES.DOORLOCK_UNLOCKED, data);
                        break;
                    case 9701:
                        this.emit(EVENT_TYPES.DOORLOCK_LOCKED, data);
                        break;
                    case 9703:
                        this.emit(EVENT_TYPES.DOORLOCK_ERROR, data);
                        break;
                    case 1350:
                        this.log.error('Base station WiFi lost, this plugin cannot communicate with the base station until it is restored.');
                        break;
                    case 3350:
                        this.log.warn('Base station WiFi restored.');
                        break;
                    case 1601:
                        // User-initiated test, handled above
                        break;
                    case 1602:
                        // Automatic test
                        break;
                    default:
                        // Unknown event
                        if (this.debug) this.log('Unknown SSAPI event:', data);
                        break;
                    }
                    break;
                }
            }
        });
    }

    handleSocketConnectionFailure() {
        if (this.isAwaitingSocketReconnect || (this.socket && this.socket.readyState === WebSocket.CONNECTING)) return; // a reconnect attempt is pending / running

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.terminate();
            } catch (error) {
                if (this.debug) this.log.warn('SSAPI socket error occurred during termination, perhaps socket was not yet established.', error);
            }
            this.socket = null;
        }

        clearTimeout(this.socketHeartbeatIntervalID);
        this.socketIsAlive = false;

        let retryInterval = (2 ** this.nSocketConnectFailures) * socketRetryInterval;
        if (this.debug) this.log(`SSAPI socket connection lost. Next attempt will be in ${retryInterval/1000}s.`);
        setTimeout(async () => {
            this.isAwaitingSocketReconnect = false;
            await this.startListening();
        }, retryInterval);
        this.nSocketConnectFailures++;
        this.isAwaitingSocketReconnect = true;
    }

    subscribeToSensor(id, callback) {
        if (!this.sensorRefreshIntervalID) {
            this.sensorRefreshIntervalID = setInterval(async () => {
                if (this.sensorSubscriptions.length == 0) {
                    return;
                }
        
                if (this.refreshLockoutTimeoutID) {
                    if (this.debug) this.log('Sensor refresh lockout in effect, refresh blocked.');
                    return;
                }
        
                try {
                    let sensors = await this.getSensors(true);
                    for (let sensor of sensors) {
                        this.sensorSubscriptions
                            .filter(sub => sub.id === sensor.serial)
                            .map(sub => sub.callback(sensor));
                    }
                } catch (err) {
                    if (!(err instanceof RateLimitError)) { // never log rate limit errors as they are handled elsewhere
                        if (this.debug) {
                            if (err.statusCode == 409) {
                                this.log.debug('Sensor refresh received SettingsInProgress error from the SimpliSafe API. Note this does not necessarily indicate a problem, just that the base station was busy.');
                            } else {
                                this.log.error('Sensor refresh received an error from the SimpliSafe API:', err);
                            }
                        } else {
                            this.handleErrorSuppression();
                        }
                    }
                }
        
            }, this.sensorRefreshTime);
        
        }

        this.sensorSubscriptions.push({
            id: id,
            callback: callback
        });
    }

    unsubscribeFromSensor(id) {
        this.sensorSubscriptions = this.sensorSubscriptions.filter(sub => sub.id !== id);
        if (this.sensorSubscriptions.length == 0) {
            clearInterval(this.sensorRefreshIntervalID);
        }
    }

    subscribeToAlarmSystem(id, callback) {
        if (!this.alarmRefreshIntervalID) {
            this.alarmRefreshIntervalID = setInterval(async () => {
                if (this.refreshLockoutTimeoutID) {
                    if (this.debug) this.log('Refresh lockout in effect, alarm system refresh blocked.');
                    return;
                }

                try {
                    let system = await this.getAlarmSystem(true);
                    this.alarmSubscriptions
                        .filter(sub => sub.id === system.serial)
                        .map(sub => sub.callback(system));
                } catch (err) {
                    if (!(err instanceof RateLimitError)) { // never log rate limit errors as they are handled elsewhere
                        if (this.debug) {
                            if (err.statusCode == 409) {
                                this.log.warn('Alarm system refresh received a SettingsInProgress error from the SimpliSafe API.');
                            } else {
                                this.log.error('Alarm system refresh received an error from the SimpliSafe API:', err);
                            }
                        } else {
                            this.handleErrorSuppression();
                        }
                    }
                }

            }, alarmRefreshInterval);

        }

        this.alarmSubscriptions.push({
            id: id,
            callback: callback
        });
    }

    handleErrorSuppression() {
        if (!this.errorSupperessionTimeoutID) {
            this.nSuppressedErrors = 1;
            this.errorSupperessionTimeoutID = setTimeout(() => {
                if (!this.debug && this.nSuppressedErrors > 0) this.log.warn(`${this.nSuppressedErrors} error${this.nSuppressedErrors > 1 ? 's were' : ' was'} received from the SimpliSafe API while refreshing sensors in the last ${errorSuppressionDuration / 60000} minutes. These can usually be ignored if everything is working. Otherwise, enable debug logging for the plugin and restart to see detailed output.`);
                clearTimeout(this.errorSupperessionTimeoutID);
                this.errorSupperessionTimeoutID = undefined;
            }, errorSuppressionDuration);
        } else {
            this.nSuppressedErrors++;
        }
    }

    handleSensorRefreshLockout() {
        if (!this.refreshLockoutEnabled) return;
        // avoid "smart lock not responding" error with refresh lockout, see issue #134
        clearTimeout(this.refreshLockoutTimeoutID);
        this.refreshLockoutTimeoutID = setTimeout(() => {
            this.refreshLockoutTimeoutID = undefined;
        }, sensorRefreshLockoutDuration);
    }

}

export default SimpliSafe3;
