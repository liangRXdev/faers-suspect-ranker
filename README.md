# FAERS ADR Ranker (teaching edition)

**English** | [繁體中文](README.zh-TW.md)

> **Suspect-drug ranking** for polypharmacy via reverse lookup of FAERS open data:
> reverse query (symptom → drug) + ROR/PRR disproportionality analysis + local temporal weighting,
> with Naranjo / WHO-UMC causality scoring for any single drug.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Click%20Here-blue?style=for-the-badge)](https://liangrxdev.github.io/faers-suspect-ranker/)

> ## ⚠️ For teaching / practice only
> This tool **is not a medical device, not a diagnostic tool, and must not be used for any clinical decision**.
> Signal detection ≠ causality. **Read** [DISCLAIMER.md](./DISCLAIMER.md) before use.

---

## What is this

In polypharmacy, when a patient develops an adverse reaction, the pharmacist has to work out "which drug is the most likely culprit" one by one.
A traditional "drug → symptom" lookup can't answer that directly. This tool uses a **symptom → drug** reverse query instead,
computing disproportionality and temporal plausibility for every drug on the patient's list and outputting a ranking of suspect drugs.

Technically it relies on a single OpenFDA endpoint (`/drug/event.json`). Two deployments are provided:
a **GitHub Pages pure-frontend version** (queried directly from the browser, zero backend) or a **Google Apps Script (GAS) version**.

### Clinical motivation: first ask "is this a prescribing cascade?"

ADRs in older and polypharmacy patients often present as **age-like symptoms** such as falls, confusion, edema or constipation,
and are easily taken for a new disease and treated with yet another drug — a **prescribing cascade**.
When a new symptom appears, Rochon & Gurwitz (*Lancet* 2017) suggest asking three things first:

1. Is this new symptom **an adverse reaction to an earlier drug**? (rather than rushing to add a drug)
2. Is the triggering "index drug" **really still needed**? Can it be switched to a safer alternative or reduced?
3. What are the **benefits and harms** of continuing the index drug? Share the decision with the patient.

This tool operationalizes question 1: using a **symptom → drug** reverse query, it looks at both
"population disproportionality signals" and "individual temporal plausibility" for every drug on the list, helping move suspicious index drugs to the top —
**as a starting point for discussion, not a causal conclusion**.

## Features

- **Reverse query**: conditioned on the symptom (MedDRA PT), builds a 2×2 contingency table for each drug
- **Disproportionality**: ROR (with 95% CI), PRR, Yates χ², Haldane-Anscombe zero-cell correction
- **Signal criteria**: a≥3 and (ROR lower bound > 1) or (PRR≥2 and χ²≥4)
- **Temporal weighting**: banded by latency; onset after stopping the drug (dechallenge) gets an additional decay factor
- **Draggable timeline**: Gantt-style visualization of each drug's exposure period vs symptom onset date
- **Individual causality scoring**: Naranjo + WHO-UMC (all symptoms) + **ALDEN** (SJS/TEN only, with cross-drug competition), smart-prefilled from the timeline data
- **Symptom input**: a few example PTs + **live OpenFDA suggestions** (no full MedDRA list embedded)

## Architecture

```
┌─ Index.html ──────────────┐      ┌─ Code.gs (GAS) ───────────────┐
│ Frontend (vanilla JS+BS5) │  ←→  │ analyzeADR() main entry        │
│ · PT search / suggestions │      │ · _stats()  ROR/PRR/χ²         │
│ · Draggable timeline      │      │ · _temporal() timing+dechallenge│
│ · Naranjo/WHO-UMC panel   │      │ · CacheService cache + throttle│
└───────────────────────────┘      │ · PropertiesService API key    │
                                    └────────────────────────────────┘
                                                  │ single endpoint
                                                  ▼
                                    api.fda.gov/drug/event.json
```

> The pure-frontend version is an equivalent mirror: `docs/app.js` replaces `Code.gs` (using `fetch` + in-memory cache + `localStorage`
> instead of `UrlFetchApp` + `CacheService` + `PropertiesService`), and `docs/index.html` is the UI.

## Deployment (choose one)

Both modes share the same statistical and temporal logic; they differ only in "who sends the query" and "where the API key lives":

| | GitHub Pages (pure frontend) | Google Apps Script (GAS) |
|---|---|---|
| Backend | None; the browser calls OpenFDA directly | GAS Web App |
| Code | `docs/index.html` + `docs/app.js` | `Code.gs` + `Index.html` |
| API key | Browser `localStorage` (local, user-provided) | `PropertiesService` (server side) |
| Best for | Teaching demos, quick trials, zero maintenance | Institutional deployment, central key management |

> ⚠ There is no bundler, so the statistical math exists in both places. **If you change a formula or threshold on one side, change the other too**
> (`Code.gs` ↔ `docs/app.js`) and update `docs/methodology.md`.

### A. GitHub Pages static deployment

1. Fork / clone this repo.
2. Settings → Pages → Source: **Deploy from a branch**, branch = `main`, folder = **`/docs`**, save.
3. After a few minutes visit `https://<your-account>.github.io/<repo>/`.
4. (Optional) Paste a free [OpenFDA key](https://open.fda.gov/apis/authentication/) into the "API Key settings" in the UI;
   it is stored only in your browser's localStorage and never uploaded to any third party.

> Local preview: `cd docs && python -m http.server`, then open `http://localhost:8000`
> (must be served over HTTP rather than `file://`, or `fetch` is blocked by CORS).

### B. Deployment (Google Apps Script)

1. Create a new GAS project and add two files:
   - `Code.gs` (paste this repo's `Code.gs`)
   - `Index.html` (the file name must be **`Index`**, matching `createTemplateFromFile('Index')`)
2. (Optional but recommended) Get a free [OpenFDA API key](https://open.fda.gov/apis/authentication/)
   and save it in the tool's "API Key settings", or add `OPENFDA_API_KEY` under "Project Settings → Script Properties".
   Without a key the rate limit is 40 req/min; with a key, 240 req/min.
3. "Deploy → New deployment → Web app".
4. **After every code change, redeploy as a "New version"** (saving alone doesn't update the live version).

## Usage

1. Enter the observed adverse reaction (English MedDRA PT; live suggestions help) and its onset date.
2. Enter the patient's drugs one by one (drug name, start date, stop date / still taking).
3. Run the analysis → get the suspect-drug ranking.
4. Click "Score" on any drug → perform a Naranjo / WHO-UMC causality assessment.
5. If the symptom is SJS/TEN, the results area shows "Start ALDEN assessment" → multi-drug ALDEN scoring with cross-drug competition adjustment.

## MedDRA Licensing Note

This repo **deliberately does not embed the full MedDRA PT list** (`PT_DB` in `Index.html` has examples only),
because MedDRA terminology is licensed by the MSSO. You have two options:

- **Rely entirely on live OpenFDA suggestions** (the FAERS reaction vocabulary itself is public), no local list needed; or
- After obtaining a MedDRA license, extend the `PT_DB` array yourself (preferably on a non-public branch or private deployment).

## Limitations and Correct Interpretation

See [DISCLAIMER.md](./DISCLAIMER.md) and [docs/methodology.md](./docs/methodology.md).
Core principles: **signal ≠ causality, FAERS has no denominator, temporal weighting is heuristic**.

## License

- Code: **MIT License** (see [LICENSE](./LICENSE)).
  If you prefer a license with a patent clause, Apache-2.0 can be used instead.
- Licenses for third-party data (OpenFDA / MedDRA / Naranjo / WHO-UMC) are covered in DISCLAIMER.

## Contributing

Issues / PRs welcome. Before submitting, read [CLAUDE.md](./CLAUDE.md) (project rules, also used by AI collaboration tools),
and make sure **no API keys, PII or full MedDRA lists are committed**.
