#!/usr/bin/env python3
"""Apply UC_MOMENTUM v1.1 changes to dashboard.html.
Every anchor is asserted: the script refuses to write a partial patch.
Usage: python3 migrations/patch_dashboard.py src/dashboard.html
"""
import re, sys, pathlib

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src/dashboard.html")
html = path.read_text()
orig = html
applied, missing = [], []

def sub(name, pattern, repl, count=1, regex=False):
    global html
    if regex:
        new, n = re.subn(pattern, repl, html, count=count, flags=re.S)
    else:
        n = html.count(pattern)
        new = html.replace(pattern, repl, count) if n else html
    if n:
        html = new; applied.append(name)
    else:
        missing.append(name)

# 1 — topbar: retire the Freeze gate chip, show regime liquidity instead
sub("topbar_freeze_chip",
    '<div>Freeze: <span class="val" id="tb-freeze">—</span></div>',
    '<div>Liquidity: <span class="val" id="tb-liq">—</span></div>')

sub("topbar_freeze_js",
    "document.getElementById('tb-freeze').textContent=m.freeze?'ON':'OFF';"
    "document.getElementById('tb-freeze').className='val '+(m.freeze?'neg':'pos');",
    "const L=D.liquidity||{};document.getElementById('tb-liq').textContent="
    "(L.pct!=null?L.pct+'% ('+L.target_low+'-'+L.target_high+'%)':'—');"
    "document.getElementById('tb-liq').className='val '+(L.status==='IN_RANGE'?'pos':'');")

# 2 — Brent is context only; it is no longer a deployment gate (v1.1 Sec 6)
sub("brent_gate_colour",
    "document.getElementById('tb-brent').className='val '+(m.brent>90?'neg':'pos');",
    "document.getElementById('tb-brent').className='val';")

# 3 — rank-only ROTATE signal replaced by review-only surface (Sec 13.1)
sub("rotation_title", "🔄 Rotation Signals", "🔄 Rotation & Time Reviews")
sub("rotation_render",
    r"const rot=D\.rotations\|\|\[\];.*?All holdings performing adequately\.</div>';",
    ("const rv=D.rotationReviews||[];document.getElementById('rotation-container').innerHTML="
     "rv.length?rv.map(r=>`<div class=\"rotation-row\"><strong>${r.symbol}</strong>"
     "<span class=\"tag\">${r.rotation_status||''}</span>"
     "${r.time_check?`<span class=\"tag\" style=\"background:var(--amber-bg);color:var(--amber)\">${r.time_check}</span>`:''}"
     "<span style=\"color:var(--text2)\">rank ${r.momentum_rank||'—'} · ${r.leader_state||''} · RS20 ${r.rs_20d!=null?r.rs_20d.toFixed(1):'—'}</span>"
     "<span style=\"margin-left:auto;font-size:11px;color:var(--text3)\">Review only — needs superior replacement + approval</span></div>`).join('')"
     ":'<div style=\"padding:12px;font-size:13px;color:var(--text3)\">No holdings meet review criteria.</div>';"),
    regex=True)

# 4 — holdings table: surface leader state and giveback
sub("holdings_header",
    '<th class="hm">Stage</th><th>GTT Gap</th>',
    '<th class="hm">Stage</th><th class="hm">Leader</th><th>GTT Gap</th>')
sub("holdings_row",
    '<td class="hm" style="font-size:11px;color:var(--text2)">${s.gtt_stage||\'\'}</td>',
    '<td class="hm" style="font-size:11px;color:var(--text2)">${s.gtt_stage||\'\'}</td>'
    '<td class="hm" style="font-size:11px">${s.leader_state||\'\'}'
    '${s.giveback_alert?\' <span style="color:var(--amber)">⚠ giveback</span>\':\'\'}</td>')

# 5 — regime rationale under the hero
sub("hero_regime_note",
    r'<div class="hero-sub">Baseline .*?</div>',
    '<div class="hero-sub">Baseline ${fmt(D.baseline)}${D.startDate?\' · Since \'+D.startDate:\'\'}</div>'
    '<div class="hero-sub" style="font-size:12px;color:var(--text3)">${(D.macro&&D.macro.rationale)||\'\'}</div>',
    regex=True)

if missing:
    print("ABORT — anchors not found:"); [print("  -", m) for m in missing]
    sys.exit(1)

path.write_text(html)
print(f"dashboard.html patched: {len(applied)} anchors, {len(orig)} -> {len(html)} bytes")
for a in applied: print("  +", a)
