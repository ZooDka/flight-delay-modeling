# ✈️ Flight Delay Monte-Carlo

**How late will your flight actually be?** A calibrated generative model of flight
departure delays, fit on 336,776 real flights, chosen by statistical model selection,
validated on held-out data, and turned into an interactive tool (**Flightcast**) that
works for **any flight**: enter the on-time rate, average delay, and worst delay from
any tracker, and the same model calibrates to them, producing the full distribution,
the percentile spread, a risk curve of exceedance probabilities, and an on-page
calibration check against your inputs.

<p align="center">
  <a href="https://zoodka.github.io/flight-delay-modeling/app/"><b>▶ Live interactive demo</b></a> ·
  <a href="notebooks/flight_delay_case_study.ipynb"><b>📓 Full case study</b></a>
</p>

---

## The one-line pitch

Averages lie about flight delays. The mean departure delay at Newark is ~15 minutes, but
the **median is −1**, most flights leave slightly early, dragged up by a heavy tail of
serious delays. This project models that tail properly and answers the question a traveler
actually has: *given my layover, what are the odds I miss my connection?*

## Key results

- **The delay distribution is a log-normal mixture**, an on-time/early cluster plus a
  right-skewed delayed tail. Log-normal was *selected* over gamma, Weibull, and
  exponential by **AIC** and a **Kolmogorov–Smirnov** test, not assumed.
- **Time of day is the dominant controllable driver.** Mean departure delay grows ~7×
  from the early-morning bank to the evening (corr = +0.22). An afternoon "3 PM"
  departure is a materially worse product than a 6 AM one.
- **The fitted model becomes a decision tool.** For a 3 PM inbound flight with a 90-minute
  layover and a 60-minute minimum connection time, the model estimates a ~16–18% chance of
  missing the connection, and shows exactly how much extra layover buys that risk down.

## What's in here

```
flight-delay-modeling/
├── app/
│   └── index.html          # Interactive Monte-Carlo demo (vanilla JS, no build step)
├── notebooks/
│   └── flight_delay_case_study.ipynb   # EDA → model selection → validation → decision layer
├── src/
│   └── model.py            # Reusable DelayModel (fit / sample / connection risk)
├── proxy/
│   └── worker.js           # Optional Cloudflare Worker for live lookup by flight number
├── data/
│   ├── nycflights13_flights.csv.gz     # Real data (336,776 flights, 2013)
│   └── real_params.json    # Fitted parameters used by the notebook & app
├── requirements.txt
└── README.md
```

## Method, briefly

1. **EDA** on real Newark departures exposes the bimodal, heavy-tailed shape.
2. **Model selection** fits four candidate distributions to the delayed tail and ranks
   them by AIC + KS; a Q–Q plot confirms the log-normal fit.
3. **Validation** uses a train/test split for held-out goodness-of-fit and **bootstrap**
   confidence intervals for percentiles, with an explicit note on why a large-*n*
   p-value is the wrong thing to report.
4. **Generative model** (`src/model.py`) is sampled via Monte-Carlo to produce the full
   distribution, percentiles, and threshold probabilities.
5. **Decision layer** converts the distribution into
   `P(arrival delay − onward delay > buffer − MCT)`, the probability of missing a
   connection.

## Run it

```bash
pip install -r requirements.txt
jupyter lab notebooks/flight_delay_case_study.ipynb   # the analysis
open app/index.html                                   # the interactive demo (no server needed)
```

The interactive demo is a single self-contained HTML file. Deploy it free with GitHub
Pages: repo **Settings → Pages → Source: Deploy from a branch → main, / (root) → Save**.
After a minute it goes live at
`https://zoodka.github.io/flight-delay-modeling/app/`.

## Optional: live lookup by flight number

The demo works fully standalone with manually entered stats. To let visitors type a
flight number and have the stats fetched automatically:

1. **Get a free AeroDataBox key.** Subscribe to the Basic (free) plan at
   [rapidapi.com/aedbx-aedbx/api/aerodatabox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox)
   and copy your `X-RapidAPI-Key`. The free tier includes roughly 600 API units per month.
2. **Deploy the proxy** (keeps the key off the public site). At
   [dash.cloudflare.com](https://dash.cloudflare.com), create a free Worker, replace its
   code with `proxy/worker.js`, add a secret with your key (Settings, then Variables
   and Secrets): name it `RAPIDAPI_KEY` for a RapidAPI key or `API_MARKET_KEY` for an
   API.Market key. Deploy and copy the worker URL.
3. **Point the site at it.** In `app/index.html`, set
   `const PROXY_URL = "https://your-worker.workers.dev";` and commit. A "Look up"
   button appears next to the flight field.

The worker caches each flight for 6 hours, restricts browser calls to this site's
origin (edit `ALLOWED_ORIGINS` in `worker.js` if you fork), and maps AeroDataBox's
P5 to P95 delay percentile curve into the model's three inputs.

## Honest limitations (and the obvious next steps)

- `nycflights13` is **2013, NYC-origin** data. Absolute magnitudes shift by year, airport,
  and airline; the *shape* and *time-of-day structure* are stable and widely replicated,
  but don't read the exact percentages as current for a specific route.
- The mixture treats the on-time and delayed components as independent of **weather and
  carrier**. Conditioning on them, e.g. **quantile regression** or gradient-boosted
  quantiles, is the natural extension and would turn this from a marginal model into a
  per-flight predictive one.
- The connection math uses a **static minimum connection time** and assumes the inbound
  and onward delays are independent. On bad-weather days they're correlated, which makes
  real-world misses somewhat more likely than the model's conservative estimate.

## Tech

Python (NumPy · SciPy · pandas · Matplotlib) for the analysis; vanilla JavaScript (seeded
Monte-Carlo in the browser, hand-rolled SVG charts) for the zero-dependency demo.

## Data & license

Flight data from [`nycflights13`](https://github.com/tidyverse/nycflights13) (CC0). Code in
this repo is MIT-licensed.
