/**
 * 声音提醒（2026-10-19 用户要求；2026-10-21 用户提供自定义音频后扩展）。
 * 运行出错、需要人工补答或视频弹题自动作答失败时，使用者可能正在看别的窗口（如刷抖音），
 * 文字告警看不见——必须响铃。
 *
 * 播放优先级（0.2.8 §7 E2 回退链）：
 *   1. 打包进扩展的本机音频文件 `sounds/<kind>.{mp3,wav,ogg}`（用户自定义/内置音，绝不联网）；
 *   2. 现有固定双音合成蜂鸣（880/660 Hz，走音频时钟预排程，后台节流仍较稳）。
 * 浏览器在用户手势前可能挂起音频，运行页「开始运行」按钮点击即解锁（unlockAlarm）；
 * 文件与合成音都失败时静默降级为仅文字提示。音频只存本机、绝不上传，不含任何题文。
 */
export type AlarmKind = "error" | "needsInput" | "popupFailed";

let context: AudioContext | null = null;
let volume = 0.7;
/** Reused media element for the current kind, created lazily after the user gesture. */
let fileAudio: HTMLAudioElement | null = null;

/** Candidate filenames per kind (mp3 → wav → ogg). popupFailed falls back to the error sound. */
const SOUND_CANDIDATES: Record<AlarmKind, string[]> = {
  error: ["sounds/error.mp3", "sounds/error.wav", "sounds/error.ogg"],
  needsInput: ["sounds/needs-input.mp3", "sounds/needs-input.wav", "sounds/needs-input.ogg"],
  popupFailed: ["sounds/popup-failed.mp3", "sounds/popup-failed.wav", "sounds/popup-failed.ogg",
    "sounds/error.mp3", "sounds/error.wav", "sounds/error.ogg"]
};

function audioContextCtor(): (typeof AudioContext) | null {
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function audioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    if (context === null) context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

/** Resolve a packaged sound URL, or null outside an extension page (e.g. unit tests / node). */
function packagedSoundUrl(name: string): string | null {
  try {
    const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string; id?: string } } }).chrome?.runtime;
    if (runtime && typeof runtime.getURL === "function" && runtime.id) return runtime.getURL(name);
  } catch { /* Not in an extension context. */ }
  return null;
}

/** First packaged sound that actually exists for this kind, by trying each candidate URL. */
function firstPackagedSoundUrl(kind: AlarmKind): string | null {
  for (const name of SOUND_CANDIDATES[kind]) {
    const url = packagedSoundUrl(name);
    if (url) return url;
  }
  return null;
}

function playSynthetic(rounds: number): boolean {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  try {
    const start = ctx.currentTime + 0.05;
    for (let round = 0; round < Math.max(1, rounds); round++) {
      for (let tone = 0; tone < 2; tone++) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = tone === 0 ? 880 : 660;
        const at = start + round * 1.1 + tone * 0.28;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.32), at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.3);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Call from a real user gesture (the start button) so later alarms can actually sound. */
export function unlockAlarm(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  // Prime the media element inside the gesture: load the error sound, play muted briefly then
  // pause, so the page gains sticky user activation for audible playback on the next alarm.
  try {
    if (fileAudio === null) {
      const url = firstPackagedSoundUrl("error");
      if (url) { fileAudio = new Audio(url); fileAudio.preload = "auto"; }
    }
    if (fileAudio) {
      fileAudio.muted = true;
      const priming = fileAudio.play();
      if (priming && typeof priming.then === "function") {
        void priming.then(() => { if (fileAudio) { fileAudio.pause(); fileAudio.currentTime = 0; } })
          .catch(() => { fileAudio = null; });
      }
    }
  } catch { /* Priming failure just means file playback may fall back to synthetic later. */ }
}

/** Configurable alarm volume (0..1); applies to both the file and the synthetic beep. */
export function setAlarmVolume(value: number): void {
  volume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.7));
  if (fileAudio) fileAudio.volume = volume;
}

/** Stop any ongoing file alarm immediately (used when the user returns to the runner page). */
export function stopAlarm(): void {
  if (fileAudio) {
    try { fileAudio.pause(); fileAudio.currentTime = 0; } catch { /* already stopped */ }
  }
}

/**
 * Ring the alarm for a kind: try the packaged sound once, and if it is missing, blocked or
 * errors, fall back to the synthetic two-tone beep (`rounds` repetitions). Returns whether any
 * audio was started. The file plays once through; repetition cadence is the caller's concern.
 */
export function ring(kind: AlarmKind, rounds = 2): boolean {
  if (fileAudio === null) {
    const url = firstPackagedSoundUrl(kind);
    if (url) { fileAudio = new Audio(url); fileAudio.preload = "auto"; }
  }
  if (fileAudio) {
    try {
      const wanted = firstPackagedSoundUrl(kind);
      if (wanted && !fileAudio.src.endsWith(wanted)) fileAudio.src = wanted;
      fileAudio.volume = volume;
      fileAudio.currentTime = 0;
      const playing = fileAudio.play();
      if (playing && typeof playing.then === "function") {
        playing.catch(() => playSynthetic(rounds));
        return true;
      }
      return true;
    } catch {
      fileAudio = null;
      return playSynthetic(rounds);
    }
  }
  return playSynthetic(rounds);
}

/**
 * Back-compat: the legacy synthetic alarm. Kept so any existing caller still sounds; new code
 * should prefer `ring(kind)` so a user-supplied file is honoured.
 */
export function playAlarm(rounds = 2): boolean {
  return ring("error", rounds);
}
