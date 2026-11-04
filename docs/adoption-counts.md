# How adoption counts are measured

The adoption block in the [README](../README.md) shows counts of public repos that use the kya-action,
and how many workspaces connect KYA to hosted channels. Counts are measured, dated, and sourced.

- A count under 50 is not shown.
- A badge reads "unavailable" when the data is missing or older than 48 hours.
- Repos using the action are counted by GitHub code search. The count is approximate. Private repos are
  not counted, and only default branches are searched.
- Hosted counts are workspaces, not users. Each one is an aggregate with no names and no IDs.
- Counts are downloads or workspaces at the time of measurement. They are not totals over time.

The full method, the limits and the owner steps are in
`docs/operations/kya-adoption-metrics.md` in the monorepo.
