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

test('getRecentAlarmState uses a recent state without a request', async () => {
    let requests = 0;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => { requests++; return subscriptionResponse({ alarmState: 'AWAY' }); },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;

    ss.recordAlarmState('OFF');
    assert.equal(await ss.getRecentAlarmState(), 'OFF');
    assert.equal(requests, 0);
});

test('getRecentAlarmState serves an old state and refreshes it for next time', async () => {
    let requests = 0;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: async () => { requests++; return subscriptionResponse({ alarmState: 'AWAY' }); },
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;
    ss.lastAlarmState = 'OFF';
    ss.lastAlarmStateAt = Date.now() - 120000;

    assert.equal(await ss.getRecentAlarmState(), 'OFF');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(ss.lastAlarmState, 'AWAY');
});

test('getRecentAlarmState asks SimpliSafe when the state is unknown, and gives up after the timeout', async () => {
    let hang = false;
    const { default: SimpliSafe3 } = loadSimplisafe({
        requestImpl: () => hang ? new Promise(() => {}) : Promise.resolve(subscriptionResponse({ alarmState: 'HOME' })),
    });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    ss.subId = 123;

    assert.equal(await ss.getRecentAlarmState(), 'HOME');

    const slow = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);
    slow.subId = 456;
    hang = true;
    assert.equal(await slow.getRecentAlarmState(20), null);
});

test('arming and disarming events from a keypad or the app update the known alarm state', () => {
    const { default: SimpliSafe3, EVENT_TYPES, SENSOR_TYPES } = loadSimplisafe({ requestImpl: async () => ({ data: {} }) });
    const ss = new SimpliSafe3(15000, new FakeAuthManager(), '/tmp', createLogger(), false);

    ss.emit(EVENT_TYPES.AWAY_ARM, { sensorType: SENSOR_TYPES.KEYPAD });
    assert.equal(ss.lastAlarmState, 'AWAY');
    ss.emit(EVENT_TYPES.ALARM_DISARM, { sensorType: SENSOR_TYPES.APP });
    assert.equal(ss.lastAlarmState, 'OFF');
    ss.emit(EVENT_TYPES.HOME_ARM, { sensorType: SENSOR_TYPES.ENTRY_SENSOR });
    assert.equal(ss.lastAlarmState, 'OFF', 'mirrors the alarm accessory, which ignores other sources');
});
