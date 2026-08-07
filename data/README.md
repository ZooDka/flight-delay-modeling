# Data

`nycflights13_flights.csv.gz`, 336,776 flights departing New York (EWR, JFK, LGA) in
2013, from the [`nycflights13`](https://github.com/tidyverse/nycflights13) dataset (CC0).

Columns used: `year, month, day, carrier, flight, origin, dest, sched_dep_time,
dep_delay, arr_delay, air_time, distance, hour`.

`real_params.json`, model parameters and per-hour summary statistics fitted from the
above, consumed by the notebook and the web app so the two stay in sync.

### Refreshing / swapping data
Any table with a `dep_delay` column works. To use the current US Bureau of Transportation
Statistics *Airline On-Time Performance* data instead, download a month from
transtats.bts.gov, rename the departure-delay column to `dep_delay`, and point the loader
in the notebook at it, the modeling code (`src/model.py`) is source-agnostic.
