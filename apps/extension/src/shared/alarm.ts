/**
 * 声音提醒（2026-10-19 用户要求）：运行出错、需要人工补答或视频弹题自动作答失败时，
 * 使用者可能正在看别的窗口（如刷抖音），文字告警看不见——必须响铃。固定双音蜂鸣，
 * 不读取页面内容、不依赖任何站点能力；浏览器在用户手势前可能挂起音频，运行页的
 * 「启动」按钮点击即解锁（unlockAlarm），失败静默降级为仅文字提示。
 */
let context: AudioContext | null = null;

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

/** Call from a real user gesture (e.g. the start button) so later alarms can actually sound. */
export function unlockAlarm(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

/**
 * Best-effort alarm: `rounds` repetitions of a fixed two-tone beep (880 Hz / 660 Hz), each
 * round 1.1s apart. Scheduling happens on the audio clock so a throttled background tab
 * still plays the pattern; returns whether any audio was scheduled at all.
 */
export function playAlarm(rounds = 2): boolean {
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
        gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
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
