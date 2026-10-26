/**
 * wa-caller
 *
 * High-level WhatsApp voice calling for Baileys. Wraps the WhatsApp Web WASM
 * VoIP engine with a small, promise-friendly API and fast auto-answer.
 *
 * Credits: VoIP engine based on innovvoip by InnovatorsSoft. API shaped after
 * baileys-caller by ShellTear (MIT). See THIRD_PARTY_NOTICES.md.
 */
import { EventEmitter } from "node:events";
import {
  AudioDurationCache,
  probeAudioDuration,
  resolveFfmpeg,
} from "./audio.js";

export { CallDirection, CallMediaType, CallState } from "./vendor/innovvoip/types.mjs";
export { AudioDurationCache, probeAudioDuration, resolveFfmpeg };

const DEFAULT_DURATION_MS = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toMs = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const bareNumber = (jid) => String(jid || "").split("@")[0].split(":")[0];

const describeSession = (session) => ({
  callId: session.callId,
  from: session.peerJid || session.callCreator || "",
  fromNumber: bareNumber(session.peerJid || session.callCreator),
  isVideo: Boolean(session.isVideo),
  isGroup: Boolean(session.isGroup || String(session.peerJid || "").includes("@g.us")),
  session,
});

const isAcceptedStatus = (status) => ["accepted", "connected", "audio_ready", "streaming"].includes(status);

/**
 * Resolve a duration from a plan. Accepts numbers, promises and functions.
 * Falls back to maxSeconds, then defaultDurationMs.
 */
export async function resolveDuration(plan = {}, options = {}) {
  let raw = plan?.durationMs ?? plan?.durationMS ?? plan?.duration;
  if (typeof raw === "function") raw = await raw();
  else raw = await raw;
  let ms = toMs(raw);
  if (!ms) {
    const maxSeconds = toMs(plan?.maxSeconds ?? options.maxSeconds);
    if (maxSeconds) ms = maxSeconds * 1000;
  }
  return ms || toMs(options.defaultDurationMs) || DEFAULT_DURATION_MS;
}

export class WaCaller extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxConcurrentCalls: 1,
      pthreadPoolSize: 4,
      debug: false,
      logFile: null,
      ffmpegPath: null,
      rejectUnhandled: true,
      prewarmIncoming: true,
      defaultDurationMs: DEFAULT_DURATION_MS,
      audioCacheFile: undefined,
      ...options,
    };
    this.sock = null;
    this.client = null;
    this.ready = false;
    this.activeCall = null;
    this.incomingCall = null;
    this.incomingHandler = typeof options.onIncoming === "function" ? options.onIncoming : null;
    this.audioCache = new AudioDurationCache({
      file: this.options.audioCacheFile,
      ffmpegPath: this.options.ffmpegPath,
    });
    this._attaching = null;
    this._ownCallIds = new Set();
  }

  get activeCallCount() {
    return this.client?.getActiveCallCount?.() ?? (this.activeCall ? 1 : 0);
  }

  getMemoryStats() {
    return this.client?.getMemoryStats?.() || null;
  }

  /**
   * Attach to an already connected Baileys socket. Idempotent.
   * Compiles the WASM module in the background on first attach.
   */
  async attach(sock) {
    if (!sock) throw new TypeError("attach(sock) requires a connected Baileys socket");
    if (this.ready && this.sock === sock) return this;
    if (this._attaching) return this._attaching;
    if (this.sock && this.sock !== sock) this.destroy();

    this._attaching = this._attach(sock).finally(() => {
      this._attaching = null;
    });
    return this._attaching;
  }

  async _attach(sock) {
    const { VoipClient } = await import("./vendor/innovvoip/index.mjs");
    const ffmpegPath = await resolveFfmpeg(this.options.ffmpegPath);
    if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

    this.sock = sock;
    const client = new VoipClient({
      maxConcurrentCalls: this.options.maxConcurrentCalls,
      pthreadPoolSize: this.options.pthreadPoolSize,
      enableLogs: Boolean(this.options.debug),
      prewarmIncoming: Boolean(this.options.prewarmIncoming),
      debug: Boolean(this.options.debug),
      logFile: this.options.logFile,
      logger: this.options.logger,
    });
    this.client = client;
    this._wire(client);

    await client.initWithSocket(sock);
    this.ready = true;
    void client.warmup?.();
    this.emit("ready");
    return this;
  }

  _wire(client) {
    client.on("call_incoming", (session) => {
      this.incomingCall = session;
      if (!this.activeCall) this.activeCall = session;
      const info = describeSession(session);
      this.emit("incoming", session, info);
      this.emit("call_incoming", session);
      void this._handleIncoming(session).catch((error) => this._report(error));
    });

    client.on("call_accepted", (session) => {
      this.activeCall = session;
      this.emit("accepted", session);
      this.emit("call_accepted", session);
    });

    const onEnded = (session, reason) => {
      this._ownCallIds.delete(String(session?.callId || "").toLowerCase());
      if (this.activeCall?.callId === session?.callId) this.activeCall = null;
      if (this.incomingCall?.callId === session?.callId) this.incomingCall = null;
      this.emit("ended", session, reason);
      this.emit("call_ended", session, reason);
    };
    client.on("call_ended", onEnded);
    client.on("call_waiting", (session) => this.emit("waiting", session));
    client.on("call_rejected_capacity", (data) => this.emit("rejected_capacity", data));
    client.on("call_terminate_sent", (info) => this.emit("terminate_sent", info));
    client.on("error", (error) => this._report(error));
  }

  async _handleIncoming(session) {
    if (!session || session.ended) return;
    const handler = this.incomingHandler;
    if (!handler) {
      if (this.options.rejectUnhandled) await this._reject(session, "declined");
      return;
    }

    const info = describeSession(session);
    let plan = null;
    try {
      plan = await handler(info, session);
    } catch (error) {
      this._report(error);
      if (this.options.rejectUnhandled) await this._reject(session, "declined");
      return;
    }

    if (!plan || plan.accept === false) {
      if (this.options.rejectUnhandled || plan?.rejectReason) {
        await this._reject(session, plan?.rejectReason || "declined");
      }
      return;
    }

    const audioSource = plan.audioSource || plan.audio || "silence";
    const baseOptions = {
      audioSource,
      repeatAudio: plan.repeatAudio !== false,
      isMicEnabled: plan.isMicEnabled !== false,
      isCameraEnabled: Boolean(plan.isCameraEnabled),
    };
    if (plan.pthreadPoolSize !== undefined) baseOptions.pthreadPoolSize = plan.pthreadPoolSize;

    // Start the WASM engine immediately; accept() reuses it after the delay.
    const prepare = this.client
      .prepareAccept(session.callId, baseOptions)
      .catch((error) => { this._report(error); return null; });

    const delayMs = toMs(plan.delayMs) || toMs(Number(plan.delay) * 1000) || 0;
    const durationMs = await resolveDuration(plan, this.options);

    await prepare;
    if (delayMs) await sleep(delayMs);
    if (session.ended) return;

    try {
      const accepted = await session.accept({ ...plan, ...baseOptions, durationMs });
      this.activeCall = accepted || session;
    } catch (error) {
      this._report(error);
    }
  }

  async _reject(session, reason = "declined") {
    try {
      await session.reject(reason);
    } catch (error) {
      this._report(error);
    }
  }

  _report(error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else if (this.options.debug) console.error("[wa-caller]", err);
  }

  setIncomingHandler(handler) {
    this.incomingHandler = typeof handler === "function" ? handler : null;
    return this;
  }

  /**
   * Convenience auto-answer configuration.
   * @param {object} config
   * @param {boolean} [config.enabled=true]
   * @param {string} [config.audioSource="silence"] Local file, URL, lavfi:... or silence.
   * @param {number} [config.delayMs=0] Delay before accepting.
   * @param {number} [config.maxSeconds=120] Cap for audio-derived durations.
   * @param {boolean} [config.probe=true] Probe local audio duration (cached).
   */
  setAutoAnswer(config = {}) {
    const settings = {
      enabled: true,
      audioSource: "silence",
      delayMs: 0,
      maxSeconds: 120,
      repeatAudio: true,
      probe: true,
      allowVideo: false,
      allowGroups: false,
      ...config,
    };
    if (!settings.enabled) {
      this.incomingHandler = null;
      return this;
    }

    const source = settings.audioSource || settings.audio || "silence";
    this.incomingHandler = async (info) => {
      if (info.isVideo && !settings.allowVideo) return { accept: false, rejectReason: "video_not_supported" };
      if (info.isGroup && !settings.allowGroups) return { accept: false, rejectReason: "group_not_supported" };
      if (typeof settings.filter === "function" && !(await settings.filter(info))) {
        return { accept: false, rejectReason: "filtered" };
      }

      let durationMs = toMs(settings.durationMs);
      if (!durationMs && settings.probe !== false && source !== "silence") {
        const probed = await this.getAudioDuration(source).catch(() => 0);
        if (probed) durationMs = probed + 2000;
      }
      const capMs = toMs(settings.maxSeconds) * 1000;
      if (durationMs && capMs) durationMs = Math.min(durationMs, capMs);
      if (!durationMs) durationMs = capMs || this.options.defaultDurationMs;

      return {
        accept: true,
        audioSource: source,
        delayMs: toMs(settings.delayMs),
        durationMs,
        repeatAudio: settings.repeatAudio !== false,
      };
    };
    return this;
  }

  /** Place an outgoing voice call. */
  async call(phoneNumber, options = {}) {
    if (!this.ready || !this.client) throw new Error("Caller is not attached to a WhatsApp socket");
    if (this.activeCall) throw new Error("A call is already active");
    const target = String(phoneNumber || "").trim();
    if (!target) throw new Error("A phone number or JID is required");

    const call = await this.client.call(target.includes("@") ? target : target.replace(/\D/g, ""), options);
    this.activeCall = call;
    this._ownCallIds.add(String(call.callId).toLowerCase());
    call.once("ended", () => {
      this._ownCallIds.delete(String(call.callId).toLowerCase());
      if (this.activeCall === call) this.activeCall = null;
    });
    return call;
  }

  /** Accept a ringing call you handled through the "incoming" event. */
  async accept(sessionOrId, options = {}) {
    if (!this.client) throw new Error("Caller is not attached to a WhatsApp socket");
    const callId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId?.callId;
    if (!callId) throw new Error("accept() requires a session or callId");
    const accepted = await this.client.acceptCall(callId, options);
    this.activeCall = accepted || this.activeCall;
    return accepted;
  }

  async reject(sessionOrId, reason = "declined") {
    if (!this.client) return;
    const callId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId?.callId;
    if (!callId) return;
    return this.client.rejectCall(callId, reason);
  }

  async hangup(reason = "hangup") {
    const call = this.activeCall;
    if (!call) return false;
    this.activeCall = null;
    try {
      await call.end(reason);
      return true;
    } catch {
      return false;
    }
  }

  end(reason = "hangup") {
    return this.hangup(reason);
  }

  getCall(sessionOrId) {
    if (!sessionOrId) return this.activeCall;
    if (typeof sessionOrId === "object") return sessionOrId;
    return this.client?.getCall(sessionOrId) || null;
  }

  isOwnCallEvent(callId) {
    if (!callId) return false;
    const needle = String(callId).toLowerCase();
    if (this._ownCallIds.has(needle)) return true;
    for (const id of this._ownCallIds) {
      if (String(id).toLowerCase() === needle) return true;
    }
    return String(this.activeCall?.callId || "").toLowerCase() === needle;
  }

  handleCallStatus(callId, status) {
    if (!this.isOwnCallEvent(callId)) return false;
    if (!["terminate", "reject", "timeout"].includes(status)) return false;
    const call = this.activeCall;
    this.activeCall = null;
    try { call?._forceEnd?.(status); } catch { }
    return true;
  }

  /** Probe and cache one audio duration (milliseconds, 0 when unknown). */
  getAudioDuration(source, options = {}) {
    return this.audioCache.getDuration(source, options);
  }

  preloadAudio(sources = []) {
    return this.audioCache.preload(sources);
  }

  setLogFile(filePath) {
    this.options.logFile = filePath || null;
    this.client?.setLogFile?.(this.options.logFile);
    return this;
  }

  setDiagnosticMode(enabled) {
    this.options.debug = Boolean(enabled);
    this.client?.setDiagnosticMode?.(this.options.debug);
    return this;
  }

  async warmup() {
    await resolveFfmpeg(this.options.ffmpegPath);
    if (!this.client) return false;
    return this.client.warmup();
  }

  destroy() {
    const client = this.client;
    this.client = null;
    this.sock = null;
    this.ready = false;
    this.activeCall = null;
    this.incomingCall = null;
    this._ownCallIds.clear();
    if (!client) return;
    try { client.endAllCalls?.(); } catch { }
    try { client.detach?.(); } catch { }
  }
}

let currentCaller = null;
let pendingHandler = null;

/** Create an independent caller instance (use attach(sock) to start it). */
export function createCaller(options = {}) {
  return new WaCaller(options);
}

/** Get/create the shared caller for this process and attach it to the socket. */
export function getCaller(sock, options = {}) {
  if (!currentCaller) {
    currentCaller = new WaCaller({
      ...options,
      onIncoming: options.onIncoming ?? pendingHandler,
    });
  }
  return currentCaller.attach(sock);
}

/** Choose how incoming calls are handled (null rejects when rejectUnhandled is on). */
export function setIncomingHandler(handler) {
  pendingHandler = typeof handler === "function" ? handler : null;
  currentCaller?.setIncomingHandler(pendingHandler);
}

/** Attach and compile the WASM module ahead of the first call. */
export async function preloadCaller(sock, options = {}) {
  const caller = await getCaller(sock, options);
  await caller.warmup();
  return caller;
}

export function isOwnCallEvent(callId) {
  return currentCaller?.isOwnCallEvent(callId) || false;
}

export function handleCallStatus(callId, status) {
  return currentCaller?.handleCallStatus(callId, status) || false;
}

export function cleanupCaller() {
  currentCaller?.destroy();
  currentCaller = null;
}

export default WaCaller;
