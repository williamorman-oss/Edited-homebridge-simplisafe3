import { spawn } from 'child_process';
import crypto from 'crypto';
import dns from 'dns';
import { promisify } from 'util';
import isDocker from 'is-docker';
import { localIPv4Address } from './network';
import path from 'path';
import fs from 'fs';
import dgram from 'dgram';
import { SrtpSession, ProtectionProfileAes128CmHmacSha1_80, RtpHeader } from 'werift';

import LiveKitSource from './liveKitSource';
import KeyframeCollector from './h264';
import SnapshotCache from './snapshotCache';
import { fetchMjpegFrame } from './mjpeg';
import { applyFfmpegOptions, flattenFfmpegArgs, redactFfmpegArgs } from './ffmpegArgs';

const dnsLookup = promisify(dns.lookup);

const videoPayloadType = 99;
const audioPayloadType = 110;
const prepareTimeout = 20000; // ms, give up on a prepared session HomeKit never started
const keyframeTimeout = 15000; // ms, waiting for a keyframe to build a snapshot from once LiveKit is connected

// Snapshots are served from a cache and refreshed in the background, see SnapshotCache
const snapshotBudget = 5000; // ms to wait when there is no image yet, inside HomeKit's 8s 'slow' warning
const freshSnapshotBudget = 7000; // ms to wait for a new image for a doorbell or motion notification
const legacySnapshotRefreshAge = 10000; // ms, the Home app asks every 8-10s per visible camera
const poweredSnapshotRefreshAge = 60000; // ms, each LiveKit refresh joins the camera's room
const defaultBatterySnapshotMinutes = 10; // each refresh wakes a battery camera
const streamSnapshotInterval = 10000; // ms between snapshots taken from a running live view
const recentEventWindow = 15000; // ms after motion or a doorbell press that snapshots should be new
const eventSnapshotMaxAge = 5000; // ms, how old an image may be for a notification HomeKit asks for
const poweredBackoffMax = 2 * 60000; // ms between attempts for a camera that is not responding
const batteryBackoffMax = 30 * 60000; // ms, a battery camera that is not responding is likely flat
const staleSnapshotMinAge = 5 * 60000; // ms before a camera that keeps failing shows 'unavailable'
const legacySnapshotTimeout = 10000; // ms
const liveKitSnapshotTimeout = 20000; // ms to join and wake a camera, battery cameras took 5-6s from sleep
const alarmStateTimeout = 3000; // ms to wait for the alarm state when it is not known yet

// Rejects with the message unless the promise settles within ms
function withTimeout(promise, ms, message) {
    let timeoutID;
    const timedOut = new Promise((resolve, reject) => {
        timeoutID = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timedOut]).finally(() => clearTimeout(timeoutID));
}

const privacyShutterImage = path.resolve(__dirname, '..', 'images', 'privacyshutter_snapshot.png');
const privacyShutterImageInBytes = fs.readFileSync(privacyShutterImage);
const unsupportedCameraImage = path.resolve(__dirname, '..', 'images', 'unsupportedcamera_snapshot.png');
const unsupportedCameraImageInBytes = fs.readFileSync(unsupportedCameraImage);
const snapshotWaitingImage = fs.readFileSync(path.resolve(__dirname, '..', 'images', 'snapshot_waiting.jpg'));
const snapshotUnavailableImage = fs.readFileSync(path.resolve(__dirname, '..', 'images', 'snapshot_unavailable.jpg'));

class StreamingDelegate {
    constructor(ss3Camera) {
        this.ss3Camera = ss3Camera;
        this.simplisafe = ss3Camera.simplisafe;
        this.log = ss3Camera.log;
        this.api = ss3Camera.api;
        this.cameraOptions = ss3Camera.cameraOptions;

        this.pendingSessions = {};
        this.ongoingSessions = {};
        this.liveKitSessions = {};
        this.liveKitShared = null;
        this.snapshotBusy = false;
        this.snapshotWidth = 1280;

        const liveKit = this.ss3Camera.getStreamProvider() === 'livekit';
        this.snapshots = new SnapshotCache({
            name: ss3Camera.name,
            fetch: () => liveKit ? this.warmSnapshot() : this.fetchLegacySnapshot(),
            refreshAge: () => this.snapshotRefreshAge(),
            budget: snapshotBudget,
            timeout: (liveKit ? liveKitSnapshotTimeout + keyframeTimeout : legacySnapshotTimeout) + 5000,
            backoffMax: () => this.isOnBattery() ? batteryBackoffMax : poweredBackoffMax,
            canRefresh: () => this.canRefreshSnapshot(),
            // images from a camera with a privacy shutter (indoors) are never written to disk
            persistPath: ss3Camera.supportsPrivacyShutter() ? undefined : ss3Camera.snapshotPath,
            log: this.log,
            debug: ss3Camera.debug
        });

        let fps = this.cameraDetails.cameraSettings.admin.fps;
        let streamingOptions = {
            supportedCryptoSuites: [this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
            video: {
                resolutions: [
                    [320, 240, fps],
                    [320, 240, 15],
                    [320, 180, fps],
                    [320, 180, 15],
                    [480, 360, fps],
                    [480, 270, fps],
                    [640, 480, fps],
                    [640, 360, fps],
                    [1280, 720, fps],
                    [1920, 1080, fps]
                ],
                codec: {
                    profiles: [this.api.hap.H264Profile.BASELINE, this.api.hap.H264Profile.MAIN, this.api.hap.H264Profile.HIGH],
                    levels: [this.api.hap.H264Level.LEVEL3_1, this.api.hap.H264Level.LEVEL3_2, this.api.hap.H264Level.LEVEL4_0],
                }
            },
            audio: {
                codecs: [
                    {
                        type: this.api.hap.AudioStreamingCodecType.AAC_ELD,
                        samplerate: this.api.hap.AudioStreamingSamplerate.KHZ_16
                    }
                ]
            }
        };

        // LiveKit cameras publish Opus already, so ask HomeKit for it and forward the RTP
        if (this.ss3Camera.getStreamProvider() === 'livekit') {
            streamingOptions.audio.codecs = [
                {
                    type: this.api.hap.AudioStreamingCodecType.OPUS,
                    samplerate: this.api.hap.AudioStreamingSamplerate.KHZ_24
                }
            ];
        }

        // Series 2 doorbell is square, offer matching resolutions alongside the 4:3 / 16:9 defaults
        if (this.cameraDetails.supportedFeatures && this.cameraDetails.supportedFeatures.aspectRatio === '1:1') {
            streamingOptions.video.resolutions.push([640, 640, fps], [960, 960, fps], [1280, 1280, fps], [1536, 1536, fps]);
        }

        let resolution = this.cameraDetails.cameraSettings.pictureQuality;
        let maxSupportedHeight = +(resolution.split('p')[0]);
        streamingOptions.video.resolutions = streamingOptions.video.resolutions.filter(r => r[1] <= maxSupportedHeight);

        const cameraController = new this.api.hap.CameraController({
            cameraStreamCount: 2,
            delegate: this,
            streamingOptions: streamingOptions
        });

        this.controller = cameraController;
    }

    diagnostics() {
        const age = this.snapshots.age();
        const liveViews = Object.keys(this.liveKitSessions).length + Object.keys(this.ongoingSessions).length;
        return [
            age === Infinity ? 'no snapshot yet' : `snapshot ${Math.round(age / 1000)}s old`,
            this.snapshots.failures ? `${this.snapshots.failures} snapshot failures` : null,
            liveViews ? `${liveViews} live view(s) running` : null
        ].filter(part => part).join(', ');
    }

    // Read through the camera so periodic refreshes (battery, charging) are seen here too
    get cameraDetails() {
        return this.ss3Camera.cameraDetails;
    }

    async handleSnapshotRequest(request, callback) {
        try {
            if (this.ss3Camera.debug) this.log(`Handling camera snapshot for '${this.ss3Camera.name}' at ${request.width}x${request.height}`);

            if (this.ss3Camera.isUnsupported()) {
                this.handleUnsupportedCameraSnapshotRequest(callback);
                return;
            }

            if (await this.isPrivacyShutterClosed()) {
                this.handlePrivacyShutterClosedSnapshotRequest(callback);
                return;
            }

            if (request.width > this.snapshotWidth) this.snapshotWidth = request.width;

            // HomeKit sends a bridge's requests one at a time, so answer from the cache rather than
            // keep every other camera, live view and the alarm waiting on this camera
            const notBefore = this.snapshotNotBefore(request);
            const image = await this.snapshots.get(notBefore, notBefore ? freshSnapshotBudget : snapshotBudget);
            if (image && this.snapshotIsAbandoned()) {
                if (this.ss3Camera.debug) this.log(`'${this.ss3Camera.name}' has not responded for ${Math.round(this.snapshots.age() / 60000)} minutes, sending a placeholder`);
                callback(undefined, snapshotUnavailableImage);
            } else if (image) {
                if (this.ss3Camera.debug) this.log(`Closed '${this.ss3Camera.name}' snapshot request with ${Math.round(image.length / 1000)}kB image from ${Math.round(this.snapshots.age() / 1000)}s ago`);
                callback(undefined, image);
            } else {
                if (this.ss3Camera.debug) this.log(`No snapshot available yet for '${this.ss3Camera.name}', sending a placeholder`);
                callback(undefined, this.snapshots.failing ? snapshotUnavailableImage : snapshotWaitingImage);
            }
        } catch (err) {
            this.log.error(`An error occurred while handling a snapshot request for '${this.ss3Camera.name}':`, err && err.message ? err.message : err);
            callback(err instanceof Error ? err : new Error(String(err)));
        }
    }

    // SimpliCams close their privacy shutter depending on the alarm state. Unless the shutter is known to be
    // open, neither show a cached image nor ask the camera, which could open the shutter
    async isPrivacyShutterClosed() {
        if (this.ss3Camera.motionIsTriggered || !this.ss3Camera.supportsPrivacyShutter()) return false;

        const settings = this.cameraDetails.cameraSettings;
        const open = setting => setting === 'open';
        const alarmState = await this.simplisafe.getCurrentAlarmState(alarmStateTimeout);
        switch (alarmState) {
        case 'OFF':
            return !open(settings.shutterOff);
        case 'HOME':
            return !open(settings.shutterHome);
        case 'AWAY':
            return !open(settings.shutterAway);
        case 'HOME_COUNT': // exit delay, between off and the new mode
            return !(open(settings.shutterOff) && open(settings.shutterHome));
        case 'AWAY_COUNT':
            return !(open(settings.shutterOff) && open(settings.shutterAway));
        case 'ALARM':
        case 'ALARM_COUNT':
            return false; // the shutter opens for an alarm
        default:
            return true; // unknown, err on the side of privacy
        }
    }

    // A time the snapshot must be newer than: the motion or doorbell press a notification is for, or 0 for any
    snapshotNotBefore(request) {
        const lastEventAt = this.ss3Camera.lastEventAt || 0;
        if (Date.now() - lastEventAt < recentEventWindow) return lastEventAt;

        const reasons = this.api.hap.ResourceRequestReason;
        const eventReason = reasons ? reasons.EVENT : 1;
        return request.reason === eventReason ? Date.now() - eventSnapshotMaxAge : 0;
    }

    isOnBattery() {
        return this.ss3Camera.getStreamProvider() === 'livekit' && this.ss3Camera.isBatteryPowered() && !this.ss3Camera.isCharging();
    }

    // A camera that keeps failing should not show an old image as if it were current forever
    snapshotIsAbandoned() {
        return this.snapshots.failures >= 2 && this.snapshots.age() > Math.max(staleSnapshotMinAge, 3 * this.snapshotRefreshAge());
    }

    snapshotRefreshAge() {
        if (this.ss3Camera.getStreamProvider() !== 'livekit') return legacySnapshotRefreshAge;

        if (this.isOnBattery()) {
            const minutes = Number(this.cameraOptions && this.cameraOptions.batterySnapshotMinutes) || defaultBatterySnapshotMinutes;
            return Math.max(1, minutes) * 60000;
        }

        return poweredSnapshotRefreshAge;
    }

    canRefreshSnapshot() {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) return false;
        // a running live view keeps the snapshot current, see cacheSnapshotFromStream
        if (this.ss3Camera.getStreamProvider() === 'livekit' && Object.keys(this.liveKitSessions).length) return false;
        return true;
    }

    async resolveMediaServer() {
        try {
            let newIpAddress = await dnsLookup('media.simplisafe.com');
            this.serverIpAddress = newIpAddress.address;
        } catch (err) {
            if (!this.serverIpAddress) throw new Error('Could not resolve hostname for media.simplisafe.com');
        }
        return this.serverIpAddress;
    }

    async fetchLegacySnapshot() {
        await this.resolveMediaServer();
        return fetchMjpegFrame({
            host: this.serverIpAddress, // TLS is not verified as we connect by the IP we just looked up
            path: `/v1/${this.cameraDetails.uuid}/mjpg?x=${this.snapshotWidth}&fr=1`,
            headers: {
                'Authorization': `Bearer ${this.ss3Camera.authManager.accessToken}`
            },
            timeout: legacySnapshotTimeout
        });
    }

    handlePrivacyShutterClosedSnapshotRequest(callback) {
        if (this.ss3Camera.debug) this.log(`Camera snapshot request ignored, '${this.cameraDetails.cameraSettings.cameraName}' privacy shutter closed`);
        callback(undefined, privacyShutterImageInBytes);
    }

    handleUnsupportedCameraSnapshotRequest(callback) {
        if (this.ss3Camera.debug) this.log(`Camera snapshot request ignored, '${this.cameraDetails.cameraSettings.cameraName}' is not supported`);
        callback(undefined, unsupportedCameraImageInBytes);
    }

    prepareStream(request, callback) {
        // one line, the request carries the stream's encryption keys
        if (this.ss3Camera.debug) this.log(`Prepare stream for '${this.ss3Camera.name}' to ${request.targetAddress}`);
        let response = {};
        let sessionInfo = {
            address: request.targetAddress
        };

        let sessionID = request.sessionID;

        if (request.video) {
            let ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            let ssrc = ssrcSource.readInt32BE(0, true);

            response.video = {
                port: request.video.port,
                ssrc: ssrc,
                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            };

            sessionInfo.video_port = request.video.port;
            sessionInfo.video_srtp = Buffer.concat([
                request.video.srtp_key,
                request.video.srtp_salt
            ]);
            sessionInfo.video_ssrc = ssrc;
        }

        if (request.audio) {
            let ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            let ssrc = ssrcSource.readInt32BE(0, true);

            response.audio = {
                port: request.audio.port,
                ssrc: ssrc,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            };

            sessionInfo.audio_port = request.audio.port;
            sessionInfo.audio_srtp = Buffer.concat([
                request.audio.srtp_key,
                request.audio.srtp_salt
            ]);
            sessionInfo.audio_ssrc = ssrc;
        }

        response.address = {
            address: localIPv4Address(),
            type: 'v4'
        };

        let sessionIdentifier = this.api.hap.uuid.unparse(sessionID);

        // Join now, the handshake takes several seconds which is too slow to run inside handleStreamRequest
        if (this.ss3Camera.getStreamProvider() === 'livekit') {
            sessionInfo.preparedAt = Date.now();
            sessionInfo.liveKit = this.acquireLiveKitSource(); // failures are handled in handleStreamRequest

            // HomeKit does not always follow up with a 'start', don't hold the room open waiting
            sessionInfo.prepareTimeoutID = setTimeout(() => {
                if (this.pendingSessions[sessionIdentifier] !== sessionInfo) return;
                delete this.pendingSessions[sessionIdentifier];
                this.releaseLiveKitSource(sessionInfo.liveKit);
                if (this.ss3Camera.debug) this.log(`Closed LiveKit session for '${this.ss3Camera.name}' that was prepared but never started`);
            }, prepareTimeout);
        }

        this.pendingSessions[sessionIdentifier] = sessionInfo;

        callback(undefined, response);
    }

    async handleStreamRequest(request, callback) {
        if (this.ss3Camera.debug) {
            const video = request.video;
            const audio = request.audio;
            const details = request.type == 'start' && video
                ? `: ${video.width}x${video.height} at ${video.fps} fps, ${video.max_bit_rate} kbps${audio ? `, ${audio.codec} audio at ${audio.sample_rate} kHz` : ''}`
                : '';
            this.log(`Stream ${request.type} for '${this.ss3Camera.name}'${details}`);
        }

        if (this.ss3Camera.getStreamProvider() === 'livekit' && request.type == 'start') {
            let sessionIdentifier = this.api.hap.uuid.unparse(request.sessionID);
            let sessionInfo = this.pendingSessions[sessionIdentifier];
            delete this.pendingSessions[sessionIdentifier];

            if (!sessionInfo) {
                callback(new Error('No pending session for stream start'));
                return;
            }

            this.startLiveKitStream(request, sessionIdentifier, sessionInfo, callback);
            return;
        }

        if (this.ss3Camera.isUnsupported()) {
            let err = new Error(`Camera ${this.ss3Camera.name} is unsupported`);
            this.log.error(err);
            callback(err);
            return;
        }

        let sessionId = request.sessionID;
        if (sessionId) {
            let sessionIdentifier = this.api.hap.uuid.unparse(sessionId);

            if (request.type == 'start') {

                if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
                    delete this.pendingSessions[sessionIdentifier];
                    let err = new Error('Camera stream request blocked (rate limited)');
                    this.log.error(err);
                    callback(err);
                    return;
                }

                let sessionInfo = this.pendingSessions[sessionIdentifier];
                if (sessionInfo) {
                    // HomeKit's callback throws if called twice, e.g. on both 'error' and 'close' of a failed spawn
                    let answered = false;
                    const answer = err => {
                        if (answered) return;
                        answered = true;
                        callback(err);
                    };

                    try {
                        await this.resolveMediaServer();
                    } catch (err) {
                        delete this.pendingSessions[sessionIdentifier];
                        this.log.error('Camera stream request failed:', err.message);
                        answer(err);
                        return;
                    }

                    try {
                        let { source, video, audio } = this.buildLegacyStreamArgs(request, sessionInfo);
                        let cmd = spawn(this.ss3Camera.ffmpegPath, [
                            ...source,
                            ...video,
                            ...audio
                        ], {
                            env: process.env
                        });
    
                        if (this.ss3Camera.debug) {
                            this.log(`Start streaming video for camera '${this.ss3Camera.name}'`);
                            this.log(redactFfmpegArgs([this.ss3Camera.ffmpegPath, ...source, ...video, ...audio]).join(' '));
                        }
    
                        let started = false;
                        cmd.stderr.on('data', data => {
                            if (!started) {
                                started = true;
                                if (this.ss3Camera.debug) this.log('FFMPEG received first frame');
                                answer(); // do not forget to execute callback once set up
                            }
                            if (this.ss3Camera.debug) {
                                this.log(data.toString());
                            }
                        });
    
                        cmd.on('error', err => {
                            this.log.error('An error occurred while making stream request:', err);
                            answer(err);
                        });
    
                        cmd.on('close', code => {
                            switch (code) {
                            case null:
                            case 0:
                            case 255:
                                if (this.ss3Camera.debug) this.log('Camera stopped streaming');
                                break;
                            default:
                                if (this.ss3Camera.debug) this.log(`Error: FFmpeg exited with code ${code}`);
                                if (!started) {
                                    answer(new Error(`Error: FFmpeg exited with code ${code}`));
                                } else {
                                    this.controller.forceStopStreamingSession(sessionId);
                                }
                                break;
                            }
                        });
    
                        this.ongoingSessions[sessionIdentifier] = cmd;
                    } catch (e) {
                        this.log.error(`Unable to spawn ffmpeg process at ${this.ss3Camera.ffmpegPath} with error:`, e);
                        answer(e);
                    }
                } else {
                    callback(new Error('No pending session for stream start'));
                }

                delete this.pendingSessions[sessionIdentifier];

            } else if (request.type == 'stop') {
                let cmd = this.ongoingSessions[sessionIdentifier];
                try {
                    if (cmd) {
                        cmd.kill('SIGKILL');
                    }
                } catch (e) {
                    this.log.error('Error occurred terminating the video process!');
                    if (this.ss3Camera.debug) this.log.error(e);
                }

                delete this.ongoingSessions[sessionIdentifier];
                this.stopLiveKitStream(sessionIdentifier);
                callback();
            } else {
                // 'reconfigure', nothing to change but HAP still needs the callback
                callback();
            }
        }
    }

    // ffmpeg arguments for the cameras streamed from media.simplisafe.com (SimpliCam, Video Doorbell Pro)
    buildLegacyStreamArgs(request, sessionInfo) {
        let width = request.video.width ?? 1920;
        let fps = this.cameraDetails.cameraSettings.admin.fps;
        let videoBitrate = this.cameraDetails.cameraSettings.admin.bitRate;
        let audioBitrate = request.audio.max_bit_rate ?? 96;
        let audioSamplerate = request.audio.sample_rate ?? 16;
        let mtu = request.video.mtu ?? 1316;

        if (request.video.fps < fps) {
            fps = request.video.fps;
        }
        if (request.video.max_bit_rate < videoBitrate) {
            videoBitrate = request.video.max_bit_rate;
        }

        let sourceArgs = [
            // Take the frame rate from the stream metadata rather than probing 2s of video, and decode
            // without frame threading, which holds back a frame per thread. No -re, on a live source it
            // keeps the startup backlog as delay for the whole session. -analyzeduration stays at its
            // default so a late audio track is still found
            ['-fpsprobesize', '0'],
            ['-flags', 'low_delay'],
            ['-headers', `Authorization: Bearer ${this.ss3Camera.authManager.accessToken}`],
            ['-i', `https://${this.serverIpAddress}/v1/${this.cameraDetails.uuid}/flv?x=${width}&audioEncoding=AAC`]
        ];

        let videoArgs = [
            ['-map', '0:v:0'],
            ['-vcodec', 'libx264'],
            ['-tune', 'zerolatency'],
            ['-preset', 'superfast'],
            ['-pix_fmt', 'yuv420p'],
            ['-r', fps],
            ['-g', fps * 2], // a keyframe every 2s so the picture recovers quickly after packet loss
            ['-f', 'rawvideo'],
            ['-vf', `scale=${width}:-2`],
            ['-b:v', `${videoBitrate}k`],
            ['-bufsize', `${2*videoBitrate}k`],
            ['-maxrate', `${videoBitrate}k`],
            ['-payload_type', videoPayloadType],
            ['-ssrc', sessionInfo.video_ssrc],
            ['-f', 'rtp'],
            ['-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80'],
            ['-srtp_out_params', sessionInfo.video_srtp.toString('base64')],
            [`srtp://${sessionInfo.address}:${sessionInfo.video_port}?rtcpport=${sessionInfo.video_port}&localrtcpport=${sessionInfo.video_port}&pkt_size=${mtu}`]
        ];

        let audioArgs = [
            ['-map', '0:a:0'],
            ['-acodec', 'libfdk_aac'],
            ['-flags', '+global_header'],
            ['-profile:a', 'aac_eld'],
            ['-ac', '1'],
            ['-ar', `${audioSamplerate}k`],
            ['-b:a', `${audioBitrate}k`],
            ['-bufsize', `${2*audioBitrate}k`],
            ['-payload_type', audioPayloadType],
            ['-ssrc', sessionInfo.audio_ssrc],
            ['-f', 'rtp'],
            ['-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80'],
            ['-srtp_out_params', sessionInfo.audio_srtp.toString('base64')],
            [`srtp://${sessionInfo.address}:${sessionInfo.audio_port}?rtcpport=${sessionInfo.audio_port}&localrtcpport=${sessionInfo.audio_port}&pkt_size=188`]
        ];

        if (isDocker() && (!this.cameraOptions || !this.cameraOptions.ffmpegPath)) { // if docker and no custom binary specified
            if (this.ss3Camera.debug) this.log('Detected running in docker container with bundled binary, limiting to 720px wide');
            width = Math.min(width, 720);
            let vFilterArg = videoArgs.find(arg => arg[0] == '-vf');
            vFilterArg[1] = `scale=${width}:-2`;
        }

        if (request.audio && request.audio.codec == 'OPUS') {
            // Request is for OPUS codec, serve that
            let iArg = sourceArgs.find(arg => arg[0] == '-i');
            iArg[1] = iArg[1].replace('&audioEncoding=AAC', '');
            let aCodecArg = audioArgs.find(arg => arg[0] == '-acodec');
            aCodecArg[1] = 'libopus';
            let profileArg = audioArgs.find(arg => arg[0] == '-profile:a');
            audioArgs.splice(audioArgs.indexOf(profileArg), 1);
        }

        if (this.cameraOptions) {
            if (this.cameraOptions.enableHwaccelRpi) {
                let iArg = sourceArgs.find(arg => arg[0] == '-i');
                sourceArgs.splice(sourceArgs.indexOf(iArg), 0, ['-vcodec', 'h264_mmal']);
                let vCodecArg = videoArgs.find(arg => arg[0] == '-vcodec');
                vCodecArg[1] = 'h264_omx';
                videoArgs = videoArgs.filter(arg => arg[0] !== '-tune');
                videoArgs = videoArgs.filter(arg => arg[0] !== '-preset');
            }

            sourceArgs = applyFfmpegOptions(sourceArgs, this.cameraOptions.sourceOptions, 'input');
            videoArgs = applyFfmpegOptions(videoArgs, this.cameraOptions.videoOptions, 'output');
            audioArgs = applyFfmpegOptions(audioArgs, this.cameraOptions.audioOptions, 'output');
        }

        return {
            source: flattenFfmpegArgs(sourceArgs),
            video: flattenFfmpegArgs(videoArgs),
            audio: flattenFfmpegArgs(audioArgs)
        };
    }

    createSrtpSession(keyAndSalt) {
        return new SrtpSession({
            profile: ProtectionProfileAes128CmHmacSha1_80,
            keys: {
                localMasterKey: keyAndSalt.subarray(0, 16),
                localMasterSalt: keyAndSalt.subarray(16, 30),
                remoteMasterKey: keyAndSalt.subarray(0, 16),
                remoteMasterSalt: keyAndSalt.subarray(16, 30)
            }
        });
    }

    // Re-stamp RTP for HomeKit then encrypt with the keys it gave us in prepareStream.
    // The packet is shared with other live views and the snapshot, so it is copied rather than changed.
    // werift has already stripped any padding from the payload, so the copy must not claim padding, and
    // LiveKit's padding-only packets (bandwidth probes) carry nothing for HomeKit
    forwardRtp(rtp, srtp, socket, payloadType, ssrc, port, address) {
        if (!rtp.payload || !rtp.payload.length) return;
        try {
            let header = new RtpHeader({ ...rtp.header, payloadType: payloadType, ssrc: ssrc, extension: false, extensions: [], padding: false, paddingSize: 0 });
            socket.send(srtp.encrypt(rtp.payload, header), port, address);
        } catch (e) {
            if (this.ss3Camera.debug) this.log.error('Error forwarding RTP to HomeKit:', e.message);
        }
    }

    jpegFromKeyframe(annexB) {
        return new Promise((resolve, reject) => {
            let cmd = spawn(this.ss3Camera.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'h264', '-i', 'pipe:0',
                '-frames:v', '1',
                '-vf', 'scale=\'min(1280,iw)\':-2',
                '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1'
            ], { env: process.env });

            let chunks = [];
            let stderr = '';
            cmd.stdout.on('data', data => chunks.push(data));
            cmd.stderr.on('data', data => { stderr += data.toString(); });
            cmd.on('error', reject);
            cmd.on('close', code => {
                if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
                else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-200)}`));
            });
            cmd.stdin.on('error', () => {}); // ignore EPIPE
            cmd.stdin.end(annexB);
        });
    }

    createLiveKitSource() {
        return new LiveKitSource(this.ss3Camera);
    }

    // One LiveKit connection per camera, shared by snapshots and live views. Waking a battery camera takes
    // seconds, so a live view opened while a snapshot is being taken joins that wake-up rather than starting
    // its own, and a second viewer joins the first. It closes as soon as nobody uses it, so sharing never
    // keeps a camera awake. Returns a lease to give back with releaseLiveKitSource
    acquireLiveKitSource() {
        let shared = this.liveKitShared;
        let reused = !!shared && !shared.source.closed;

        if (reused) {
            if (this.ss3Camera.debug) this.log(`Reusing the LiveKit connection to '${this.ss3Camera.name}'`);
        } else {
            let source = this.createLiveKitSource();
            shared = { source: source, users: 0, ready: source.connect() };
            // a failed join is not reused, the next snapshot or live view starts a new one
            shared.ready.catch(() => this.closeLiveKitSource(shared));
            this.liveKitShared = shared;
        }

        shared.users++;
        return { shared: shared, source: shared.source, ready: shared.ready, reused: reused, released: false };
    }

    releaseLiveKitSource(lease) {
        if (!lease || lease.released) return;
        lease.released = true;
        lease.shared.users--;
        if (lease.shared.users <= 0) this.closeLiveKitSource(lease.shared);
    }

    closeLiveKitSource(shared) {
        shared.source.close();
        if (this.liveKitShared === shared) this.liveKitShared = null;
    }

    // Grabs a keyframe from the camera, joining its room unless a live view is already connecting
    async warmSnapshot() {
        let lease = this.acquireLiveKitSource();
        let source = lease.source;
        let keyframe = new KeyframeCollector();

        let onVideo;
        let onEnded;
        let captured = new Promise((resolve, reject) => {
            onVideo = rtp => {
                keyframe.push(rtp.payload, rtp.header);
                if (keyframe.complete) resolve(keyframe.annexB());
            };
            onEnded = reason => reject(new Error(`LiveKit session ended: ${reason}`));
        });
        captured.catch(() => {}); // a session that ends during the join fails the join instead
        source.on('video', onVideo);
        source.on('ended', onEnded);

        try {
            // joining a stream that is already running, ask for a keyframe rather than wait for the next one
            if (source.streaming) source.requestKeyframe();
            await withTimeout(lease.ready, liveKitSnapshotTimeout, source.timeoutMessage(liveKitSnapshotTimeout));
            let annexB = await withTimeout(captured, keyframeTimeout, 'Timed out waiting for a keyframe');
            let jpeg = await this.jpegFromKeyframe(annexB);

            if (this.ss3Camera.debug) this.log(`Cached snapshot for '${this.ss3Camera.name}' (${Math.round(jpeg.length / 1000)}kB)`);
            return jpeg;
        } finally {
            source.off('video', onVideo);
            source.off('ended', onEnded);
            this.releaseLiveKitSource(lease);
        }
    }

    // Caches a snapshot from a stream already in flight, costs one decoded frame
    cacheSnapshotFromStream(keyframe) {
        if (this.snapshotBusy || this.snapshots.age() < streamSnapshotInterval) return;

        this.snapshotBusy = true;
        let annexB = keyframe.annexB();
        keyframe.reset();

        this.jpegFromKeyframe(annexB)
            .then(jpeg => this.snapshots.set(jpeg))
            .catch(err => {
                if (this.ss3Camera.debug) this.log.error('Snapshot decode failed:', err.message);
            })
            .finally(() => { this.snapshotBusy = false; });
    }

    startLiveKitStream(request, sessionIdentifier, sessionInfo, callback) {
        clearTimeout(sessionInfo.prepareTimeoutID);

        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            this.releaseLiveKitSource(sessionInfo.liveKit);
            let err = new Error('Camera stream request blocked (rate limited)');
            this.log.error(err);
            callback(err);
            return;
        }

        try {
            this.setupLiveKitStream(request, sessionIdentifier, sessionInfo, callback);
        } catch (err) {
            this.log.error(`Could not start LiveKit stream for '${this.ss3Camera.name}':`, err.message);
            this.stopLiveKitStream(sessionIdentifier);
            this.releaseLiveKitSource(sessionInfo.liveKit);
            callback(err);
        }
    }

    setupLiveKitStream(request, sessionIdentifier, sessionInfo, callback) {
        let lease = sessionInfo.liveKit;
        let source = lease.source;
        let videoSrtp = this.createSrtpSession(sessionInfo.video_srtp);
        let socket = dgram.createSocket('udp4');
        let keyframe = new KeyframeCollector();

        // the listeners are removed again when the live view stops, the connection may outlive it
        let session = { lease: lease, socket: socket, stopped: false, listeners: {} };
        this.liveKitSessions[sessionIdentifier] = session;
        let listen = (event, listener) => {
            session.listeners[event] = listener;
            source.on(event, listener);
        };

        listen('video', rtp => {
            if (this.snapshots.age() >= streamSnapshotInterval) {
                keyframe.push(rtp.payload, rtp.header);
                if (keyframe.complete) this.cacheSnapshotFromStream(keyframe);
            }
            this.forwardRtp(rtp, videoSrtp, socket, videoPayloadType, sessionInfo.video_ssrc, sessionInfo.video_port, sessionInfo.address);
        });
        // video already flowing, e.g. to a snapshot or another viewer, HomeKit needs a keyframe to start from
        if (source.streaming) source.requestKeyframe();

        // Deferred until LiveKit has connected
        let startAudio = () => {
            if (!sessionInfo.audio_port || session.stopped) return;

            if (!request.audio || request.audio.codec !== 'OPUS') {
                this.log.warn(`HomeKit asked for ${request.audio && request.audio.codec} audio on '${this.ss3Camera.name}'. Remove and re-add the camera in the Home app to pick up Opus.`);
                return;
            }

            let audioSrtp = this.createSrtpSession(sessionInfo.audio_srtp);
            listen('audio', rtp => {
                this.forwardRtp(rtp, audioSrtp, socket, audioPayloadType, sessionInfo.audio_ssrc, sessionInfo.audio_port, sessionInfo.address);
            });
            if (this.ss3Camera.debug) this.log(`Audio: forwarding Opus to ${sessionInfo.address}:${sessionInfo.audio_port}`);
        };

        listen('ended', reason => {
            this.log.error(`LiveKit session for '${this.ss3Camera.name}' ended: ${reason}`);
            this.stopLiveKitStream(sessionIdentifier);
            try {
                this.controller.forceStopStreamingSession(request.sessionID);
            } catch (e) { /* session may already be gone */ }
        });

        // Media starts once the pre-warmed join finishes, HomeKit is acked now so it does not time out
        callback();

        lease.ready
            .then(() => {
                if (session.stopped) return;
                const waited = sessionInfo.preparedAt ? `, first video ${((Date.now() - sessionInfo.preparedAt) / 1000).toFixed(1)}s after the live view was requested` : '';
                const shared = lease.reused ? ' on the connection that was already open' : '';
                if (this.ss3Camera.debug) this.log(`Streaming '${this.ss3Camera.name}' from LiveKit without transcoding${waited}${shared}`);
                startAudio();
            })
            .catch(err => {
                if (session.stopped) return; // closed in the Home app before the video came
                this.log.error(`LiveKit stream failed for '${this.ss3Camera.name}':`, err.message);
                this.stopLiveKitStream(sessionIdentifier);
                try {
                    this.controller.forceStopStreamingSession(request.sessionID);
                } catch (e) { /* session may already be gone */ }
            });
    }

    stopLiveKitStream(sessionIdentifier) {
        let session = this.liveKitSessions[sessionIdentifier];
        if (!session) return;
        session.stopped = true;
        delete this.liveKitSessions[sessionIdentifier];

        for (let [event, listener] of Object.entries(session.listeners)) session.lease.source.off(event, listener);
        this.releaseLiveKitSource(session.lease);
        try { session.socket.close(); } catch (e) { /* already gone */ }
    }
}

export default StreamingDelegate;
