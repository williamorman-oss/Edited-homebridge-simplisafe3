import {
    VideoQuality,
    TrackSource,
    TrackType,
    ParticipantInfo_Kind,
    ParticipantInfo_State,
    DisconnectReason,
    LeaveRequest_Action,
    RequestResponse_Reason
} from '@livekit/protocol';

// One-line summaries for debug logs. What they summarise holds account, subscription and user numbers,
// participant identities, room names, street addresses and links, so each keeps only enums, numbers,
// field names and plain words, never a value that could identify the account

// A plain word or phrase such as 'medium' or 'Camera Detected Motion'. Anything else, e.g. a name with
// digits, an address or an id, is replaced
export function word(value, max = 40) {
    if (typeof value !== 'string' || !value) return '';
    return /^[A-Za-z][A-Za-z ./_-]*$/.test(value) ? value.slice(0, max) : '(text)';
}

// A model, codec or provider name such as 'SSOBCM4', 'olympus', 'video/H264' or 'KVS'
function token(value, max = 24) {
    if (typeof value !== 'string' && typeof value !== 'number') return '?';
    const text = String(value);
    return /^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(text) && text.length <= max ? text : '?';
}

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : '?');
const bool = value => (typeof value === 'boolean' ? value : '?');
const enumName = (type, value) => (type && typeof type[value] === 'string' ? type[value] : String(value));

const featureFlags = [
    'doorbell', 'speaker', 'microphone', 'fullDuplexAudio', 'privacyShutter', 'battery', 'wired', 'spotlight',
    'spotlightManualControl', 'colorNightMode', 'siren', 'sirenManualControl', 'sirenManualControlV2',
    'outdoorMonitoring', 'monitoredLiveStream', 'deviceManagedRecordings', 'supportsEventUuid', 'videoAnalytics', 'pir'
];

// What a camera can do and how it is set up, from the camera details SimpliSafe sends at discovery.
// The full details are too long for Logs for Claude, which cuts lines at 2000 characters
export function cameraCapabilities(camera) {
    const features = camera.supportedFeatures || {};
    const settings = camera.cameraSettings || {};
    const admin = settings.admin || {};
    const state = camera.currentState || {};
    const motion = (settings.motion && settings.motion.enable) || {};
    const spotlight = settings.spotlight;
    const plan = camera.subscription;
    const list = values => (Array.isArray(values) ? values.map(value => token(value)).join('/') : '-');

    return [
        `${token(camera.model)}: live ${token(admin.webRTCProvider)}, recording ${token(state.recordingProvider || admin.recordingProvider)}`,
        `features ${featureFlags.filter(flag => features[flag] === true).join(',') || 'none'}`,
        `audio ${list(features.audioEncodings)}, objects [${list(features.granularObjectDetectionTypes)}]`,
        `fps ${number(admin.fps)}, gop ${number(admin.gopLength)}, bitrate ${number(admin.bitRate)}, quality ${token(settings.pictureQuality)}`,
        `nightVision ${word(settings.nightVision, 12)}, statusLight ${word(settings.statusLight, 12)}, mic ${bool(settings.micEnable)}, speaker ${number(settings.speakerVolume)}, privacy ${bool(settings.privacyEnable)}`,
        `shutter off/home/away ${word(settings.shutterOff, 16)}/${word(settings.shutterHome, 16)}/${word(settings.shutterAway, 16)}`,
        `motion off/home/away ${bool(motion.off)}/${bool(motion.home)}/${bool(motion.away)}`,
        `spotlight ${spotlight ? `${word(spotlight.level, 10) || '-'}${spotlight.enableColorNightMode ? ' color' : ''}` : '-'}`,
        `plan ${plan ? (plan.enabled ? `on, ${number(plan.storageDays)} days` : 'off') : '?'}`
    ].join('; ');
}

function videoClips(data) {
    const video = data.video && typeof data.video === 'object' ? data.video : {};
    return Object.values(video).filter(clip => clip && typeof clip === 'object');
}

// The camera's own recording of a motion or doorbell event, the one that started it if there are several
export function eventClip(data) {
    const video = data && data.video && typeof data.video === 'object' ? data.video : null;
    if (!video) return null;
    return (data.videoStartedBy && video[data.videoStartedBy]) || videoClips(data)[0] || null;
}

// a link's name, e.g. 'playback/hls' or 'download/mp4', never anything that looks like an id
export const linkName = name => (/^[A-Za-z][A-Za-z0-9_/]{0,30}$/.test(name) && !/\d{3}/.test(name) ? name : '?');
const linkNames = clip => Object.keys((clip && clip._links) || {}).map(linkName);

// The shape of a camera or doorbell event: field names, the clip SimpliSafe records for it, how much of it is
// from before the event, and which links it offers. Never the links themselves, they hold the account
export function eventShape(data) {
    const clips = videoClips(data).map(clip =>
        `${token(clip.recordingType, 10)}/${token(clip.status, 12)} ${number(clip.preroll)}s before, ${number(clip.postroll)}s after, links ${linkNames(clip).join('|') || 'none'}`);
    return [
        `fields ${Object.keys(data).map(key => (/^[A-Za-z_]+$/.test(key) ? key : '?')).join(',')}`,
        `subject '${word(data.messageSubject)}'`,
        `clips [${clips.join('; ')}]`,
        `internal ${Object.keys(data.internal || {}).map(key => (/^[A-Za-z_]+$/.test(key) ? key : '?')).join(',') || 'none'}`
    ].join('; ');
}

// When SimpliSafe says an event happened, in ms. Events give seconds, camera status messages ms
export function eventTime(data) {
    const timestamp = data && Number(data.eventTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

// The other participants in a camera's LiveKit room and what they publish. No identity, name or metadata
export function participants(list) {
    return (list || []).map(participant => {
        const tracks = (participant.tracks || []).map(track => {
            const size = track.width && track.height ? ` ${number(track.width)}x${number(track.height)}` : '';
            // the qualities a viewer can choose between, if the camera sends more than one
            const layers = (track.layers || []).map(layer =>
                `${enumName(VideoQuality, layer.quality)} ${number(layer.width)}x${number(layer.height)} ${typeof layer.bitrate === 'number' && layer.bitrate ? `${Math.round(layer.bitrate / 1000)}kbps` : '?kbps'}`);
            const quality = track.type === TrackType.VIDEO ? `${track.simulcast ? ' simulcast' : ''}${layers.length ? ` layers ${layers.join('/')}` : ''}` : '';
            return `${enumName(TrackType, track.type)}/${enumName(TrackSource, track.source)} ${token(track.mimeType)}${size}${quality}${track.muted ? ' muted' : ''}`;
        });
        return `${enumName(ParticipantInfo_Kind, participant.kind)}/${enumName(ParticipantInfo_State, participant.state)}${participant.isPublisher ? ' publisher' : ''} [${tracks.join(', ')}]`;
    }).join('; ') || 'none';
}

// What the plugin may do in a camera's room (can it publish audio, i.e. talk) and who else is in it.
// Never the room name, which ends in the subscription number
export function liveKitJoin(join) {
    const permission = join.participant && join.participant.permission;
    let rights = 'no permissions given';
    if (permission) {
        const sources = permission.canPublishSources && permission.canPublishSources.length
            ? permission.canPublishSources.map(source => enumName(TrackSource, source)).join('|')
            : 'any';
        rights = `canPublish ${bool(permission.canPublish)}${permission.canPublish ? ` (${sources})` : ''}, canSubscribe ${bool(permission.canSubscribe)}, canPublishData ${bool(permission.canPublishData)}`;
    }
    const codecs = (join.enabledPublishCodecs || []).map(codec => token(codec.mime)).join(',') || 'default';
    const server = join.serverInfo || {};
    const version = token(server.version || join.serverVersion, 16);
    return `${rights}; publish codecs ${codecs}; fastPublish ${bool(join.fastPublish)}, subscriberPrimary ${bool(join.subscriberPrimary)}; server ${version} protocol ${number(server.protocol)}; others ${participants(join.otherParticipants)}`;
}

export function liveKitLeave(leave) {
    return `reason ${enumName(DisconnectReason, leave.reason)}, action ${enumName(LeaveRequest_Action, leave.action)}, canReconnect ${bool(leave.canReconnect)}`;
}

export function liveKitRequestResponse(response) {
    return `reason ${enumName(RequestResponse_Reason, response.reason)}`;
}

// How long an Opus packet plays, from its TOC byte (RFC 6716 3.1), in ms
export function opusPacketDuration(payload) {
    if (!payload || !payload.length) return null;
    const config = payload[0] >> 3;
    let frame;
    if (config < 12) frame = [10, 20, 40, 60][config % 4];
    else if (config < 16) frame = [10, 20][config % 2];
    else frame = [2.5, 5, 10, 20][config % 4];

    const code = payload[0] & 3;
    let frames = 1;
    if (code === 1 || code === 2) frames = 2;
    else if (code === 3) frames = payload.length > 1 ? payload[1] & 0x3f : 0;
    return frame * frames;
}

// The clip links SimpliSafe sends are templates (e.g. '{&width}'), and the access token must only ever go
// to SimpliSafe
export function simplisafeUrl(href) {
    if (typeof href !== 'string') return null;
    const url = href.replace(/\{[^}]*\}/g, '');
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:') return null;
        if (host !== 'simplisafe.com' && !host.endsWith('.simplisafe.com')) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

// The codec lines of ffmpeg's description of an input, without anything that could be a link
export function ffmpegStreams(stderr) {
    const streams = [];
    // with '-f null' ffmpeg lists every stream again under the output
    const input = String(stderr).split(/\n(?:Output #|Stream mapping:)/)[0];
    for (const match of input.matchAll(/^\s*Stream #\d+:\d+[^:]*: (Video|Audio): ([^\n]+)/gm)) {
        const description = match[2].replace(/\S*:\/\/\S*/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        streams.push(`${match[1].toLowerCase()} ${description}`);
    }
    return streams;
}
