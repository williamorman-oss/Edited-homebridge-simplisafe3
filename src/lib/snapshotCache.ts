import fs from 'fs';
import path from 'path';

// homebridge Logging or console.log
type Logger = ((...args: unknown[]) => void) & { error?: (...args: unknown[]) => void };

export interface SnapshotCacheOptions {
    name: string;
    fetch: () => Promise<Buffer>;
    // ms, once the image is older than this a request also starts a background refresh
    refreshAge: number | (() => number);
    // ms to wait for a refresh when there is nothing to serve, or a fresh image was asked for
    budget?: number;
    // ms before a refresh is given up on, so a hung camera never blocks later refreshes
    timeout?: number;
    backoffInitial?: number;
    backoffMax?: number;
    canRefresh?: () => boolean;
    persistPath?: string;
    persistInterval?: number;
    log?: Logger;
    debug?: boolean;
    now?: () => number;
}

const defaultBudget = 5000; // ms, inside HomeKit's 8s 'slow to respond' warning
const defaultTimeout = 30000; // ms
const defaultBackoffInitial = 60000; // ms
const defaultBackoffMax = 30 * 60000; // ms
const defaultPersistInterval = 5 * 60000; // ms, keeps SD card writes down

// Keeps the last snapshot of a camera so HomeKit can be answered straight away.
// HomeKit sends a bridge's requests one at a time, so a snapshot that waits on the
// camera holds up every other camera, live view and the alarm on that bridge.
// Requests are served from the cache and the camera is refreshed in the background.
class SnapshotCache {
    image: Buffer | null = null;
    takenAt = 0;
    failures = 0;

    private refreshing: Promise<Buffer> | null = null;
    private retryAt = 0;
    private lastPersist = 0;
    private options: SnapshotCacheOptions;
    private now: () => number;

    constructor(options: SnapshotCacheOptions) {
        this.options = options;
        this.now = options.now || Date.now;
        this.load();
    }

    get failing(): boolean {
        return this.failures > 0;
    }

    age(): number {
        return this.image ? this.now() - this.takenAt : Infinity;
    }

    // Resolves with the best image available within the budget (ms), or null if there is none.
    // fresh asks for a new image, e.g. for a doorbell or motion notification
    async get(fresh = false, budget = this.options.budget ?? defaultBudget): Promise<Buffer | null> {
        if (this.image && !fresh) {
            if (this.age() >= this.refreshAge()) this.refresh();
            return this.image;
        }

        const refresh = this.refresh(fresh);
        if (!refresh) return this.image;

        let timeoutID: ReturnType<typeof setTimeout> | undefined;
        const outOfTime = new Promise<null>(resolve => {
            timeoutID = setTimeout(() => resolve(null), budget);
        });

        try {
            const image = await Promise.race([refresh, outOfTime]);
            return image || this.image;
        } catch {
            return this.image;
        } finally {
            clearTimeout(timeoutID);
        }
    }

    set(image: Buffer, takenAt = this.now()): void {
        this.image = image;
        this.takenAt = takenAt;
        this.persist();
    }

    // Starts a refresh unless one is running, returning it, or null if refreshing is not allowed right now
    refresh(ignoreBackoff = false): Promise<Buffer> | null {
        if (this.refreshing) return this.refreshing;
        if (this.options.canRefresh && !this.options.canRefresh()) return null;
        if (!ignoreBackoff && this.now() < this.retryAt) return null;

        let timeoutID: ReturnType<typeof setTimeout> | undefined;
        const timeout = this.options.timeout ?? defaultTimeout;
        const timedOut = new Promise<never>((resolve, reject) => {
            timeoutID = setTimeout(() => reject(new Error(`Timed out after ${timeout / 1000}s`)), timeout);
        });

        const refresh = Promise.race([this.options.fetch(), timedOut])
            .then(image => {
                this.set(image);
                if (this.failures && this.options.log) this.options.log(`Snapshots for '${this.options.name}' recovered`);
                this.failures = 0;
                this.retryAt = 0;
                return image;
            }, (err: Error) => {
                this.failures++;
                const initial = this.options.backoffInitial ?? defaultBackoffInitial;
                const backoff = Math.min(this.options.backoffMax ?? defaultBackoffMax, initial * 2 ** (this.failures - 1));
                this.retryAt = this.now() + backoff;
                const log = this.options.log;
                if (log) {
                    const message = `Could not refresh snapshot for '${this.options.name}': ${err && err.message}. Retrying in ${Math.round(backoff / 1000)}s.`;
                    if (log.error && (this.failures === 1 || this.options.debug)) log.error(message);
                    else if (this.options.debug) log(message);
                }
                throw err;
            })
            .finally(() => {
                clearTimeout(timeoutID);
                this.refreshing = null;
            });

        // callers that do not wait on the refresh must not leave its failure unhandled
        refresh.catch(() => {});
        this.refreshing = refresh;
        return refresh;
    }

    private refreshAge(): number {
        const { refreshAge } = this.options;
        return typeof refreshAge === 'function' ? refreshAge() : refreshAge;
    }

    private load(): void {
        const file = this.options.persistPath;
        if (!file) return;

        try {
            const stats = fs.statSync(file);
            this.image = fs.readFileSync(file);
            this.takenAt = stats.mtimeMs;
            this.lastPersist = stats.mtimeMs;
        } catch {
            // nothing saved yet
        }
    }

    private persist(): void {
        const file = this.options.persistPath;
        if (!file || !this.image || this.now() - this.lastPersist < (this.options.persistInterval ?? defaultPersistInterval)) return;

        this.lastPersist = this.now();
        const image = this.image;
        fs.promises.mkdir(path.dirname(file), { recursive: true })
            .then(() => fs.promises.writeFile(file, image))
            .catch(err => {
                if (this.options.debug && this.options.log) this.options.log(`Could not save snapshot for '${this.options.name}': ${err.message}`);
            });
    }
}

export default SnapshotCache;
