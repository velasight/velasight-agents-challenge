import { useRef, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WaveState = "idle" | "listening" | "speaking";

export type WaveTheme = {
  background: string;
  waves: WaveColor[];
};

export type WaveColor = {
  r: number;
  g: number;
  b: number;
};

export interface VoiceWaveProps {
  /** Current TTS/STT state */
  state?: WaveState;
  /**
   * Raw amplitude (0–1) from VAPI, Web Audio RMS, or WebSocket.
   * Pass the raw unsmoothed signal — the component's envelope follower
   * handles all smoothing internally. Do NOT pre-smooth before passing.
   */
  amplitude?: number;
  /** Visual theme. Defaults to THEME_VELVET_PLUM. */
  theme?: WaveTheme;
  /** Canvas height in px. Default: 200 */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  // ── Wave shape ─────────────────────────────────────────────────────────────
  /** Gaussian attenuation spread. Default: 1.4 */
  spread?: number;
  /** Base sine frequency. Default: 5.5 */
  frequency?: number;
  /** Radial halo radius multiplier. Default: 4.5 */
  haloRadius?: number;
  /** Peak color-blend intensity (0–1). Default: 0.96 */
  haloIntensity?: number;
  // ── Envelope follower ──────────────────────────────────────────────────────
  /**
   * Rise rate toward louder signal (0–1 per frame).
   * Default: 0.25 — fast enough to track speech onset without lag.
   */
  attackRate?: number;
  /**
   * Fall rate toward quieter signal (0–1 per frame).
   * This is the primary VAPI jitter fix: low values bridge the silence
   * gaps between syllables so the wave never snaps to zero mid-word.
   * Default: 0.04 — decays over ~400ms at 60fps.
   */
  releaseRate?: number;
  /**
   * Minimum amplitude even in silence. Keeps the wave alive as a
   * gentle idle motion rather than flattening completely between words.
   * Default: 0.08
   */
  amplitudeFloor?: number;
}

// ─── Built-in themes ─────────────────────────────────────────────────────────

export const THEME_VELVET_PLUM: WaveTheme = {
  background: "#3A1548",
  waves: [
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
    { r: 195, g: 205, b: 220 },
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
  ],
};

export const THEME_MIDNIGHT_NAVY: WaveTheme = {
  background: "#0C1829",
  waves: [
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
    { r: 195, g: 205, b: 220 },
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
  ],
};

export const THEME_DARK_TEAL: WaveTheme = {
  background: "#091E1A",
  waves: [
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
    { r: 195, g: 205, b: 220 },
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
  ],
};

export const THEME_DEEP_AUBERGINE: WaveTheme = {
  background: "#170E1B",
  waves: [
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
    { r: 195, g: 205, b: 220 },
    { r: 245, g: 138, b:  35 },
    { r:  79, g: 195, b: 247 },
  ],
};

/**
 * Dark Cognac — #1C1005
 *
 * Warm amber-brown ground. All three wave elements — orange, light blue,
 * and cool silver — maintain full separation at every amplitude state.
 * The lighter-composite crossing bloom resolves to warm gold-white rather
 * than cold white, producing the most luxurious version of the diamond
 * flash effect. Reads as aged leather, fine watchmaking, private wealth —
 * the sharpest contrast to every dominant aesthetic in real estate SaaS.
 *
 * Recommended as the primary theme for Velasight Home v1 launch.
 */
export const THEME_DARK_COGNAC: WaveTheme = {
  background: "#1C1005",
  waves: [
    { r: 245, g: 138, b:  35 },  // orange
    { r:  79, g: 195, b: 247 },  // light blue
    { r: 195, g: 205, b: 220 },  // cool silver / platinum
    { r: 245, g: 138, b:  35 },  // orange (harmonic)
    { r:  79, g: 195, b: 247 },  // light blue (harmonic)
  ],
};

// ─── Internal constants ───────────────────────────────────────────────────────

type WaveDef = {
  attFactor: number;
  phaseOffset: number;
  baseOpacity: number;
  lineWidthMultiplier: number;
};

const WAVE_DEFS: WaveDef[] = [
  { attFactor: -2, phaseOffset: 0.00, baseOpacity: 0.58, lineWidthMultiplier: 1.00 },
  { attFactor:  4, phaseOffset: 1.05, baseOpacity: 0.62, lineWidthMultiplier: 1.10 },
  { attFactor: -5, phaseOffset: 2.10, baseOpacity: 0.50, lineWidthMultiplier: 0.78 },
  { attFactor:  2, phaseOffset: 3.15, baseOpacity: 0.36, lineWidthMultiplier: 0.65 },
  { attFactor: -3, phaseOffset: 0.55, baseOpacity: 0.42, lineWidthMultiplier: 0.72 },
];

const GLOW_LAYERS = [
  { widthMultiplier: 8.00, opacityMultiplier: 0.035 },
  { widthMultiplier: 5.00, opacityMultiplier: 0.075 },
  { widthMultiplier: 3.00, opacityMultiplier: 0.140 },
  { widthMultiplier: 1.70, opacityMultiplier: 0.290 },
  { widthMultiplier: 0.90, opacityMultiplier: 0.680 },
  { widthMultiplier: 0.35, opacityMultiplier: 1.000 },
];

const STATE_TARGETS: Record<WaveState, { amplitude: number; speed: number }> = {
  idle:      { amplitude: 0.04, speed: 0.003 },
  listening: { amplitude: 0.38, speed: 0.014 },
  speaking:  { amplitude: 0.72, speed: 0.050 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Asymmetric envelope follower.
 *
 * Uses a fast attack rate when the incoming signal rises (so the wave
 * responds immediately to speech) and a slow release rate when it falls
 * (so brief inter-syllable silences don't collapse the wave).
 *
 * The floor prevents the envelope from ever reaching zero — the wave
 * stays alive as gentle motion even in complete silence.
 */
function envelopeFollow(
  current: number,
  incoming: number,
  attack: number,
  release: number,
  floor: number,
): number {
  const floored = Math.max(floor, incoming);
  const rate    = floored > current ? attack : release;
  return lerp(current, floored, rate);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VoiceWave({
  state          = "idle",
  amplitude: amplitudeProp,
  theme          = THEME_VELVET_PLUM,
  height         = 200,
  className,
  style,
  spread         = 1.4,
  frequency      = 5.5,
  haloRadius     = 4.5,
  haloIntensity  = 0.96,
  attackRate     = 0.25,
  releaseRate    = 0.04,
  amplitudeFloor = 0.08,
}: VoiceWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  const phaseRef     = useRef(0);
  const envelopeRef  = useRef(amplitudeFloor);
  const rawTargetRef = useRef(amplitudeFloor);
  const speedRef     = useRef(STATE_TARGETS.idle.speed);
  const targetSpdRef = useRef(STATE_TARGETS.idle.speed);
  const simTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const ampPropRef   = useRef<number | undefined>(amplitudeProp);

  const paramsRef = useRef({
    spread, frequency, haloRadius, haloIntensity,
    attackRate, releaseRate, amplitudeFloor, theme,
  });

  useEffect(() => {
    paramsRef.current = {
      spread, frequency, haloRadius, haloIntensity,
      attackRate, releaseRate, amplitudeFloor, theme,
    };
  }, [spread, frequency, haloRadius, haloIntensity, attackRate, releaseRate, amplitudeFloor, theme]);

  useEffect(() => { ampPropRef.current = amplitudeProp; }, [amplitudeProp]);

  // ── State → targets ────────────────────────────────────────────────────────
  useEffect(() => {
    if (simTimerRef.current) clearInterval(simTimerRef.current);

    targetSpdRef.current = STATE_TARGETS[state].speed;

    // If amplitude is externally driven, only speed comes from state
    if (ampPropRef.current !== undefined) return;

    if (state === "idle") {
      rawTargetRef.current = STATE_TARGETS.idle.amplitude;
    } else if (state === "listening") {
      let t = 0;
      simTimerRef.current = setInterval(() => {
        rawTargetRef.current = 0.22 + 0.28 * Math.abs(Math.sin(t++ * 0.15));
      }, 90);
    } else {
      let t = 0;
      simTimerRef.current = setInterval(() => {
        rawTargetRef.current = 0.50 + 0.44 * Math.abs(Math.sin(t++ * 0.08));
      }, 55);
    }

    return () => { if (simTimerRef.current) clearInterval(simTimerRef.current); };
  }, [state]);

  // ── Render loop ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (parent) {
      const w = parent.clientWidth, h = parent.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
    }

    const W = canvas.width, H = canvas.height;
    const {
      spread: sp, frequency: freq, haloRadius: hr, haloIntensity: hi,
      attackRate: atk, releaseRate: rel, amplitudeFloor: floor, theme: th,
    } = paramsRef.current;

    // Envelope follower — runs every frame regardless of source
    const incoming = ampPropRef.current !== undefined
      ? ampPropRef.current
      : rawTargetRef.current;
    envelopeRef.current = envelopeFollow(envelopeRef.current, incoming, atk, rel, floor);

    speedRef.current = lerp(speedRef.current, targetSpdRef.current, 0.038);
    phaseRef.current += speedRef.current;

    const amp   = envelopeRef.current;
    const phase = phaseRef.current;
    const cy    = H / 2;

    ctx.fillStyle = th.background;
    ctx.fillRect(0, 0, W, H);

    const allPts: [number, number][][] = WAVE_DEFS.map((def) => {
      const pts: [number, number][] = [];
      const steps = Math.ceil(W * 1.4);
      for (let i = 0; i <= steps; i++) {
        const x   = (i / steps) * W;
        const t   = (x / W) * 2 - 1;
        const att = def.attFactor * sp;
        const env = Math.exp(-(t * t * att * att) / 2);
        const y   = cy + env * amp * H * 0.41 *
          Math.sin(freq * t * Math.PI + phase + def.phaseOffset);
        pts.push([x, y]);
      }
      return pts;
    });

    const tracePath = (pts: [number, number][]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 2; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) * 0.5;
        const my = (pts[i][1] + pts[i + 1][1]) * 0.5;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };

    for (let wi = 0; wi < WAVE_DEFS.length; wi++) {
      const def  = WAVE_DEFS[wi];
      const pts  = allPts[wi];
      const wc   = th.waves[wi % th.waves.length];
      const nc   = th.waves[(wi + 1) % th.waves.length];
      const pb   = Math.min(1, amp * hi);
      const mr   = Math.round(lerp(wc.r, nc.r, pb));
      const mg   = Math.round(lerp(wc.g, nc.g, pb));
      const mb   = Math.round(lerp(wc.b, nc.b, pb));

      for (let li = 0; li < GLOW_LAYERS.length; li++) {
        const gl     = GLOW_LAYERS[li];
        const isCore = li >= GLOW_LAYERS.length - 2;
        const op     = def.baseOpacity * gl.opacityMultiplier;

        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0,    `rgba(${wc.r},${wc.g},${wc.b},0)`);
        grad.addColorStop(0.10, `rgba(${wc.r},${wc.g},${wc.b},${op * 0.5})`);
        grad.addColorStop(0.35, `rgba(${mr},${mg},${mb},${op})`);
        grad.addColorStop(0.50, `rgba(${mr},${mg},${mb},${op})`);
        grad.addColorStop(0.65, `rgba(${mr},${mg},${mb},${op})`);
        grad.addColorStop(0.90, `rgba(${wc.r},${wc.g},${wc.b},${op * 0.5})`);
        grad.addColorStop(1,    `rgba(${wc.r},${wc.g},${wc.b},0)`);

        ctx.save();
        ctx.globalCompositeOperation = isCore ? "source-over" : "lighter";
        tracePath(pts);
        ctx.strokeStyle = grad;
        ctx.lineWidth   = def.lineWidthMultiplier * gl.widthMultiplier * hr * 0.28 *
          (1 + amp * 0.55);
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();
      }
    }

    if (amp > 0.06) {
      WAVE_DEFS.forEach((def, wi) => {
        const wc     = th.waves[wi % th.waves.length];
        const peakY  = cy + amp * H * 0.41 * Math.sin(phase + def.phaseOffset);
        const radius = hr * 6 * amp;
        const hOp    = Math.min(0.52, hi * amp * def.baseOpacity);

        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const rg = ctx.createRadialGradient(W / 2, peakY, 0, W / 2, peakY, radius);
        rg.addColorStop(0,   `rgba(${wc.r},${wc.g},${wc.b},${hOp})`);
        rg.addColorStop(0.4, `rgba(${wc.r},${wc.g},${wc.b},${hOp * 0.35})`);
        rg.addColorStop(1,   `rgba(${wc.r},${wc.g},${wc.b},0)`);
        ctx.beginPath();
        ctx.arc(W / 2, peakY, radius, 0, Math.PI * 2);
        ctx.fillStyle = rg;
        ctx.fill();
        ctx.restore();
      });
    }

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (simTimerRef.current) clearInterval(simTimerRef.current);
    };
  }, [draw]);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height,
        borderRadius: 12,
        overflow: "hidden",
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
}

export default VoiceWave;
