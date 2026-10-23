"""Identity stitching for the CDP (M3).

One run exports person records from `staging` in project 01's CSV format, runs
01's resolver on them unchanged, and loads profiles, links and pair evidence into
`core` (docs/adr/0001-reuse-entity-resolution.md).
"""
