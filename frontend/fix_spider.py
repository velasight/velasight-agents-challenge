content = open("src/components/EruptionRadar.jsx", encoding="utf-8", errors="ignore").read()

old = """function SpiderChart({ kpis, color, theme, scenario }) {
  const size = 280, cx = size/2, cy = size/2, radius = 100, n = kpis.length;"""

new = """function SpiderChart({ kpis, color, theme, scenario }) {
  const size = 320, cx = size/2, cy = size/2, radius = 100, n = kpis.length;"""

old2 = '    const lx = cx + Math.cos(a) * (radius + 22);\n    const ly = cy + Math.sin(a) * (radius + 22);'
new2 = '    const lx = cx + Math.cos(a) * (radius + 28);\n    const ly = cy + Math.sin(a) * (radius + 28);'

old3 = '                 textAnchor="middle" dominantBaseline="middle" letterSpacing="1">{label}</text>;'
new3 = '                 textAnchor={Math.cos(a) < -0.3 ? "end" : Math.cos(a) > 0.3 ? "start" : "middle"} dominantBaseline="middle" letterSpacing="1">{label}</text>;'

old4 = '    <svg width={size} height={size} style={{ display: \'block\' }}>'
new4 = '    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: \'block\' }}>'

for o, n in [(old, new), (old2, new2), (old3, new3), (old4, new4)]:
    if o in content:
        content = content.replace(o, n)
        print(f"Fixed: {o[:40]}")
    else:
        print(f"Not found: {o[:40]}")

open("src/components/EruptionRadar.jsx", "w", encoding="utf-8").write(content)
