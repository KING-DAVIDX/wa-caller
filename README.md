# wa-caller

Fast, low-overhead WhatsApp voice calling for Baileys. Place calls, auto-answer
incoming calls, and play local audio, URLs or generated silence. Built on the
WhatsApp Web WASM VoIP engine, so no native WebRTC packages are required.

## Install

```bash
npm install github:KING-DAVIDX/wa-caller
```

Requirements:

- Node.js 20+
- A connected Baileys socket (`@whiskeysockets/baileys` 7.x)
- `ffmpeg` on PATH, or install `ffmpeg-static`
- The bot account must have permission to place/answer calls

`ffmpeg-static` and Baileys are optional peer dependencies; install them in the
host bot. wa-caller ships the VoIP WASM assets, so there is nothing else to copy.

## Quick start

```js
import { getCaller } from "wa-caller";

// `sock` is an already connected Baileys socket
const caller = await getCaller(sock);

const call = await caller.call("2348012345678", {
  audioSource: "./intro.mp3", // file path, https URL, lavfi:..., or "silence"
  durationMs: 30_000,
  repeatAudio: true,
});

call.on("ringing", () => console.log("ringing"));
call.on("connected", () => console.log("answered"));
call.once("ended", (reason) => console.log("ended:", reason));
```

Call numbers in international format without `+`/spaces, or pass a full JID
(`2348012345678@s.whatsapp.net`).

## Auto-answer

```js
const caller = await getCaller(sock);
caller.setAutoAnswer({
  enabled: true,
  audioSource: "./welcome.mp3",
  delayMs: 500,       // optional pickup delay
  maxSeconds: 120,    // cap audio-derived duration
});
```

Auto-answer uses a persistent duration cache, so the recording is not probed
while the phone is ringing. Pre-warm durations at startup to make the very first
pickup instant:

```js
await caller.preloadAudio(["./welcome.mp3"]);
```

Turn it off with `caller.setAutoAnswer({ enabled: false })`. With the default
`rejectUnhandled: true`, calls are declined when no handler is configured.

### Manual incoming handling

```js
const caller = new WaCaller({ rejectUnhandled: false });
await caller.attach(sock);

caller.on("incoming", async (session, info) => {
  if (info.isVideo) return caller.reject(session, "busy");
  await caller.accept(session, {
    audioSource: "./welcome.mp3",
    durationMs: 60_000,
    repeatAudio: true,
  });
});
```

Or use a handler; it may be async and can return a plan:

```js
caller.setIncomingHandler(async (info) => {
  if (info.isGroup) return null; // reject
  return {
    audioSource: "./welcome.mp3",
    delayMs: 300,
    durationMs: 45_000,
    repeatAudio: true,
  };
});
```

A handler can return `{ accept: false, rejectReason: "busy" }` to decline. A
falsy return declines too when `rejectUnhandled` is on.

## Audio

`audioSource` accepts:

- local file paths (mp3, ogg/opus, m4a, wav, ...)
- `https://` URLs
- `lavfi:<filter>` ffmpeg sources (for example `lavfi:sine=frequency=440`)
- `"silence"` (default)

`durationMs` controls how long audio is played; with `repeatAudio: true` the
source loops until the duration elapses. Use `caller.getAudioDuration(file)` to
probe a file once; the result is cached by path, size and mtime.

## API

| Method | Description |
| --- | --- |
| `await caller.attach(sock)` | Attach to a connected Baileys socket. |
| `await caller.call(number, options)` | Place an outgoing call. Returns a session. |
| `caller.setAutoAnswer(config)` | Answer incoming calls automatically. |
| `caller.setIncomingHandler(fn)` | Low-level incoming call handler. |
| `await caller.accept(session, opts)` | Accept a ringing call manually. |
| `await caller.reject(session, reason)` | Decline a call. |
| `await caller.hangup(reason)` | End the active call. |
| `await caller.preloadAudio(files)` | Probe/cache durations. |
| `caller.getAudioDuration(file)` | Cached duration in milliseconds. |
| `await caller.warmup()` | Compile the WASM module ahead of time. |
| `caller.getMemoryStats()` | WASM/worker/ffmpeg metrics. |
| `caller.destroy()` | End calls and detach. |
| `getCaller(sock, options)` | Shared singleton (used by most bots). |
| `createCaller(options)` | Independent instance. |
| `cleanupCaller()` | Destroy the shared instance. |
| `handleCallStatus(callId, status)` | Forward Baileys call status events. |
| `isOwnCallEvent(callId)` | Check whether a call belongs to this caller. |

Events: `ready`, `incoming`, `accepted`, `ended`, `waiting`,
`rejected_capacity`, `terminate_sent`, `error`. The vendor event names
(`call_incoming`, `call_accepted`, `call_ended`) are also emitted.
Outgoing sessions also emit `ringing`, `connected`, `accepted`, `ended`, etc.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `debug` | `false` | Console diagnostics and WASM logs. |
| `logFile` | `null` | Optional async log file (never blocks the event loop). |
| `pthreadPoolSize` | `4` | WASM worker threads per call. Lower = lighter. |
| `prewarmIncoming` | `true` | Start the media engine as soon as a call rings. |
| `rejectUnhandled` | `true` | Decline calls when no handler accepts them. |
| `ffmpegPath` | auto | Override ffmpeg binary. |
| `defaultDurationMs` | `120000` | Fallback call duration. |
| `maxConcurrentCalls` | `1` | Concurrent call limit. |
| `audioCacheFile` | tmpdir | Duration cache path; `null` = memory only. |

## Performance notes

This package is tuned for bots that need to answer fast:

- no synchronous file writes in the call path (the old engine wrote every
  diagnostic line with `appendFileSync`)
- WASM engine logs are off unless `debug` is enabled
- the media engine starts on the incoming offer, and `prepareAccept()` is kicked
  off before any pickup delay
- audio durations are cached by path + size + mtime and can be preloaded
- WASM compilation is cached and warmed in the background after attach

If the host is memory constrained, set `pthreadPoolSize: 2` and keep
`maxConcurrentCalls: 1`.

## Troubleshooting

- **Call rings but nobody hears audio**: verify `ffmpeg` works and the file is
  readable; try `audioSource: "lavfi:sine=frequency=440"`.
- **Calls fail immediately**: make sure the Baileys socket is fully open and the
  account is not restricted from calling.
- **No caller responses**: call `await caller.warmup()` after attach, and ensure
  both the bot and the caller use the same process.
- **Logs**: `debug: true` for console; `logFile: "voip-debug.log"` for a file.

## Disclaimer

This is an unofficial client and is not affiliated with WhatsApp or Meta. Using
automated calling may violate WhatsApp's Terms of Service and can get an account
banned. Use only on accounts you own and with consent from recipients.

## Credits

- VoIP/WASM engine: innovvoip by InnovatorsSoft (`src/vendor/innovvoip`).
- API inspiration: baileys-caller by ShellTear (MIT).
- WASM assets belong to Meta Platforms, Inc.; see `THIRD_PARTY_NOTICES.md`.
