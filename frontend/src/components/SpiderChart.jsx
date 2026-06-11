import { useRef, useEffect, useCallback } from 'react'
import { useExploreStore, KPI_DEFS, visibleKpis } from '../store'

const RING_COLORS = ['#14B8A6', '#38BDF8', '#F59E0B', '#F87171']
const RING_SCALES = [0.35, 0.55, 0.75, 1.0]

export default function SpiderChart({ size = 320 }) {
  const canvasRef = useRef(null)
  const animFrameRef = useRef(null)
  const prevValuesRef = useRef(null)
  const { kpiValues, programType } = useExploreStore()

  // visibleKpis(programType) returns the program-applicable, non-locked
  // KPIs (20 for multifamily/mob, 8 for data_center). Their positions in
  // the kpiValues array are NOT necessarily contiguous — DC mode pulls
  // from indices [12,13,14,15,28,29,30,31] — so we resolve each to its
  // canonical KPI_DEFS index and read kpiValues at that index.
  const activeKpis = visibleKpis(programType)
  const activeIndices = activeKpis.map(k => KPI_DEFS.indexOf(k))
  const N = activeKpis.length

  const getAngle = useCallback((i) => {
    return (2 * Math.PI * i) / N - Math.PI / 2
  }, [N])

  const draw = useCallback((values) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const W = size * dpr
    const H = size * dpr
    canvas.width = W
    canvas.height = H
    ctx.scale(dpr, dpr)

    const cx = size / 2
    const cy = size / 2
    const maxR = size * 0.28

    ctx.clearRect(0, 0, size, size)

    // ── Background rings ──────────────────────────────
    RING_SCALES.forEach((scale, ri) => {
      const r = maxR * scale
      ctx.beginPath()
      for (let i = 0; i < N; i++) {
        const a = getAngle(i)
        const x = cx + r * Math.cos(a)
        const y = cy + r * Math.sin(a)
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.strokeStyle = RING_COLORS[ri] + '40'
      ctx.lineWidth = 0.75
      ctx.stroke()
      ctx.fillStyle = RING_COLORS[ri] + '08'
      ctx.fill()
    })

    // ── Axis lines ────────────────────────────────────
    for (let i = 0; i < N; i++) {
      const a = getAngle(i)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + maxR * Math.cos(a), cy + maxR * Math.sin(a))
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }

    // ── Data polygons ─────────────────────────────────
    RING_SCALES.forEach((scale, ri) => {
      ctx.beginPath()
      for (let i = 0; i < N; i++) {
        const a = getAngle(i)
        const val = Math.max(0.05, Math.min(1, values[i] || 0))
        const v = val * scale
        const r = v * maxR
        const x = cx + r * Math.cos(a)
        const y = cy + r * Math.sin(a)
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fillStyle = RING_COLORS[ri] + (ri === 3 ? '22' : '14')
      ctx.fill()
      ctx.strokeStyle = RING_COLORS[ri]
      ctx.lineWidth = ri === 3 ? 1.5 : 0.7
      ctx.stroke()
    })

    // ── Axis labels ───────────────────────────────────
    ctx.font = `600 7px 'JetBrains Mono', monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (let i = 0; i < N; i++) {
      const a = getAngle(i)
      const staggerOffset = i % 2 === 0 ? 0 : 15
      const lx = cx + (maxR + 15 + staggerOffset) * Math.cos(a)
      const ly = cy + (maxR + 15 + staggerOffset) * Math.sin(a)
      const words = activeKpis[i].label.split(' ')

      ctx.fillStyle = activeKpis[i].color || 'rgba(240, 244, 255, 0.55)'

      if (words.length === 1) {
        ctx.fillText(words[0].toUpperCase(), lx, ly)
      } else if (words.length === 2) {
        ctx.fillText(words[0].toUpperCase(), lx, ly - 4.5)
        ctx.fillText(words[1].toUpperCase(), lx, ly + 4.5)
      } else {
        ctx.fillText(words[0].toUpperCase(), lx, ly - 6)
        ctx.fillText(words.slice(1).join(' ').toUpperCase(), lx, ly + 4)
      }
    }

    // ── Center dot ────────────────────────────────────
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI)
    ctx.fillStyle = '#F0F4FF'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [size, N, getAngle, activeKpis])

  useEffect(() => {
    // ARMOR: Guarantee kpiValues is a valid array before indexing
    const safeArray = Array.isArray(kpiValues) ? kpiValues : new Array(32).fill(0.05);

    // Read each visible KPI's value from its canonical KPI_DEFS index in
    // kpiValues (not slice(0, N) — that only worked when the active set
    // was the first N entries of KPI_DEFS, which is no longer true in DC
    // mode).
    const activeValues = activeIndices.map(i => safeArray[i] ?? 0)

    const from = prevValuesRef.current || activeValues
    // If the active set size changed (program switch), reset the
    // animation origin to the new values so we don't morph between
    // mismatched-length arrays.
    const fromAligned = from.length === activeValues.length ? from : activeValues
    const to = activeValues
    prevValuesRef.current = to

    let start = null
    const duration = 400

    const animate = (ts) => {
      if (!start) start = ts
      const progress = Math.min((ts - start) / duration, 1)
      const ease = 1 - Math.pow(1 - progress, 3)
      const current = fromAligned.map((f, i) => f + ((to[i] || 0) - f) * ease)

      draw(current)

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(animate)
      }
    }

    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = requestAnimationFrame(animate)

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [kpiValues, draw, N, activeIndices])

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block' }}
      />
    </div>
  )
}