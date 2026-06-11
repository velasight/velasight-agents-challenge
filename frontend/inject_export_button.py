"""
Run this on Windows:
  python inject_export_button.py

It inserts an Export Report button into the Analysis tab of App.jsx.
"""

import sys

APP_PATH = r"C:\Users\theca\velasight-submission\velasight-explore\frontend\src\App.jsx"

OLD = """                </h1>
                <div style={{
                  fontSize: '15px', lineHeight: 1.8, marginTop: '24px',"""

NEW = """                </h1>
                <button onClick={() => {
                  const win = window.open('', '_blank');
                  const address = siteAnalysis?.SitusAddress || siteAnalysis?.address || 'Property Analysis';
                  const verdict = siteAnalysis?.verdict || 'PENDING';
                  const irr = typeof siteAnalysis?.estimated_irr === 'number'
                    ? siteAnalysis.estimated_irr.toFixed(1) + '%' : '--';
                  const composite = siteAnalysis?.composite_score
                    ?? siteAnalysis?.gentrification_score ?? '--';
                  const content = (lockedAnalysis || siteAnalysis?.summary || 'No analysis available.')
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const date = new Date().toLocaleDateString('en-US',
                    { year: 'numeric', month: 'long', day: 'numeric' });
                  const html = `<!DOCTYPE html><html><head><title>Velasight Report</title>
<style>
*{box-sizing:border-box}
body{font-family:Georgia,serif;max-width:820px;margin:48px auto;padding:0 32px;color:#1a1a1a;line-height:1.75}
.header{border-bottom:3px solid #F58A23;padding-bottom:16px;margin-bottom:24px}
.brand{font-size:11px;font-family:monospace;letter-spacing:.2em;color:#999;text-transform:uppercase;margin-bottom:8px}
h1{font-size:26px;font-weight:900;margin:0}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0;padding:20px;background:#f8f4f0;border-radius:6px;border-left:4px solid #F58A23}
.meta-item{display:flex;flex-direction:column;gap:4px}
.meta-label{font-size:9px;font-family:monospace;text-transform:uppercase;letter-spacing:.1em;color:#888}
.meta-value{font-size:15px;font-weight:700}
h2{font-size:11px;font-family:monospace;letter-spacing:.15em;color:#F58A23;text-transform:uppercase;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid #eee}
.body{font-size:14px;white-space:pre-wrap;color:#2a2a2a}
.footer{margin-top:48px;padding-top:16px;border-top:1px solid #ddd;font-size:10px;color:#aaa;font-family:monospace;display:flex;justify-content:space-between}
.btn{display:block;margin:32px auto 0;padding:12px 32px;background:#F58A23;color:white;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-family:monospace}
@media print{.btn{display:none}}
</style></head><body>
<div class="header"><div class="brand">Velasight Decision Intelligence</div><h1>Executive Underwriting Report</h1></div>
<div class="meta">
  <div class="meta-item"><span class="meta-label">Property</span><span class="meta-value">${address}</span></div>
  <div class="meta-item"><span class="meta-label">Verdict</span><span class="meta-value">${verdict}</span></div>
  <div class="meta-item"><span class="meta-label">Composite</span><span class="meta-value">${composite}/100</span></div>
  <div class="meta-item"><span class="meta-label">Est. IRR</span><span class="meta-value">${irr}</span></div>
</div>
<h2>Intelligence Synthesis</h2>
<div class="body">${content}</div>
<div class="footer"><span>Velasight Platform &bull; Confidential</span><span>${date}</span></div>
<button class="btn" onclick="window.print()">Print / Save as PDF</button>
</body></html>`;
                  win.document.write(html);
                  win.document.close();
                }} style={{
                  marginTop: '16px', padding: '8px 18px',
                  background: 'transparent',
                  border: `1px solid ${APP_THEMES[activeTheme].accent}`,
                  borderRadius: '4px',
                  color: APP_THEMES[activeTheme].accent,
                  fontFamily: 'var(--font-mono)', fontSize: '10px',
                  letterSpacing: '0.1em', cursor: 'pointer', textTransform: 'uppercase'
                }}>
                  &#8595; Export Report
                </button>
                <div style={{
                  fontSize: '15px', lineHeight: 1.8, marginTop: '24px',"""

try:
    with open(APP_PATH, 'r', encoding='utf-8') as f:
        content = f.read()

    if OLD not in content:
        print("ERROR: Target block not found. Check App.jsx manually.")
        sys.exit(1)

    updated = content.replace(OLD, NEW, 1)

    with open(APP_PATH, 'w', encoding='utf-8') as f:
        f.write(updated)

    print("SUCCESS: Export Report button injected into Analysis tab.")

except FileNotFoundError:
    print(f"ERROR: File not found at {APP_PATH}")
    sys.exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
