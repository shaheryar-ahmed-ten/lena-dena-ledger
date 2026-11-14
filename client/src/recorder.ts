// Records one utterance from the microphone and stops by itself after a pause.

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];

export interface Recording { blob: Blob; spoke: boolean; seconds: number }
export interface RecorderSession { stop(): void; cancel(): void; done: Promise<Recording | null> }

export function canRecord(): boolean {
  return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder === "function";
}

export async function startRecorder({ onTick, maxSeconds = 45, silenceMs = 1600, giveUpMs = 8000 }: { onTick?: (s: number) => void; maxSeconds?: number; silenceMs?: number; giveUpMs?: number } = {}): Promise<RecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };

  // Level meter for auto-stop: wait for speech, then stop after a pause.
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Float32Array<ArrayBuffer> | null = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext!;
    ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    buf = new Float32Array(analyser.fftSize);
    src.connect(analyser);
  } catch { /* no auto-stop; the Stop button still works */ }

  const started = performance.now();
  let spoke = false, lastLoud = started, floor = 0.01, cancelled = false, finished = false;
  let resolveDone!: (r: Recording | null) => void;
  const done = new Promise<Recording | null>(r => { resolveDone = r; });

  const timer = setInterval(() => {
    const now = performance.now();
    const secs = (now - started) / 1000;
    onTick?.(secs);
    if (analyser && buf) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (secs < 0.5) floor = Math.max(floor, rms * 1.5); // learn the room's background noise
      if (rms > Math.max(0.02, floor * 2)) { spoke = true; lastLoud = now; }
      if (spoke && now - lastLoud > silenceMs) stop();
      if (!spoke && now - started > giveUpMs) stop();
    }
    if (secs >= maxSeconds) stop();
  }, 100);

  function cleanup() {
    clearInterval(timer);
    stream.getTracks().forEach(t => t.stop());
    ctx?.close().catch(() => {});
  }

  rec.onstop = () => {
    cleanup();
    const seconds = (performance.now() - started) / 1000;
    resolveDone(cancelled ? null : { blob: new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }), spoke: spoke || !analyser, seconds });
  };

  function stop() {
    if (finished) return;
    finished = true;
    if (rec.state !== "inactive") rec.stop();
    else rec.onstop?.(new Event("stop"));
  }

  rec.start(250);
  return { stop, cancel() { cancelled = true; stop(); }, done };
}
