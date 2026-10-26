import { EventEmitter } from "node:events";

export interface AudioProbeOptions {
  ffmpegPath?: string;
  timeoutMs?: number;
}

export interface AudioDurationCacheOptions {
  file?: string | null;
  ffmpegPath?: string | null;
  probe?: (source: string, options?: AudioProbeOptions) => Promise<number>;
}

export class AudioDurationCache {
  constructor(options?: AudioDurationCacheOptions);
  ready(): Promise<this>;
  getCached(source: string): number;
  getDuration(source: string, options?: { refresh?: boolean; timeoutMs?: number }): Promise<number>;
  preload(sources?: string[]): Promise<Map<string, number>>;
  set(source: string, durationMs: number): boolean;
  clear(source: string): boolean;
  flush(): Promise<this>;
}

export function resolveFfmpeg(override?: string): Promise<string>;
export function probeAudioDuration(source: string, options?: AudioProbeOptions): Promise<number>;

export interface IncomingCallInfo {
  callId: string;
  from: string;
  fromNumber: string;
  isVideo: boolean;
  isGroup: boolean;
  session: CallSession;
}

export interface AnswerPlan {
  accept?: boolean;
  audioSource?: string;
  audio?: string;
  delayMs?: number;
  delay?: number;
  durationMs?: number | Promise<number> | (() => number | Promise<number>);
  maxSeconds?: number;
  repeatAudio?: boolean;
  isMicEnabled?: boolean;
  isCameraEnabled?: boolean;
  pthreadPoolSize?: number;
  rejectReason?: string;
  probeAudio?: boolean;
}

export interface CallOptions {
  audioSource?: string;
  audio?: string;
  durationMs?: number;
  repeatAudio?: boolean;
  isMicEnabled?: boolean;
  isCameraEnabled?: boolean;
  videoSource?: string;
  pthreadPoolSize?: number;
  [key: string]: unknown;
}

export interface AutoAnswerOptions {
  enabled?: boolean;
  audioSource?: string;
  audio?: string;
  delayMs?: number;
  durationMs?: number;
  maxSeconds?: number;
  repeatAudio?: boolean;
  probe?: boolean;
  allowVideo?: boolean;
  allowGroups?: boolean;
  filter?: (info: IncomingCallInfo) => boolean | Promise<boolean>;
}

export interface WaCallerOptions {
  maxConcurrentCalls?: number;
  pthreadPoolSize?: number | "auto";
  debug?: boolean;
  logFile?: string | null;
  ffmpegPath?: string | null;
  rejectUnhandled?: boolean;
  prewarmIncoming?: boolean;
  defaultDurationMs?: number;
  audioCacheFile?: string | null;
  logger?: unknown;
  onIncoming?: IncomingHandler;
}

export interface CallSession extends EventEmitter {
  callId: string;
  peerJid: string;
  callCreator?: string;
  status: string;
  isVideo: boolean;
  isIncoming: boolean;
  ended: boolean;
  connectedAt?: number;
  accept(options?: CallOptions): Promise<CallSession>;
  reject(reason?: string): Promise<void>;
  end(reason?: string): Promise<void>;
  mute(muted?: boolean): void;
  unmute(): void;
}

export type IncomingHandler = (
  info: IncomingCallInfo,
  session: CallSession
) => AnswerPlan | null | undefined | Promise<AnswerPlan | null | undefined>;

export class WaCaller extends EventEmitter {
  constructor(options?: WaCallerOptions);
  options: WaCallerOptions;
  sock: unknown;
  client: unknown;
  ready: boolean;
  activeCall: CallSession | null;
  incomingCall: CallSession | null;
  incomingHandler: IncomingHandler | null;
  audioCache: AudioDurationCache;
  readonly activeCallCount: number;

  attach(sock: unknown): Promise<this>;
  call(phoneNumber: string, options?: CallOptions): Promise<CallSession>;
  accept(sessionOrId: CallSession | string, options?: CallOptions): Promise<CallSession>;
  reject(sessionOrId: CallSession | string, reason?: string): Promise<void>;
  hangup(reason?: string): Promise<boolean>;
  end(reason?: string): Promise<boolean>;
  getCall(sessionOrId?: CallSession | string): CallSession | null;
  setIncomingHandler(handler: IncomingHandler | null): this;
  setAutoAnswer(options?: AutoAnswerOptions): this;
  getAudioDuration(source: string, options?: { refresh?: boolean; timeoutMs?: number }): Promise<number>;
  preloadAudio(sources?: string[]): Promise<Map<string, number>>;
  isOwnCallEvent(callId: string): boolean;
  handleCallStatus(callId: string, status: string): boolean;
  getMemoryStats(): Record<string, unknown> | null;
  setLogFile(filePath: string | null): this;
  setDiagnosticMode(enabled: boolean): this;
  warmup(): Promise<boolean>;
  destroy(): void;

  on(event: "ready", listener: () => void): this;
  on(event: "incoming", listener: (session: CallSession, info: IncomingCallInfo) => void): this;
  on(event: "accepted", listener: (session: CallSession) => void): this;
  on(event: "ended", listener: (session: CallSession, reason: string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

export function createCaller(options?: WaCallerOptions): WaCaller;
export function getCaller(sock: unknown, options?: WaCallerOptions): Promise<WaCaller>;
export function setIncomingHandler(handler: IncomingHandler | null): void;
export function preloadCaller(sock: unknown, options?: WaCallerOptions): Promise<WaCaller>;
export function isOwnCallEvent(callId: string): boolean;
export function handleCallStatus(callId: string, status: string): boolean;
export function cleanupCaller(): void;
export function resolveDuration(plan?: AnswerPlan, options?: { maxSeconds?: number; defaultDurationMs?: number }): Promise<number>;

export const CallState: {
  Idle: 0;
  Calling: 1;
  PreacceptReceived: 2;
  ReceivedCall: 3;
  AcceptSent: 4;
  AcceptReceived: 5;
  Active: 6;
  ActiveElsewhere: 7;
  Ending: 13;
};

export const CallDirection: { Outgoing: "outgoing"; Incoming: "incoming" };
export const CallMediaType: { Audio: "audio"; Video: "video" };

export default WaCaller;
