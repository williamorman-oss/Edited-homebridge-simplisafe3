import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import {
    ParticipantInfo_State,
    SignalRequest,
    SignalResponse,
    SessionDescription,
    TrickleRequest,
    SignalTarget
} from '@livekit/protocol';
import { rtpNalUnits, describeSps } from './h264';
import { liveKitJoin, liveKitLeave, liveKitRequestResponse, participants } from './diagnosticLines';

const trackTimeout = 30000; // ms, how long a live view waits for the camera's video
const keyframeRequestInterval = 1000; // ms, at most one keyframe request a second

// LiveKit subscriber. werift gives the encoded RTP so H.264 can be passed to HomeKit untouched.
// Emits 'video' and 'audio' with every RTP packet, so a snapshot and live views can share one connection,
// and 'ended' when a running session dies on us, not on a deliberate close
class LiveKitSource extends EventEmitter {
    constructor(ss3Camera) {
        super();
        this.ss3Camera = ss3Camera;
        this.simplisafe = ss3Camera.simplisafe;
        this.log = ss3Camera.log;
        this.debug = ss3Camera.debug;

        this.ws = null;
        this.pc = null;
        this.pingIntervalID = null;
        this.closed = false;
        this.streaming = false;
        this.videoTrack = null;
        this.videoPublisher = null;
        this.videoSsrc = null;
        this.lastKeyframeRequest = 0;
        this.keyframeRequestID = null;

        // what the camera sends, logged once per connection
        this.videoFormat = null;
        this.videoBytes = 0;
        this.videoStartedAt = null;
        this.keyframeTimestamps = [];
        this.lastKeyframeTimestamp = null;
        this.loggedSignals = new Set();
        this.lastParticipants = null;
        // who else is in the room, keyed by identity, which is never logged. LiveKit sends changes only
        this.room = new Map();
        this.sidToIdentity = new Map();
        this.selfIdentity = null;
    }

    _sessionEnded(reason) {
        if (this.closed || !this.streaming) return;
        const listeners = this.listeners('ended');
        this.close();
        for (const listener of listeners) listener(reason);
    }

    // Resolves once the first video RTP packet arrives i.e. media is flowing.
    // The timeout covers the whole join, including waking a sleeping battery camera
    async connect(timeoutMs = trackTimeout) {
        let timeoutID;
        const timedOut = new Promise((resolve, reject) => {
            timeoutID = setTimeout(() => reject(new Error(this.timeoutMessage(timeoutMs))), timeoutMs);
        });

        try {
            await Promise.race([this._connect(), timedOut]);
        } finally {
            clearTimeout(timeoutID);
        }
    }

    timeoutMessage(timeoutMs) {
        const details = this.ss3Camera.cameraDetails || {};
        const features = details.supportedFeatures || {};
        let hint = '';
        if (features.battery || features.wired === false) {
            const battery = details.cameraStatus && details.cameraStatus.batteryPercentage;
            const level = typeof battery === 'number' ? ` (${battery}% at last check)` : '';
            hint = ` It runs on battery${level} and may be asleep or out of charge, check its battery and Wi-Fi in the SimpliSafe app.`;
        }
        return `Timed out after ${timeoutMs / 1000}s waiting for video from ${this.ss3Camera.name}.${hint}`;
    }

    async _connect() {
        const liveView = await this.simplisafe.getCameraLiveView(this.ss3Camera.id);
        if (this.debug) this.log(`LiveKit: ${this.ss3Camera.name} cameraStatus ${liveView.cameraStatus}`);
        // closed while the live view was being requested, e.g. timed out
        if (this.closed) throw new Error('LiveKit session closed before joining');

        const url = `${liveView.liveKitURL}/rtc?access_token=${liveView.userToken}&auto_subscribe=1&protocol=15&sdk=js&version=2.22.3`;
        this.ws = new WebSocket(url);

        // LiveKit renegotiates repeatedly as tracks appear
        // Serialize offers so werift doesnt throw
        let offerChain = Promise.resolve();

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve();
            };

            const send = (message) => {
                try {
                    this.ws.send(new SignalRequest(message).toBinary());
                } catch (err) {
                    if (this.debug) this.log.error('LiveKit: failed to send signal:', err.message);
                }
            };

            this.ws.on('error', err => { settle(err); this._sessionEnded(err.message); });
            this.ws.on('close', () => {
                settle(new Error('LiveKit signalling closed before video started'));
                this._sessionEnded('signalling closed');
            });

            this.ws.on('message', async data => {
                if (this.closed) return; // e.g. a join arriving after a timeout, would open a peer connection nobody closes
                let response;
                try {
                    response = SignalResponse.fromBinary(new Uint8Array(data));
                } catch (err) {
                    return;
                }

                const message = response.message;
                const known = ['join', 'offer', 'trickle', 'update', 'requestResponse', 'leave', 'pong', 'pongResp'];
                if (this.debug && message.case && !known.includes(message.case) && !this.loggedSignals.has(message.case)) {
                    // only the kind of message, some carry tokens
                    this.loggedSignals.add(message.case);
                    this.log(`LiveKit: ${this.ss3Camera.name} sent a '${message.case}' message`);
                }

                switch (message.case) {
                case 'join':
                    this._handleJoin(message.value, send);
                    break;

                case 'offer': {
                    const sdp = message.value.sdp;
                    offerChain = offerChain
                        .then(async () => {
                            await this.pc.setRemoteDescription({ type: 'offer', sdp: sdp });
                            const answer = await this.pc.createAnswer();
                            await this.pc.setLocalDescription(answer);
                            send({ message: { case: 'answer', value: new SessionDescription({ type: 'answer', sdp: this.pc.localDescription.sdp }) } });
                        })
                        .catch(err => {
                            if (this.debug) this.log.error('LiveKit: negotiation failed:', err.message);
                        });
                    break;
                }

                case 'trickle':
                    try {
                        await this.pc.addIceCandidate(JSON.parse(message.value.candidateInit));
                    } catch (err) {
                        if (this.debug) this.log.error('LiveKit: bad ICE candidate:', err.message);
                    }
                    break;

                case 'update':
                    this._logParticipants(message.value.participants);
                    break;

                case 'requestResponse':
                    if (this.debug) this.log(`LiveKit: ${this.ss3Camera.name} request answered, ${liveKitRequestResponse(message.value)}`);
                    break;

                case 'leave':
                    if (this.debug) this.log(`LiveKit: server ended the session for ${this.ss3Camera.name}, ${liveKitLeave(message.value)}`);
                    settle(new Error('LiveKit server ended the session'));
                    this._sessionEnded('server ended the session');
                    this.close();
                    break;
                }
            });

            this._onFirstVideo = () => settle();
        });
    }

    _handleJoin(join, send) {
        if (this.closed) return;
        this.selfIdentity = join.participant && join.participant.identity;
        for (const info of join.otherParticipants || []) {
            this.room.set(info.identity, info);
            this.sidToIdentity.set(info.sid, info.identity);
        }

        // the room name ends in the subscription number, so it is not logged
        if (this.debug) {
            this.log(`LiveKit: joined the room for ${this.ss3Camera.name}`);
            this.log(`LiveKit: ${this.ss3Camera.name} room: ${liveKitJoin(join)}`);
            this.lastParticipants = participants([...this.room.values()]);
        }

        this.pc = new RTCPeerConnection({
            iceServers: (join.iceServers || []).map(server => ({
                urls: server.urls,
                username: server.username || undefined,
                credential: server.credential || undefined
            })),
            codecs: {
                // Explicitly request H.264
                video: [new RTCRtpCodecParameters({
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    payloadType: 96,
                    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
                    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
                })],
                audio: [new RTCRtpCodecParameters({
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                    payloadType: 111
                })]
            }
        });

        this.pc.onIceCandidate.subscribe(candidate => {
            if (!candidate) return;
            send({ message: { case: 'trickle', value: new TrickleRequest({ candidateInit: JSON.stringify(candidate), target: SignalTarget.SUBSCRIBER }) } });
        });

        // werift announces known tracks again on every renegotiation, listening twice would forward every packet twice
        const knownTracks = new WeakSet();
        this.pc.onTrack.subscribe(track => {
            if (knownTracks.has(track)) return;
            knownTracks.add(track);
            if (this.debug) this.log(`LiveKit: subscribed to ${track.kind} (${track.codec && track.codec.mimeType})`);

            if (track.kind === 'video') this.videoTrack = track;
            // LiveKit names a track's stream '<participant>|<track>'. Only the camera's own audio is wanted:
            // someone talking from the SimpliSafe app publishes into the same room
            const publisher = this._publisherOf(track);
            if (track.kind === 'video') this.videoPublisher = publisher;

            track.onReceiveRtp.subscribe(rtp => {
                if (this.closed) return;

                if (track.kind === 'video') {
                    this.streaming = true;
                    this.videoSsrc = rtp.header.ssrc;
                    if (this.videoStartedAt === null) this.videoStartedAt = Date.now();
                    this.videoBytes += rtp.payload ? rtp.payload.length : 0;
                    this._watchVideo(rtp);
                    if (this._onFirstVideo) {
                        const notify = this._onFirstVideo;
                        this._onFirstVideo = null;
                        notify();
                    }
                    this.emit('video', rtp);
                } else if (!publisher || !this.videoPublisher || publisher === this.videoPublisher) {
                    this.emit('audio', rtp);
                }
            });
        });

        if (join.pingInterval) {
            this.pingIntervalID = setInterval(() => {
                send({ message: { case: 'ping', value: BigInt(Date.now()) } });
            }, join.pingInterval * 1000);
        }
    }

    // The participant that published a track, from its stream id, or null if that is not known
    _publisherOf(track) {
        try {
            const transceiver = this.pc.getTransceivers().find(t => t.receiver && (t.receiver.track === track || (t.receiver.tracks || []).includes(track)));
            const streamId = transceiver && transceiver.receiver.remoteStreamId;
            return typeof streamId === 'string' && streamId ? streamId.split('|')[0] : null;
        } catch (e) {
            return null;
        }
    }

    // Who is in the room changed, e.g. the SimpliSafe app started talking through the camera
    _logParticipants(list) {
        for (const info of list || []) {
            // older servers leave the identity out when someone leaves
            const identity = info.identity || this.sidToIdentity.get(info.sid) || info.sid;
            if (!identity || identity === this.selfIdentity) continue;
            if (info.state === ParticipantInfo_State.DISCONNECTED) {
                this.room.delete(identity);
            } else {
                this.room.set(identity, info);
                if (info.sid) this.sidToIdentity.set(info.sid, identity);
            }
        }

        if (!this.debug) return;
        const summary = participants([...this.room.values()]);
        if (summary === this.lastParticipants) return;
        this.lastParticipants = summary;
        this.log(`LiveKit: ${this.ss3Camera.name} participants: ${summary}`);
    }

    // Notes the camera's H.264 profile and level and how often it sends keyframes, which decide whether
    // its video can be recorded without re-encoding. Emits 'keyframe' as each keyframe starts
    _watchVideo(rtp) {
        for (const nal of rtpNalUnits(rtp.payload)) {
            if (nal.type === 7 && nal.data && !this.videoFormat) this.videoFormat = describeSps(nal.data);
            if (nal.type !== 5 || rtp.header.timestamp === this.lastKeyframeTimestamp) continue;

            this.lastKeyframeTimestamp = rtp.header.timestamp;
            this.emit('keyframe', rtp);
            if (this.keyframeTimestamps.length < 4) {
                this.keyframeTimestamps.push(rtp.header.timestamp);
                if (this.keyframeTimestamps.length === 4 && this.debug) this.log(`LiveKit: ${this.ss3Camera.name} video ${this._videoDescription()}`);
            }
        }
    }

    _videoDescription() {
        const gaps = [];
        for (let i = 1; i < this.keyframeTimestamps.length; i++) {
            gaps.push((((this.keyframeTimestamps[i] - this.keyframeTimestamps[i - 1]) >>> 0) / 90000).toFixed(1));
        }
        const spacing = gaps.length ? `keyframes ${gaps.join('s, ')}s apart` : `${this.keyframeTimestamps.length} keyframe(s)`;
        return `H.264 ${this.videoFormat || 'profile unknown'}, ${spacing}`;
    }

    // Asks the camera, through LiveKit, for a keyframe. Someone joining a running stream otherwise
    // waits for the camera's next scheduled one before there is a picture
    requestKeyframe() {
        if (this.closed || !this.pc || this.videoSsrc === null) return false;

        // asked less than a second ago, that keyframe may already have gone by, so ask again once allowed
        const wait = this.lastKeyframeRequest + keyframeRequestInterval - Date.now();
        if (wait > 0) {
            if (!this.keyframeRequestID) {
                this.keyframeRequestID = setTimeout(() => {
                    this.keyframeRequestID = null;
                    this.requestKeyframe();
                }, wait);
            }
            return false;
        }

        const receivers = this.pc.getTransceivers().filter(t => t.kind === 'video').map(t => t.receiver);
        const receiver = receivers.find(r => r.track === this.videoTrack) || receivers[0];
        // werift silently sends nothing unless LiveKit offered picture loss feedback
        if (!receiver || !receiver.pliEnabled) return false;

        this.lastKeyframeRequest = Date.now();
        receiver.sendRtcpPLI(this.videoSsrc).catch(() => {});
        if (this.debug) this.log(`LiveKit: asked ${this.ss3Camera.name} for a keyframe`);
        return true;
    }

    close() {
        if (this.closed) return;
        this.closed = true;

        // a connection too short to log the keyframe spacing still says what the camera sent
        if (this.debug && this.streaming && this.keyframeTimestamps.length < 4) this.log(`LiveKit: ${this.ss3Camera.name} video ${this._videoDescription()}`);
        // what keeping this camera connected all the time would cost
        const seconds = this.videoStartedAt === null ? 0 : (Date.now() - this.videoStartedAt) / 1000;
        if (this.debug && seconds >= 5) this.log(`LiveKit: ${this.ss3Camera.name} sent ${Math.round(this.videoBytes * 8 / seconds / 1000)} kbps of video over ${Math.round(seconds)}s`);

        clearInterval(this.pingIntervalID);
        clearTimeout(this.keyframeRequestID);
        this.keyframeRequestID = null;
        this.streaming = false;
        this.removeAllListeners();

        try {
            if (this.pc) this.pc.close();
        } catch (err) { /* already gone */ }

        try {
            if (this.ws) this.ws.close();
        } catch (err) { /* already gone */ }

        this.pc = null;
        this.ws = null;
    }
}

export default LiveKitSource;
