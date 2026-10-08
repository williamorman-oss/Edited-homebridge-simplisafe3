// ffmpeg arguments are kept as groups, e.g. [['-i', url], ['-map', '0:v:0'], [outputUrl]],
// so user options can replace or remove a whole group by its name
export type FfmpegArg = Array<string | number>;
export type FfmpegOptionValue = string | number | boolean | null | undefined;
export type FfmpegOptions = string | Record<string, FfmpegOptionValue> | null | undefined;

const isOptionName = (token: string): boolean => /^-[A-Za-z]/.test(token);

// Reads user options given as a string, "-key value -flag", or the old object form, {"-key": value}
export function parseFfmpegOptions(options: FfmpegOptions): Array<[string, FfmpegOptionValue]> {
    if (!options) return [];
    if (typeof options !== 'string') return Object.entries(options);

    const parsed: Array<[string, FfmpegOptionValue]> = [];
    for (const token of options.trim().split(/\s+/)) {
        if (!token) continue;
        if (isOptionName(token)) {
            parsed.push([token, undefined]);
        } else if (parsed.length) {
            // negative numbers are values, not option names
            const last = parsed[parsed.length - 1];
            last[1] = last[1] === undefined ? token : `${last[1]} ${token}`;
        }
    }
    return parsed;
}

// Applies user options: a value of false (or "false") removes the argument, an option without a value
// is added as a flag. New input options go first, new output options go before the output URL (the last group)
export function applyFfmpegOptions(args: FfmpegArg[], options: FfmpegOptions, position: 'input' | 'output'): FfmpegArg[] {
    let result = args.slice();

    for (const [key, value] of parseFfmpegOptions(options)) {
        if (value === false || value === 'false') {
            result = result.filter(arg => arg[0] !== key);
            continue;
        }

        const entry: FfmpegArg = value === undefined || value === null || value === true || value === '' ? [key] : [key, value];
        const index = result.findIndex(arg => arg[0] === key);
        if (index >= 0) {
            result[index] = entry;
        } else if (position === 'input') {
            result.unshift(entry);
        } else {
            result.splice(Math.max(result.length - 1, 0), 0, entry);
        }
    }

    return result;
}

export function flattenFfmpegArgs(args: FfmpegArg[]): string[] {
    return args.flat().map(arg => typeof arg === 'string' ? arg.trim() : String(arg));
}

// The source headers carry the SimpliSafe access token, -srtp_out_params the stream's encryption key
export function redactFfmpegArgs(args: string[]): string[] {
    return args
        .map((arg, i) => args[i - 1] === '-srtp_out_params' ? '[REDACTED]' : arg)
        .map(arg => arg.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]'));
}
