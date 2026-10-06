const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const { loadSimplisafe } = require('./helpers/load-simplisafe.cjs');

class FakeAuthManager extends EventEmitter {
    constructor({
        authenticated = true,
        tokenType = 'Bearer',
        accessToken = 'token-123',
        refreshImpl = async () => {},
    } = {}) {
        super();
        this._authenticated = authenticated;
        this.tokenType = tokenType;
        this.accessToken = accessToken;
        this.refreshImpl = refreshImpl;
    }

    isAuthenticated() {
        return this._authenticated;
    }

    async refreshCredentials() {
        await this.refreshImpl();
        this._authenticated = true;
    }
}

function createLogger() {
    const fn = () => {};
    fn.error = () => {};
    return fn;
}

test('request short-circuits with RateLimitError while blocked', async () => {
    const { default: SimpliSafe3, RateLimitError } = loadSimplisafe({
        requestImpl: async () => {
            throw new Error('should not be called');
        },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.isBlocked = true;
    ss.nextAttempt = Date.now() + 1000;

    await assert.rejects(
        ss.request({ method: 'GET', url: '/subscriptions' }),
        (err) => err instanceof RateLimitError && /rate limited/i.test(err.message)
    );
});

test('request refreshes credentials and forwards Authorization header', async () => {
    let capturedParams;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async (params) => {
            capturedParams = params;
            return { data: { ok: true } };
        },
    });
    const authManager = new FakeAuthManager({
        authenticated: false,
        tokenType: 'Bearer',
        accessToken: 'refreshed-token',
    });
    const ss = new SimpliSafe3(15000, authManager, '/tmp', createLogger(), false);

    const result = await ss.request({ method: 'GET', url: '/foo', headers: { 'X-Test': 'yes' } });

    assert.deepEqual(result, { ok: true });
    assert.equal(capturedParams.headers.Authorization, 'Bearer refreshed-token');
    assert.equal(capturedParams.headers['X-Test'], 'yes');
});

test('request converts 403 responses into RateLimitError and updates block state', async () => {
    const { default: SimpliSafe3, RateLimitError } = loadSimplisafe({
        requestImpl: async () => {
            const err = new Error('forbidden');
            err.response = { status: 403, statusText: 'Forbidden', data: { message: 'blocked' } };
            throw err;
        },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), true);

    await assert.rejects(
        ss.request({ method: 'GET', url: '/foo' }),
        (err) => err instanceof RateLimitError
    );
    assert.equal(ss.isBlocked, true);
    assert.ok(ss.nextAttempt > Date.now());
});

test('getSubscriptions filters unsupported plans and respects account selection', async () => {
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => ({ data: {} }),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.accountNumber = 'acct-2';
    ss.getUserId = async () => 'user-1';
    ss.request = async () => ({
        subscriptions: [
            { sid: 'ignore-status', sStatus: 5, location: { account: 'acct-2' }, activated: 1 },
            { sid: 'wrong-account', sStatus: 10, location: { account: 'acct-1' }, activated: 1 },
            { sid: 'keep-me', sStatus: 20, location: { account: 'acct-2' }, activated: 1 },
        ],
    });

    const subscriptions = await ss.getSubscriptions();

    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].sid, 'keep-me');
    assert.equal(ss.subId, 'keep-me');
});

function subscriptionResponse(system) {
    return { data: { subscription: { location: { system } } } };
}

test('outdoor cameras listed as sensors have their own sensor types', () => {
    const { SENSOR_TYPES } = loadSimplisafe({ requestImpl: async () => ({ data: {} }) });
    assert.equal(SENSOR_TYPES.OUTDOOR_CAMERA, 17);
    assert.equal(SENSOR_TYPES.OUTDOOR_CAMERA_2, 23);
});

test('getAlarmSystem records the alarm state and shares the system with listeners', async () => {
    const { default: SimpliSafe3, SYSTEM_UPDATED } = loadSimplisafe({
        requestImpl: async () => subscriptionResponse({ alarmState: 'HOME', cameras: [{ uuid: 'cam' }] }),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;
    let shared;
    ss.on(SYSTEM_UPDATED, (system) => { shared = system; });

    await ss.getAlarmSystem();

    assert.equal(ss.lastAlarmState, 'HOME');
    assert.deepEqual(shared.cameras, [{ uuid: 'cam' }]);
});

test('getCurrentAlarmState uses a state seen in the last few seconds without a request', async () => {
    let requests = 0;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => { requests++; return subscriptionResponse({ alarmState: 'AWAY' }); },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;

    ss.recordAlarmState('OFF');
    assert.equal(await ss.getCurrentAlarmState(), 'OFF');
    assert.equal(requests, 0);
});

test('getCurrentAlarmState asks again rather than trusting an older state', async () => {
    let requests = 0;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => { requests++; return subscriptionResponse({ alarmState: 'OFF' }); },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;
    ss.recordAlarmState('AWAY', Date.now() - 60000);

    assert.equal(await ss.getCurrentAlarmState(), 'OFF');
    assert.equal(requests, 1);
});

test('getCurrentAlarmState never falls back to an older state when SimpliSafe does not answer', async () => {
    let fail = false;
    let hang = false;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: () => hang ? new Promise(() => {})
            : fail ? Promise.reject(Object.assign(new Error('down'), { response: { status: 500, data: 'down' } }))
                : Promise.resolve(subscriptionResponse({ alarmState: 'HOME' })),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;

    assert.equal(await ss.getCurrentAlarmState(), 'HOME');

    ss.lastAlarmStateAt = Date.now() - 60000;
    ss.lastSubscriptionRequests = {};
    fail = true;
    assert.equal(await ss.getCurrentAlarmState(), null);

    const slow = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    slow.subId = 456;
    slow.recordAlarmState('AWAY', Date.now() - 60000);
    hang = true;
    assert.equal(await slow.getCurrentAlarmState(20), null);
});

test('an API reply older than a realtime event does not override it', () => {
    const { default: SimpliSafe3, EVENT_TYPES, SENSOR_TYPES } = loadSimplisafe({ requestImpl: async () => ({ data: {} }) });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);

    const requestedAt = Date.now() - 1000;
    ss.emit(EVENT_TYPES.ALARM_DISARM, { sensorType: SENSOR_TYPES.KEYPAD });
    ss.recordAlarmState('AWAY', requestedAt);

    assert.equal(ss.lastAlarmState, 'OFF');
});

test('arming and disarming events from a keypad or the app update the known alarm state', () => {
    const { default: SimpliSafe3, EVENT_TYPES, SENSOR_TYPES } = loadSimplisafe({ requestImpl: async () => ({ data: {} }) });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);

    ss.emit(EVENT_TYPES.AWAY_ARM, { sensorType: SENSOR_TYPES.KEYPAD });
    assert.equal(ss.lastAlarmState, 'AWAY');
    ss.emit(EVENT_TYPES.ALARM_DISARM, { sensorType: SENSOR_TYPES.APP });
    assert.equal(ss.lastAlarmState, 'OFF');
    ss.emit(EVENT_TYPES.AWAY_ARM, { sensorType: '253' }); // Smart Lock PIN pad
    assert.equal(ss.lastAlarmState, 'AWAY');

    // a change from a source the state can't be read from forgets the state, so it is asked for again
    ss.emit(EVENT_TYPES.ALARM_DISARM, { sensorType: 15 });
    assert.equal(ss.lastAlarmState, null);
});

test('a timeout blocks requests briefly without growing the block like a rate limit', async () => {
    const { default: SimpliSafe3, RateLimitError } = loadSimplisafe({
        requestImpl: () => Promise.reject(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    const before = ss.nextBlockInterval;

    await assert.rejects(ss.request({ method: 'GET', url: '/x' }), (err) => err instanceof RateLimitError);
    assert.equal(ss.isBlocked, true);
    assert.ok(ss.nextAttempt - Date.now() <= before);
    assert.equal(ss.nextBlockInterval, before);
});

test('an unexpected live-view reply is described by its field names, never its contents', async () => {
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => ({ data: {
            signedChannelEndpoint: 'wss://m-1a2b.kinesisvideo.us-east-1.amazonaws.com/?X-Amz-ChannelARN=arn%3Aaws%3A611485993050%3Achannel%2Fabc_7654321&X-Amz-Signature=5d67',
            clientId: 'user-4433221',
            iceServers: [{ urls: ['turn:x'], username: '1791320000:djE6', credential: 'TURNPASSWORD' }],
            cameraStatus: 'online',
        } }),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 7654321;

    await assert.rejects(ss.getCameraLiveView('e15534806fb14446be20a948f11a9cfb'), (err) => {
        assert.equal(err.message, 'Unexpected live-view response: fields signedChannelEndpoint,clientId,iceServers,cameraStatus, cameraStatus online');
        return true;
    });
});
