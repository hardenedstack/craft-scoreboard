# Craft Scoreboard

Free Craft apps (PdfCraft, WordCraft, PhotoCraft, GridCraft, DeckCraft) tested version by version on a real lab PC, by [The Hardened Stack](https://www.youtube.com/channel/UCg95mVk6Es290vh_YB7RZUg).

Live page: https://hardenedstack.github.io/craft-scoreboard/

Each version gets two answers:

1. **Score**: the same jobs as the paid app, graded PASS 1 / PARTIAL 0.5 / FAIL 0 with rules written before the test.
2. **Connections**: which hosts the app's own processes contacted while you work and after you close it.

A result covers only the version and date shown.

## Files

- `scoreboard.json`: all results (schema 2). Each version has `connections` (counts per scenario) and `connections_detail` (one row per host: `host`, `scenario`, `process`, optional `requests`, `mb_up`, `kb_up`, `mb_down`, `note`).
- `template.html`, `style.css`, `app.js`: the page. No frameworks, no third-party requests, no cookies, no analytics.
- `build.py`: bakes the JSON and the plain-HTML tables into `index.html`. Run `python build.py` after every data change.

## Licence

- Code (HTML, CSS, JS, Python): MIT, see `LICENSE`.
- Data (`scoreboard.json`, `og.png`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "The Hardened Stack, Craft Scoreboard".
- Fonts: Geist and Geist Mono, SIL Open Font License 1.1, see `fonts/OFL.txt`.
