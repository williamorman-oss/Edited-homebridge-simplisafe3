import fs from 'fs';
import path from 'path';
import { format } from 'util';

// homebridge Logging: a function with info/warn/error/debug/success/log methods and a prefix
type LogFn = ((...args: unknown[]) => void) & { [key: string]: unknown };

export interface DiagnosticLogOptions {
    file: string;
    version: string;
    // a few lines on the state of the cameras, written at the top of the file
    summary?: () => string;
    maxLines?: number;
    maxBytes?: number;
    flushDelay?: number;
    now?: () => number;
}

// In the Homebridge storage folder, read by the settings page's 'Logs for Claude' card
export const diagnosticsFilename = 'simplisafe3-edited-logs.txt';

const defaultMaxLines = 800;
const defaultMaxBytes = 200 * 1024;
const defaultFlushDelay = 10000; // ms, at most one write every 10s while the plugin is logging
const maxLineLength = 2000; // e.g. the camera JSON logged at discovery is ~8 kB
// Lines that repeat without saying anything new, only one per interval is kept
const thinned = [
    { pattern: /^\s*frame=\s*\d+/, interval: 10000 }, // ffmpeg progress while streaming, twice a second
    { pattern: /^SSAPI socket `heartbeat`$/, interval: 15 * 60000 } // once a minute
];
const maxReadBytes = 512 * 1024;
const levels = ['info', 'warn', 'error', 'debug', 'success', 'log'];

// Removes what must not end up in a conversation: credentials, email addresses, MAC addresses,
// Wi-Fi names and account numbers. Camera serials stay, they are needed to follow events
export function redact(text: string): string {
    return text
        .replace(/(Bearer\s+)\S+/gi, '$1[REMOVED]')
        .replace(/(srtp_(?:key|salt)['"]?\s*:\s*)<Buffer[^>]*>/gi, '$1[REMOVED]')
        .replace(/(-srtp_out_params\s+)\S+/g, '$1[REMOVED]')
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[TOKEN REMOVED]')
        .replace(/sk-ant-[\w-]+/g, '[TOKEN REMOVED]')
        .replace(/\b((?:access|refresh|user|id)_?token|token|code_?verifier|password|secret)\b(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1$2[REMOVED]')
        .replace(/\b(wifiSsid|ssid)\b(["']?\s*:\s*["'])[^"']*/gi, '$1$2[REMOVED]')
        .replace(/\b(uid|sid|userId|accountNumber|subscriptionId|account(?:\s+number)?)\b(["']?\s*[:=]\s*["']?)\d+/gi, '$1$2[ID REMOVED]')
        // the subscription number inside LiveKit room names and API paths
        .replace(/\b([0-9a-f]{32})_\d+\b/gi, '$1_[ID REMOVED]')
        .replace(/(subscriptions\/)\d+/gi, '$1[ID REMOVED]')
        .replace(/(\/cameras\/[0-9a-f]{32}\/)\d+/gi, '$1[ID REMOVED]')
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL REMOVED]')
        .replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[MAC REMOVED]');
}

// Keeps this plugin's recent log lines, without secrets, in a file the settings page can show,
// so they can be copied into a conversation with Claude. Nothing is sent anywhere
class DiagnosticLog {
    private lines: string[] = [];
    private bytes = 0;
    private dropped = 0;
    private lastThinnedAt = thinned.map(() => -Infinity);
    private timer?: ReturnType<typeof setTimeout>;
    private options: DiagnosticLogOptions;
    private now: () => number;

    constructor(options: DiagnosticLogOptions) {
        this.options = options;
        this.now = options.now || Date.now;
    }

    // Returns a logger that logs as before and also keeps each line
    wrap(log: LogFn): LogFn {
        const wrapped = ((...args: unknown[]) => {
            log(...args);
            this.record('info', args);
        }) as LogFn;

        for (const level of levels) {
            const method = log[level];
            if (typeof method !== 'function') continue;
            wrapped[level] = (...args: unknown[]) => {
                (method as (...a: unknown[]) => void).apply(log, args);
                this.record(level, args);
            };
        }
        if ('prefix' in log) wrapped.prefix = log.prefix;
        return wrapped;
    }

    record(level: string, args: unknown[]): void {
        let text = redact(format(...args)).trimEnd();
        if (!text) return;

        const noisy = thinned.findIndex(({ pattern }) => pattern.test(text));
        if (noisy >= 0) {
            if (this.now() - this.lastThinnedAt[noisy] < thinned[noisy].interval) return;
            this.lastThinnedAt[noisy] = this.now();
        }

        if (text.length > maxLineLength) text = `${text.slice(0, maxLineLength)}... (${text.length - maxLineLength} characters cut)`;
        const line = `${new Date(this.now()).toISOString()} ${level.toUpperCase()} ${text}`;
        this.lines.push(line);
        this.bytes += Buffer.byteLength(line) + 1;

        const maxLines = this.options.maxLines || defaultMaxLines;
        const maxBytes = this.options.maxBytes || defaultMaxBytes;
        while (this.lines.length > 1 && (this.lines.length > maxLines || this.bytes > maxBytes)) {
            this.bytes -= Buffer.byteLength(this.lines.shift() as string) + 1;
            this.dropped++;
        }

        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.options.flushDelay ?? defaultFlushDelay);
            if (this.timer.unref) this.timer.unref();
        }
    }

    contents(): string {
        let summary = '';
        try {
            summary = this.options.summary ? redact(this.options.summary()) : '';
        } catch (err) {
            summary = `(camera summary failed: ${(err as Error).message})`;
        }

        return [
            `homebridge-simplisafe3-edited ${this.options.version} logs, written ${new Date(this.now()).toISOString()}`,
            'Passwords, tokens, email addresses, MAC addresses, Wi-Fi names and account numbers are removed.',
            summary ? `Cameras:\n${summary}` : '',
            `--- ${this.lines.length} log lines${this.dropped ? `, ${this.dropped} older lines dropped` : ''} ---`,
            ...this.lines
        ].filter(part => part !== '').join('\n') + '\n';
    }

    // Written aside and renamed so the settings page never reads half a file
    flush(sync = false): Promise<void> | void {
        clearTimeout(this.timer);
        this.timer = undefined;

        const file = this.options.file;
        const temporary = `${file}.tmp`;
        const contents = this.contents();

        if (sync) {
            try {
                fs.writeFileSync(temporary, contents);
                fs.renameSync(temporary, file);
            } catch {
                // the logs are a convenience, never fail the plugin over them
            }
            return;
        }

        return fs.promises.writeFile(temporary, contents)
            .then(() => fs.promises.rename(temporary, file))
            .catch(() => {});
    }
}

// Used by the settings page's server. Redacts again in case the file came from an older version
export function readDiagnostics(storagePath: string): { text: string; lines: number; updatedAt: number } {
    const file = path.join(storagePath, diagnosticsFilename);
    if (!fs.existsSync(file)) {
        throw new Error('No logs yet. They appear once this plugin has started and logged something, restart it if you just installed it.');
    }

    const stats = fs.statSync(file);
    let text = fs.readFileSync(file).toString();
    if (text.length > maxReadBytes) text = text.slice(-maxReadBytes);
    text = redact(text);

    return {
        text,
        lines: text.split('\n').filter(line => /^\d{4}-\d\d-\d\dT/.test(line)).length,
        updatedAt: stats.mtimeMs
    };
}

export default DiagnosticLog;
