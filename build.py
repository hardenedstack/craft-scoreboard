"""Builds index.html from template.html + scoreboard.json. Run it after every data change.

    python build.py            -> index.html (the published page)
    python build.py --preview  -> _preview/preview.html (one self-contained file, no CSP tag)
"""
import base64
import hashlib
import html
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
D = json.loads((HERE / "scoreboard.json").read_text(encoding="utf-8"))
E = html.escape
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def human(iso):
    if not iso:
        return None
    y, m, d = iso.split("-")
    return f"{int(d)} {MONTHS[int(m) - 1]} {y}"


def conn_text(v, sc):
    if v["status"] != "measured":
        return "coming" if v["status"] == "coming" else "not tested"
    c = (v.get("connections") or {}).get(sc)
    if not c:
        return "not measured"
    return "0" if c["count"] == 0 else f"{c['count']} hosts"


def results_rows():
    rows = []
    apps = [a for a in D["apps"] if a["kind"] == "craft"] + [a for a in D["apps"] if a["kind"] == "paid"]
    for a in apps:
        for v in a["versions"]:
            if v.get("score") is not None:
                score = f"{v['score']:g}/{v['of']}"
            else:
                score = "coming" if v["status"] == "coming" else ("retest" if v["status"] == "measured" else "not tested")
            vid = v.get("video")
            vid_html = f'<a href="https://www.youtube.com/watch?v={E(vid["id"])}" rel="noopener">Watch</a>' if vid else "–"
            name = f'<a href="#{E(a["id"])}">{E(a["name"])}</a>' if a["kind"] == "craft" else E(a["name"])
            rows.append(
                f'<tr><td>{name}</td><td class="num">{E(v.get("version") or "–")}</td>'
                f'<td class="num">{E(human(v.get("date")) or "coming")}</td><td>{E(v.get("platform") or "–")}</td>'
                f'<td class="num">{E(score)}</td><td class="num">{E(conn_text(v, "working"))}</td>'
                f'<td class="num">{E(conn_text(v, "closed"))}</td><td>{vid_html}</td></tr>'
            )
    return "\n".join(rows)


def means_line():
    """One plain 'what this means for you' sentence, built only from measured results."""
    paid = []
    for a in D["apps"]:
        if a["kind"] != "paid":
            continue
        v = next((x for x in reversed(a["versions"]) if x["status"] == "measured" and x.get("means")), None)
        if v:
            paid.append(f'{E(a["name"])} {E(v["means"])}')
    quiet = [a["name"] for a in D["apps"] if a["kind"] == "craft" and any(
        v["status"] == "measured" and ((v.get("connections") or {}).get("working") or {}).get("count") == 0 for v in a["versions"])]
    parts = [p[0].upper() + p[1:] + "." for p in paid]
    if quiet:
        parts.append(f"The {len(quiet)} Craft apps we tested made 0 connections while working.")
    return " ".join(parts)


def conn_rows():
    rows = []
    for a in D["apps"]:
        for v in a["versions"]:
            for c in v.get("connections_detail") or []:
                parts = [
                    f"{c['requests']} requests" if c.get("requests") else "",
                    f"{c['mb_up']:g} MB sent" if c.get("mb_up") else "",
                    f"{c['kb_up']:g} KB sent" if c.get("kb_up") else "",
                    f"{c['mb_down']:g} MB received" if c.get("mb_down") else "",
                ]
                data = " · ".join(p for p in parts if p) or "–"
                rows.append(
                    f'<tr><td>{E(a.get("short") or a["name"])} <span class="num">{E(v["version"] or "")}</span>'
                    f'<br><span class="num">{E(human(v["date"]))}</span></td>'
                    f'<td>{E(D["scenarios"][c["scenario"]])}</td><td>{E(c.get("process", ""))}</td>'
                    f'<td class="host">{E(c["host"])}</td><td class="num">{E(data)}</td><td>{E(c.get("note", ""))}</td></tr>'
                )
    return "\n".join(rows), len(rows)


# Runs before first paint: theme choice, and the full-frame "stage" view used for recordings and og.png.
THEME_JS = (
    "(function(){var d=document.documentElement;d.classList.remove('nojs');"
    "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}"
    "var q=location.search;if(/[?&](stage|og)\\b/.test(q)||location.hash==='#stage')d.classList.add('stage');"
    "if(/[?&]og\\b/.test(q))d.classList.add('og');"
    "var m=/[?&]theme=(light|dark)\\b/.exec(q);if(m)d.setAttribute('data-theme',m[1])})();"
)

DESC = ("Free Craft apps (PdfCraft, WordCraft, PhotoCraft, GridCraft, DeckCraft) tested version by version "
        "on a real lab PC: a score against the paid app, and every network connection measured.")


def meta_tags(s):
    return f"""<title>Craft Scoreboard</title>
<meta name="description" content="{E(DESC)}">
<meta name="theme-color" content="#0a0f1f">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Hardened Stack">
<meta property="og:title" content="Craft Scoreboard: free Craft apps, measured on a real PC">
<meta property="og:description" content="{E(DESC)}">
<meta property="og:url" content="{E(s['url'])}">
<meta property="og:image" content="{E(s['url'])}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Lab network map: Craft apps at 0 connections, Acrobat and Word for the web contacting dozens of hosts">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Craft Scoreboard">
<meta name="twitter:description" content="{E(DESC)}">
<meta name="twitter:image" content="{E(s['url'])}og.png">
"""


def write_feed(s):
    """Atom feed: one entry per measured result, newest first."""
    entries = []
    for a in D["apps"]:
        for v in a["versions"]:
            if v["status"] != "measured":
                continue
            score = f"{v['score']:g}/{v['of']}" if v.get("score") is not None else "no score"
            title = f"{a['name']} {v['version']}: {score}, while you work: {conn_text(v, 'working')}"
            anchor = a["id"] if a["kind"] == "craft" else "results"
            entries.append((v["date"], f"""  <entry>
    <title>{E(title)}</title>
    <id>tag:hardenedstack.github.io,2026:craft-scoreboard/{E(a['id'])}/{E(v['version'])}</id>
    <link href="{E(s['url'])}#{E(anchor)}"/>
    <updated>{v['date']}T13:00:00Z</updated>
    <summary>{E(v.get('summary', ''))} Measured {E(human(v['date']))} on our {E(v.get('platform') or 'lab PC')}.</summary>
  </entry>"""))
    entries.sort(key=lambda e: e[0], reverse=True)
    body = "\n".join(e[1] for e in entries)
    feed = f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Craft Scoreboard: new lab results</title>
  <subtitle>Free Craft apps tested version by version on a real lab PC.</subtitle>
  <link href="{E(s['url'])}"/>
  <link rel="self" href="{E(s['url'])}feed.xml"/>
  <id>{E(s['url'])}</id>
  <updated>{D['updated']}T13:00:00Z</updated>
  <author><name>The Hardened Stack</name></author>
{body}
</feed>
"""
    (HERE / "feed.xml").write_text(feed, encoding="utf-8")


def build(preview=False):
    s = D["site"]
    crows, ccount = conn_rows()
    body = (HERE / "template.html").read_text(encoding="utf-8")
    for k, v in {
        "{{UPDATED}}": D["updated"], "{{UPDATED_HUMAN}}": human(D["updated"]), "{{RESULTS_ROWS}}": results_rows(),
        "{{CONN_ROWS}}": crows, "{{CONN_COUNT}}": str(ccount), "{{CHANNEL_URL}}": E(s["channel_url"]),
        "{{RULE}}": E(D["scoring"]["rule"]), "{{SCOPE}}": E(D["scoring"]["scope"]),
        "{{CONN_RULE}}": E(D["scoring"]["connections"]), "{{MEANS}}": means_line(),
    }.items():
        body = body.replace(k, v)
    if preview:
        # the preview is one self-contained file, so lab images travel inside the data
        for a in D["apps"]:
            for v in a["versions"]:
                p = v.get("proof")
                for k in ("before", "after"):
                    if p and not p[k].startswith("data:"):
                        p[k] = "data:image/webp;base64," + base64.b64encode((HERE / p[k]).read_bytes()).decode()
    else:
        write_feed(s)
    data = json.dumps(D, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    app_js = (HERE / "app.js").read_text(encoding="utf-8")
    css = (HERE / "style.css").read_text(encoding="utf-8")

    if preview:
        for f in ("geist", "geist-mono"):
            b64 = base64.b64encode((HERE / "fonts" / f"{f}.woff2").read_bytes()).decode()
            css = css.replace(f'url("fonts/{f}.woff2")', f'url("data:font/woff2;base64,{b64}")')
        out = (f'{meta_tags(s)}\n<script>{THEME_JS}</script>\n'
               f'<style>\n{css}\n</style>\n{body}\n<script type="application/json" id="data">{data}</script>\n'
               f'<script>\n{app_js}\n</script>\n')
        p = HERE / "_preview" / "preview.html"
        p.parent.mkdir(exist_ok=True)
        p.write_text(out, encoding="utf-8")
        return p

    h = base64.b64encode(hashlib.sha256(THEME_JS.encode()).digest()).decode()
    csp = ("default-src 'none'; script-src 'self' 'sha256-" + h + "'; style-src 'self'; font-src 'self'; "
           "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'")
    out = f"""<!doctype html>
<html lang="en" class="nojs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="referrer" content="no-referrer">
{meta_tags(s)}<link rel="canonical" href="{E(s['url'])}">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/atom+xml" title="Craft Scoreboard: new lab results" href="feed.xml">
<link rel="preload" href="fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="fonts/geist-mono.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="style.css">
<script>{THEME_JS}</script>
<script type="application/json" id="data">{data}</script>
<script src="app.js" defer></script>
</head>
<body>
{body}
</body>
</html>
"""
    p = HERE / "index.html"
    p.write_text(out, encoding="utf-8")
    return p


if __name__ == "__main__":
    print(build("--preview" in sys.argv))
