import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AudioDurationCache,
  WaCaller,
  cleanupCaller,
  createCaller,
  getCaller,
  resolveDuration,
} from "../src/index.js";

const info = (overrides = {}) => ({
  callId: "CALL1",
  from: "2348000000000@s.whatsapp.net",
  fromNumber: "2348000000000",
  isVideo: false,
  isGroup: false,
  session: {},
  ...overrides,
});

test("package exports the expected API", () => {
  assert.equal(typeof WaCaller, "function");
  assert.equal(typeof createCaller, "function");
  assert.equal(typeof getCaller, "function");
  assert.equal(typeof cleanupCaller, "function");
  assert.equal(typeof resolveDuration, "function");
  assert.equal(typeof AudioDurationCache, "function");
});

test("resolveDuration handles numbers, promises, functions and fallbacks", async () => {
  assert.equal(await resolveDuration({ durationMs: 1500 }), 1500);
  assert.equal(await resolveDuration({ durationMs: Promise.resolve(2500) }), 2500);
  assert.equal(await resolveDuration({ durationMs: () => 3500 }), 3500);
  assert.equal(await resolveDuration({ durationMs: async () => 4500 }), 4500);
  assert.equal(await resolveDuration({ maxSeconds: 2 }), 2000);
  assert.equal(await resolveDuration({}, { defaultDurationMs: 7000 }), 7000);
});

test("auto-answer builds fast plans without probing", async () => {
  const caller = new WaCaller({ audioCacheFile: null });
  caller.setAutoAnswer({ audioSource: "silence", delayMs: 250, maxSeconds: 5 });

  const plan = await caller.incomingHandler(info());
  assert.equal(plan.accept, true);
  assert.equal(plan.audioSource, "silence");
  assert.equal(plan.delayMs, 250);
  assert.equal(plan.durationMs, 5000);

  const video = await caller.incomingHandler(info({ isVideo: true }));
  assert.equal(video.accept, false);

  caller.setAutoAnswer({ enabled: false });
  assert.equal(caller.incomingHandler, null);
});

test("auto-answer filters groups", async () => {
  const caller = new WaCaller({ audioCacheFile: null });
  caller.setAutoAnswer({ audioSource: "silence" });
  const plan = await caller.incomingHandler(info({ isGroup: true }));
  assert.equal(plan.accept, false);
  assert.equal(plan.rejectReason, "group_not_supported");
});

test("duration cache probes once and persists", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wa-caller-test-"));
  const cacheFile = path.join(dir, "cache.json");
  const audioFile = path.join(dir, "sample.mp3");
  await fsp.writeFile(audioFile, "not-a-real-mp3");

  let probes = 0;
  const probe = async () => {
    probes += 1;
    return 12_345;
  };

  const cache = new AudioDurationCache({ file: cacheFile, probe });
  assert.equal(await cache.getDuration(audioFile), 12_345);
  assert.equal(await cache.getDuration(audioFile), 12_345);
  assert.equal(probes, 1);
  assert.equal(cache.getCached(audioFile), 12_345);

  await cache.flush();

  let secondProbes = 0;
  const reloaded = new AudioDurationCache({
    file: cacheFile,
    probe: async () => { secondProbes += 1; return 999; },
  });
  assert.equal(await reloaded.getDuration(audioFile), 12_345);
  assert.equal(secondProbes, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("preload probes multiple sources concurrently", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wa-caller-preload-"));
  const a = path.join(dir, "a.mp3");
  const b = path.join(dir, "b.mp3");
  await fsp.writeFile(a, "a");
  await fsp.writeFile(b, "b");

  const seen = [];
  const cache = new AudioDurationCache({
    file: null,
    probe: async (source) => { seen.push(source); return source.endsWith("a.mp3") ? 1000 : 2000; },
  });
  const result = await cache.preload([a, b, a]);
  assert.equal(result.get(a), 1000);
  assert.equal(result.get(b), 2000);
  assert.deepEqual(seen.sort(), [a, b].sort());

  await fsp.rm(dir, { recursive: true, force: true });
});

test("own call tracking is case-insensitive", () => {
  const caller = new WaCaller({ audioCacheFile: null });
  caller._ownCallIds.add("ABCDEF");
  assert.equal(caller.isOwnCallEvent("abcdef"), true);
  assert.equal(caller.isOwnCallEvent("nope"), false);
});

test("call() ignores a stale active call that has already ended", async () => {
  const caller = new WaCaller({ audioCacheFile: null });
  caller.ready = true;
  caller.activeCall = { callId: "OLD", ended: true };
  const nextCall = { callId: "NEW", once() {} };
  caller.client = { call: async () => nextCall };

  const call = await caller.call("2348000000000");
  assert.equal(call, nextCall);
  assert.equal(caller.activeCall, nextCall);
});

test("call_ended clears the active auto-answered session", async () => {
  const caller = new WaCaller({ audioCacheFile: null, rejectUnhandled: false });
  const client = new EventEmitter();
  caller.client = client;
  caller._wire(client);

  const session = { callId: "CALL1", ended: false, peerJid: "2348000000000@s.whatsapp.net" };
  client.emit("call_incoming", session);
  assert.equal(caller.activeCall, session);

  client.emit("call_ended", session, "completed");
  assert.equal(caller.activeCall, null);
  assert.equal(caller.incomingCall, null);
});
