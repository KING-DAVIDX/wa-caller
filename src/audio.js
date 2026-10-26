/**
 * Audio helpers: ffmpeg discovery, duration probing and a small persistent cache.
 *
 * Durations are cached by absolute path + size + mtime. This lets auto-answer
 * pick a call instantly instead of spawning ffmpeg while the phone is ringing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i;
const DEFAULT_CACHE_FILE = path.join(os.tmpdir(), "wa-caller-audio-cache.json");

let resolvedFfmpeg = null;

const isRemote = (source) => /^https?:\/\//i.test(String(source || ""));
const isSpecial = (source) => {
  const value = String(source || "");
  return !value || value === "silence" || value.startsWith("lavfi:") || isRemote(value);
};

/** Resolve the ffmpeg binary: explicit option, env var, ffmpeg-static, then PATH. */
export async function resolveFfmpeg(override) {
  if (override) return override;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (resolvedFfmpeg) return resolvedFfmpeg;
  try {
    const mod = await import("ffmpeg-static");
    const binary = mod.default || mod;
    if (typeof binary === "string" && fs.existsSync(binary)) {
      resolvedFfmpeg = binary;
      return binary;
    }
  } catch { }
  resolvedFfmpeg = "ffmpeg";
  return resolvedFfmpeg;
}

/** Read the duration of a local audio source in milliseconds. Returns 0 on failure. */
export function probeAudioDuration(source, options = {}) {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  if (isSpecial(source)) return Promise.resolve(0);

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer = null;
    let proc = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    try {
      proc = spawn(ffmpegPath, ["-hide_banner", "-i", String(source)], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      return finish(0);
    }

    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { }
      finish(0);
    }, timeoutMs);

    proc.stderr.on("data", (chunk) => { output += chunk; });
    proc.on("error", () => finish(0));
    proc.on("close", () => {
      const match = DURATION_RE.exec(output);
      if (!match) return finish(0);
      finish((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
    });
  });
}

const cacheKey = (source) => {
  if (isSpecial(source)) return null;
  try {
    const absolute = path.resolve(String(source));
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    return `${absolute}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return null;
  }
};

export class AudioDurationCache {
  /**
   * @param {object} [options]
   * @param {string|null} [options.file] JSON cache path. Set null/"" to keep memory-only.
   * @param {Function} [options.probe] Custom async probe (source, options) => ms.
   * @param {string} [options.ffmpegPath]
   */
  constructor(options = {}) {
    this.file = options.file === undefined
      ? (process.env.WA_CALLER_AUDIO_CACHE ?? DEFAULT_CACHE_FILE)
      : options.file;
    if (this.file === "") this.file = null;
    this.ffmpegPath = options.ffmpegPath || null;
    this.probe = options.probe || probeAudioDuration;
    this.entries = new Map();
    this._loaded = false;
    this._loading = null;
    this._saveTimer = null;
  }

  async ready() {
    if (this._loaded) return this;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      if (this.file) {
        try {
          const raw = await fsp.readFile(this.file, "utf8");
          const parsed = JSON.parse(raw);
          const entries = parsed?.entries || {};
          for (const [key, value] of Object.entries(entries)) {
            const ms = Number(value);
            if (Number.isFinite(ms) && ms > 0) this.entries.set(key, ms);
          }
        } catch { }
      }
      this._loaded = true;
      return this;
    })().finally(() => { this._loading = null; });
    return this._loading;
  }

  getCached(source) {
    const key = cacheKey(source);
    if (!key) return 0;
    return this.entries.get(key) || 0;
  }

  /** Get a cached duration or probe it. `refresh` bypasses the cache. */
  async getDuration(source, options = {}) {
    await this.ready();
    const key = cacheKey(source);
    if (!key) return 0;
    if (!options.refresh) {
      const cached = this.entries.get(key);
      if (cached) return cached;
    }
    const duration = Number(await this.probe(source, {
      ffmpegPath: this.ffmpegPath || undefined,
      timeoutMs: options.timeoutMs,
    }));
    if (Number.isFinite(duration) && duration > 0) {
      this.entries.set(key, duration);
      this._scheduleSave();
      return duration;
    }
    return 0;
  }

  /** Probe several sources concurrently. Returns a Map of source -> milliseconds. */
  async preload(sources = []) {
    await this.ready();
    const unique = [...new Set(sources.filter(Boolean))];
    const results = new Map();
    await Promise.all(unique.map(async (source) => {
      const duration = await this.getDuration(source).catch(() => 0);
      results.set(source, duration);
    }));
    return results;
  }

  set(source, durationMs) {
    const key = cacheKey(source);
    const ms = Number(durationMs);
    if (!key || !Number.isFinite(ms) || ms <= 0) return false;
    this.entries.set(key, ms);
    this._scheduleSave();
    return true;
  }

  clear(source) {
    const key = cacheKey(source);
    return key ? this.entries.delete(key) : false;
  }

  /** Persist pending changes immediately. */
  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._save();
    return this;
  }

  _scheduleSave() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this._save();
    }, 500);
    if (this._saveTimer?.unref) this._saveTimer.unref();
  }

  async _save() {
    if (!this.file) return;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const entries = Object.fromEntries(this.entries);
      await fsp.writeFile(this.file, JSON.stringify({ version: 1, entries }), "utf8");
    } catch { }
  }
}
