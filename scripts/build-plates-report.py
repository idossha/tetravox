#!/usr/bin/env python3
"""Assemble the Tetravox visualization-plates report (HTML artifact) from the captured catalogue.

Reads  docs/reports/2026-08-28-visualization-scenarios/scenarios.json  + PNGs, embeds images as data URIs,
and writes a self-contained HTML page (no external assets except Google Fonts).
"""
import base64, html, json, os, sys
from pathlib import Path

REPO = Path('/Users/idohaber/00_development/tetravox')
SRC = REPO / 'docs/reports/2026-08-28-visualization-scenarios'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC / 'tetravox-plates.html'
CONTROLS = json.loads((SRC / 'controls.json').read_text()) if (SRC / 'controls.json').exists() else None

def img_uri(p: Path) -> str:
    return 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()

scen = json.loads((SRC / 'scenarios.json').read_text())
if isinstance(scen, dict) and 'scenarios' in scen:
    scen = scen['scenarios']

def esc(s): return html.escape(str(s))
def kbd(s):
    """Render `⌘`+wheel style tokens as <kbd> chips."""
    return esc(s)

def li(items):
    if not items: return ''
    if isinstance(items, str): items = [items]
    return '<ul>' + ''.join(f'<li>{esc(i)}</li>' for i in items) + '</ul>'

def layers_html(layers):
    if not layers: return '<p class="muted">—</p>'
    if isinstance(layers, str): return f'<p>{esc(layers)}</p>'
    rows = []
    for l in layers:
        if isinstance(l, dict):
            kind = l.get('kind', '')
            name = l.get('name') or l.get('dataset') or ''
            settings = l.get('settings') or {k: v for k, v in l.items() if k not in ('kind', 'name', 'dataset')}
            st = ', '.join(f'{k}: {v}' for k, v in settings.items()) if isinstance(settings, dict) else esc(settings)
            rows.append(f'<li><span class="chip chip-{esc(kind)}">{esc(kind)}</span> <code>{esc(name)}</code> <span class="muted">{esc(st)}</span></li>')
        else:
            rows.append(f'<li>{esc(l)}</li>')
    return '<ul class="layers">' + ''.join(rows) + '</ul>'

plates = []
for n, s in enumerate(scen, 1):
    f = SRC / s['file']
    if not f.exists():
        print('missing', f, file=sys.stderr); continue
    closeups = s.get('closeup') or s.get('closeups') or []
    if isinstance(closeups, str): closeups = [closeups]
    closeups = [SRC / c for c in closeups if (SRC / c).exists()]
    figs = f'<figure class="plate-main"><img src="{img_uri(f)}" alt="{esc(s["title"])}" loading="lazy"></figure>'
    if closeups:
        figs += '<div class="closeups">' + ''.join(
            f'<figure><img src="{img_uri(c)}" alt="{esc(s["title"])} — close-up" loading="lazy"><figcaption>{esc(c.stem.split("-",1)[-1].replace("-"," "))}</figcaption></figure>'
            for c in closeups) + '</div>'
    data_files = s.get('data_files') or []
    if isinstance(data_files, str): data_files = [data_files]
    notes = s.get('notes') or s.get('limitations') or ''
    plates.append(f'''
<section class="plate" id="plate-{n}">
  <header class="plate-head">
    <span class="plate-no">Plate {n}</span>
    <h2>{esc(s['title'])}</h2>
  </header>
  {figs}
  <div class="plate-body">
    <div class="col">
      <h3>What you see</h3>
      <p>{esc(s.get('what_it_shows',''))}</p>
      <h3>Layers</h3>
      {layers_html(s.get('layers'))}
    </div>
    <div class="col">
      <h3>How to get here</h3>
      {li(s.get('controls_used'))}
      <h3>Data</h3>
      <ul class="files">{''.join(f'<li><code>{esc(d)}</code></li>' for d in data_files)}</ul>
      {f'<h3>Notes</h3><p class="note">{esc(notes)}</p>' if notes else ''}
    </div>
  </div>
</section>''')

index = ''.join(f'<li><a href="#plate-{n}"><span class="no">{n}</span>{esc(s["title"])}</a></li>' for n, s in enumerate(scen, 1) if (SRC / s['file']).exists())

INTRO = (SRC / 'intro.html').read_text() if (SRC / 'intro.html').exists() else ''
CAPMAP = (SRC / 'capability-map.html').read_text() if (SRC / 'capability-map.html').exists() else ''
CONTROLS_HTML = (SRC / 'controls.html').read_text() if (SRC / 'controls.html').exists() else ''
NOTYET = (SRC / 'not-yet.html').read_text() if (SRC / 'not-yet.html').exists() else ''

page = f'''<title>Tetravox Plates</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {{
  --ground:#F3F5F8; --surface:#FFFFFF; --surface-2:#E9EDF3; --line:#D6DDE7; --text:#121820; --muted:#5A6677;
  --accent:#0E86A8; --accent-ink:#FFFFFF; --kbd:#EEF2F7; --kbd-line:#C9D2DE;
  --wm:#E6E6E6; --gm:#818181; --csf:#68A3FF; --bone:#FFEFB3; --scalp:#FFA685; --blood:#00418E;
  --display:"Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  --body:"Source Serif 4", Georgia, "Times New Roman", serif;
  --mono:"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --ground:#0b0b0f; --surface:#14141b; --surface-2:#1b1b25; --line:#262633; --text:#d8d8e4; --muted:#82829a;
  --accent:#6ee7ff; --accent-ink:#0b0b0f; --kbd:#1b1b25; --kbd-line:#34344a;
}} }}
:root[data-theme="dark"] {{
  --ground:#0b0b0f; --surface:#14141b; --surface-2:#1b1b25; --line:#262633; --text:#d8d8e4; --muted:#82829a;
  --accent:#6ee7ff; --accent-ink:#0b0b0f; --kbd:#1b1b25; --kbd-line:#34344a;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--ground); color:var(--text); font-family:var(--body); font-size:17px; line-height:1.55; }}
a {{ color:var(--accent); text-decoration:none; }} a:hover {{ text-decoration:underline; }}
a:focus-visible, button:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; }}
code {{ font-family:var(--mono); font-size:.84em; background:var(--surface-2); padding:.05em .35em; border-radius:3px; }}
kbd {{ font-family:var(--mono); font-size:.8em; background:var(--kbd); border:1px solid var(--kbd-line); border-bottom-width:2px; border-radius:4px; padding:.05em .4em; }}
h1,h2,h3 {{ font-family:var(--display); text-wrap:balance; margin:0; }}
.muted {{ color:var(--muted); }}
.wrap {{ display:grid; grid-template-columns: 240px minmax(0,1fr); gap:48px; max-width:1360px; margin:0 auto; padding:40px 32px 96px; }}
@media (max-width: 900px) {{ .wrap {{ grid-template-columns: 1fr; gap:24px; padding:24px 16px 64px; }} .rail {{ position:static; }} }}
.rail {{ position:sticky; top:24px; align-self:start; font-family:var(--display); }}
.rail .brand {{ font-weight:700; font-size:22px; letter-spacing:-.01em; }}
.rail .sub {{ font-size:13px; color:var(--muted); margin:2px 0 18px; text-transform:uppercase; letter-spacing:.08em; }}
.rail ol {{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }}
.rail a {{ display:flex; gap:10px; padding:5px 8px; border-radius:6px; color:var(--text); font-size:14px; line-height:1.3; }}
.rail a:hover {{ background:var(--surface-2); text-decoration:none; }}
.rail .no {{ font-family:var(--mono); color:var(--muted); font-size:12px; min-width:1.6em; padding-top:2px; }}
.rail .extra {{ margin-top:16px; padding-top:12px; border-top:1px solid var(--line); }}
main {{ min-width:0; }}
.hero {{ display:grid; grid-template-columns: minmax(0,1fr); gap:14px; padding-bottom:28px; border-bottom:1px solid var(--line); margin-bottom:36px; }}
.hero .eyebrow {{ font-family:var(--display); font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }}
.hero h1 {{ font-size:44px; line-height:1.05; letter-spacing:-.02em; font-weight:700; }}
.hero p {{ max-width:68ch; margin:0; font-size:19px; }}
.tissue {{ display:flex; gap:6px; margin-top:8px; }}
.tissue span {{ width:28px; height:10px; border-radius:2px; display:inline-block; }}
.section {{ margin:0 0 44px; }}
.section > h2 {{ font-size:26px; letter-spacing:-.01em; margin-bottom:12px; }}
.section p {{ max-width:70ch; }}
table {{ border-collapse:collapse; width:100%; font-size:15px; }}
.tablewrap {{ overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--surface); }}
th, td {{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ font-family:var(--display); font-weight:600; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); background:var(--surface-2); }}
tr:last-child td {{ border-bottom:0; }}
.yes {{ color:var(--accent); font-weight:600; }} .part {{ color:var(--muted); }}
.plate {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:22px 22px 26px; margin:0 0 30px; }}
.plate-head {{ display:flex; align-items:baseline; gap:14px; margin-bottom:14px; }}
.plate-no {{ font-family:var(--mono); font-size:12px; color:var(--accent); letter-spacing:.08em; text-transform:uppercase; }}
.plate h2 {{ font-size:22px; letter-spacing:-.01em; font-weight:600; }}
figure {{ margin:0; }}
.plate-main img, .closeups img {{ display:block; width:100%; height:auto; border-radius:6px; border:1px solid var(--line); background:#000; }}
.closeups {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(280px,1fr)); gap:12px; margin-top:12px; }}
.closeups figcaption {{ font-family:var(--display); font-size:13px; color:var(--muted); margin-top:6px; }}
.plate-body {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr)); gap:8px 32px; margin-top:18px; }}
.plate-body h3 {{ font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:14px 0 6px; font-weight:600; }}
.plate-body p, .plate-body ul {{ margin:0; font-size:16px; }}
.plate-body ul {{ padding-left:1.1em; }} .plate-body li {{ margin:3px 0; }}
.layers, .files {{ list-style:none; padding-left:0 !important; }}
.chip {{ font-family:var(--display); font-size:11px; letter-spacing:.06em; text-transform:uppercase; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }}
.chip-volume {{ border-color:var(--accent); color:var(--accent); }} .chip-mesh {{ border-color:var(--scalp); color:var(--scalp); }}
.chip-iso, .chip-points, .chip-surface {{ border-color:var(--bone); color:var(--muted); }}
.note {{ color:var(--muted); }}
.cols {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(280px,1fr)); gap:16px 32px; }}
dl {{ margin:0; }} dt {{ font-family:var(--display); font-weight:600; margin-top:10px; }} dd {{ margin:2px 0 0; }}
@media (prefers-reduced-motion: no-preference) {{ .rail a {{ transition: background .15s; }} }}
</style>
<div class="wrap">
  <nav class="rail" aria-label="Plates">
    <div class="brand">Tetravox</div>
    <div class="sub">Visualization plates</div>
    <ol>{index}</ol>
    <div class="extra"><a href="#capabilities">Capability map</a><br><a href="#controls">Controls</a><br><a href="#not-yet">Not yet available</a></div>
  </nav>
  <main>
    <header class="hero">
      <div class="eyebrow">Phase 2 · build <code>phase-2</code> · sub-ernie data · 2026-08-28</div>
      <h1>What a user can see and do with volumes and meshes</h1>
      <p>Every plate below is a real capture of the shipped app, driven the way a user would drive it, on the ernie head model. Each one names the layers involved, the controls that produce it, and what it can't do yet.</p>
      <div class="tissue" title="SimNIBS tissue palette used throughout: WM, GM, CSF, bone, scalp, blood"><span style="background:var(--wm)"></span><span style="background:var(--gm)"></span><span style="background:var(--csf)"></span><span style="background:var(--bone)"></span><span style="background:var(--scalp)"></span><span style="background:var(--blood)"></span></div>
    </header>
    {INTRO}
    <section class="section" id="capabilities">{CAPMAP}</section>
    {''.join(plates)}
    <section class="section" id="controls">{CONTROLS_HTML}</section>
    <section class="section" id="not-yet">{NOTYET}</section>
  </main>
</div>
'''
OUT.write_text(page)
print(OUT, f'{OUT.stat().st_size/1e6:.1f} MB', len(plates), 'plates')
