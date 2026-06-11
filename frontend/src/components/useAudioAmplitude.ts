import { useEffect, useRef, useState, useCallback } from "react";

export type AudioSource = "microphone" | "element";

export interface UseAudioAmplitudeOptions {
  /** "microphone" (STT/listening) or "element" (TTS playback). Default: "microphone" */
  source?: AudioSource;
  /** HTMLAudioElement to analyse during TTS playback. Required when source="element". */
  audioElement?: HTMLAudioElement | null;
  /** Smoothing coefficient for the AnalyserNode (0–1). Default: 0.8 */
  smoothing?: number;
  /** FFT size. Default: 256 */
  fftSize?: number;
  /** Scale factor applied to the raw RMS before clamping to [0,1]. Default: 3.0 */
  gain?: number;
}

export interface UseAudioAmplitudeReturn {
  /** Normalised amplitude [0, 1] ready to pass to VoiceWave's amplitude prop */
  amplitude: number;
  /** Start analysing audio (call on user gesture for microphone) */
  start: () => Promise<void>;
  /** Stop and clean up */
  stop: () => void;
  /** Whether the analyser is currently running */
  active: boolean;
  /** Any error that occurred during setup */
  error: Error | null;
}

/**
 * useAudioAmplitude
 *
 * Drives a normalised amplitude value (0–1) from either the microphone
 * (STT/listening state) or an HTMLAudioElement (TTS playback state).
 *
 * Usage — microphone:
 *   const { amplitude, start, stop } = useAudioAmplitude({ source: "microphone" });
 *
 * Usage — TTS element:
 *   const audioRef = useRef<HTMLAudioElement>(null);
 *   const { amplitude } = useAudioAmplitude({ source: "element", audioElement: audioRef.current });
 */
export function useAudioAmplitude({
  source = "microphone",
  audioElement,
  smoothing = 0.8,
  fftSize = 256,
  gain = 3.0,
}: UseAudioAmplitudeOptions = {}): UseAudioAmplitudeReturn {
  const [amplitude, setAmplitude] = useState(0);
  const [active, setActive]       = useState(false);
  const [error, setError]         = useState<Error | null>(null);

  const contextRef  = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef   = useRef<MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number>(0);
  const dataRef     = useRef<Uint8Array>(new Uint8Array(fftSize / 2));

  const readRms = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    analyser.getByteTimeDomainData(dataRef.current);
    let sum = 0;
    for (let i = 0; i < dataRef.current.length; i++) {
      const v = (dataRef.current[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataRef.current.length);
    setAmplitude(Math.min(1, rms * gain));

    rafRef.current = requestAnimationFrame(readRms);
  }, [gain]);

  const start = useCallback(async () => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx      = new AudioCtx();
      contextRef.current = ctx;

      const analyser       = ctx.createAnalyser();
      analyser.fftSize     = fftSize;
      analyser.smoothingTimeConstant = smoothing;
      analyserRef.current  = analyser;
      dataRef.current      = new Uint8Array(analyser.frequencyBinCount);

      if (source === "microphone") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        streamRef.current = stream;
        const src = ctx.createMediaStreamSource(stream);
        src.connect(analyser);
        sourceRef.current = src;
      } else if (source === "element" && audioElement) {
        const src = ctx.createMediaElementSource(audioElement);
        src.connect(analyser);
        analyser.connect(ctx.destination); // pass-through so audio still plays
        sourceRef.current = src;
      } else {
        throw new Error("source='element' requires a valid audioElement reference.");
      }

      setActive(true);
      setError(null);
      rafRef.current = requestAnimationFrame(readRms);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [source, audioElement, fftSize, smoothing, readRms]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    sourceRef.current?.disconnect();
    contextRef.current?.close();
    contextRef.current  = null;
    analyserRef.current = null;
    sourceRef.current   = null;
    streamRef.current   = null;
    setAmplitude(0);
    setActive(false);
  }, []);

  // Auto-connect when source="element" and audioElement changes
  useEffect(() => {
    if (source === "element" && audioElement && !active) {
      start();
    }
  }, [source, audioElement, active, start]);

  // Cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  return { amplitude, start, stop, active, error };
}
