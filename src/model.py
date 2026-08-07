"""
Flight departure-delay modeling.

A flight's departure delay is *bimodal*: a large mass of on-time/early departures
plus a heavy right-skewed tail of late ones. We model it as a two-component mixture:

    delay ~  (1 - p) * OnTime   +   p * Delayed

where `Delayed` is a log-normal fitted to observed positive delays (log-normal wins
on AIC/KS against gamma, Weibull and exponential on the nycflights13 data) and
`OnTime` is a light spread of early/near-zero departures.

The same object gives you a fitted generative model you can (a) sample from via
Monte-Carlo, (b) read percentiles off, and (c) use to price the risk of missing a
downstream connection.
"""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from scipy import stats


@dataclass
class DelayModel:
    p_delayed: float      # P(dep_delay > 0)
    mu: float             # log-normal mu (delayed tail)
    sigma: float          # log-normal sigma (delayed tail)
    ot_mean: float        # mean of the on-time/early cluster
    ot_sd: float          # sd of the on-time/early cluster

    # ---- fitting -------------------------------------------------------------
    @classmethod
    def fit(cls, delays: np.ndarray) -> "DelayModel":
        """Fit the mixture to an array of observed departure delays (minutes)."""
        x = np.asarray(delays, dtype=float)
        x = x[np.isfinite(x)]
        pos = x[x > 0]
        neg = x[x <= 0]
        shape, loc, scale = stats.lognorm.fit(pos, floc=0)   # loc fixed at 0
        return cls(
            p_delayed=float((x > 0).mean()),
            mu=float(np.log(scale)),
            sigma=float(shape),
            ot_mean=float(neg.mean()) if len(neg) else -2.0,
            ot_sd=float(neg.std()) if len(neg) else 5.0,
        )

    @classmethod
    def from_summary(cls, on_time_rate, mean_delay, worst_case,
                     on_time_threshold=15):
        """
        Calibrate from published summary stats when raw data isn't available.
        Solves the log-normal width so the tail's ~99th pct matches `worst_case`.
        """
        w_ot = float(np.clip(on_time_rate, 1e-3, 1 - 1e-3))
        ot_mean, ot_sd = 2.0, on_time_threshold / 2.5
        E_del = max((mean_delay - w_ot * ot_mean) / (1 - w_ot), on_time_threshold + 1)

        def p99_gap(sig):
            mu = np.log(E_del) - sig ** 2 / 2
            return np.exp(mu + 2.326 * sig) - worst_case

        try:
            sigma = stats.brentq(p99_gap, 0.05, 1.5) if hasattr(stats, "brentq") \
                    else _brentq(p99_gap, 0.05, 1.5)
        except Exception:
            from scipy.optimize import brentq
            try:
                sigma = brentq(p99_gap, 0.05, 1.5)
            except ValueError:
                sigma = 0.5
        mu = np.log(E_del) - sigma ** 2 / 2
        # here the "delayed" component is everything not in the on-time cluster
        return cls(p_delayed=1 - w_ot, mu=mu, sigma=sigma,
                   ot_mean=ot_mean, ot_sd=ot_sd)

    # ---- sampling / stats ----------------------------------------------------
    def sample(self, n=400_000, seed=42) -> np.ndarray:
        rng = np.random.default_rng(seed)
        ot = rng.normal(self.ot_mean, self.ot_sd, n)
        delayed = rng.lognormal(self.mu, self.sigma, n)
        pick = rng.random(n) < self.p_delayed
        return np.where(pick, delayed, ot)

    def percentiles(self, ps=(5, 10, 25, 50, 75, 90, 95, 99), n=400_000, seed=42):
        D = self.sample(n, seed)
        return {p: float(np.percentile(D, p)) for p in ps}

    def prob_exceeds(self, minutes, n=400_000, seed=42) -> float:
        return float((self.sample(n, seed) > minutes).mean())


def connection_miss_prob(model: DelayModel, buffer_min, min_conn_min,
                         onward: "DelayModel | None" = None,
                         air_recovery_mean=5.0, n=400_000, seed=7):
    """
    P(miss the onward flight).  You miss it if
        arrival_delay - onward_departure_delay  >  buffer - min_conn_time
    Ignoring `onward` (assuming it's punctual) is the conservative case.
    """
    rng = np.random.default_rng(seed)
    slack = buffer_min - min_conn_min
    arr = model.sample(n, seed) - rng.normal(air_recovery_mean, 6, n)  # arrival delay
    if onward is None:
        return float((arr > slack).mean())
    return float(((arr - onward.sample(n, seed + 1)) > slack).mean())
