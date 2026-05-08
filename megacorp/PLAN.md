# Megacorp Implementation Plan

Project goal: for each unified nation in `data/map_saves/lifestream_map_v1.json`, project population and GDP to **2041–42** and assign an industry **vertical** based on what the combined entity is good at today.

Status: planning. GDP projection methodology is still open and flagged for review.

---

## Inputs (finalized)

- **Nation list**: `data/map_saves/lifestream_map_v1.json` → `allGroups[]`
  - 29 unified nations (multi-country) + ~70 independents (single-country, `independent: true`).
  - Each entry has `countries[]` of country IDs.
- **Country IDs**: mostly ISO 3166-1 alpha-3 (e.g. `USA`, `GBR`), but a chunk of independents still carry ISO numeric codes (e.g. `132`, `212`, `316`). The recent migration commit (`bb9f011`) migrated grouped countries; independents look incomplete. **Verify and finish the migration before fetching data.**

## Data sources (decided)

### Population — UN World Population Prospects (WPP 2024)
- **Use case**: both history (1950–present) and the projection to 2041/42.
- **Approach**: consume UN's own projections directly per country, then sum across the countries in each unified nation. No bespoke pop-stat math required.
- **Variant**: medium variant by default; optionally high/low for scenario bands.
- **Format**: CSV download, ISO numeric codes (need mapping to alpha-3).

### GDP medium-term anchor — IMF World Economic Outlook (WEO)
- **Use case**: 5-year-ahead consensus projections to anchor whatever long-range method we choose.
- **Format**: CSV/Excel download, ISO-3 codes.

### GDP history — World Bank WDI
- **Series**: `NY.GDP.MKTP.KD` (constant USD, real GDP), `NY.GDP.PCAP.KD` (per capita), `NY.GDP.MKTP.CD` (nominal) for sanity.
- **Coverage**: ~1960–present for most countries.
- **Use case**: historical baseline for projection + sector composition (see below).

### Sector strength / "what are they good at" — TBD between two options
- **Option A — World Bank WDI value-added by sector** (`NV.AGR.TOTL.ZS`, `NV.IND.TOTL.ZS`, `NV.SRV.TOTL.ZS`, `NV.IND.MANF.ZS`). Simple, comparable, but coarse.
- **Option B — Observatory of Economic Complexity (OEC) or UN Comtrade** for export composition + Revealed Comparative Advantage (RCA). Sharper signal for picking a vertical (e.g. Chile→copper, Vietnam→electronics, DEU→machinery). More work to ingest.
- Leaning toward **Option B** for the vertical assignment and using Option A as a fallback / sanity check.

---

## Open questions

1. **GDP projection method** (most important — flagged for review)
   - Naive log-linear extrapolation on per-capita real GDP × projected population?
   - Holt-Winters / ARIMA on real GDP series?
   - Solow-style growth model with productivity assumption?
   - Convergence model (poor countries grow faster toward a frontier)?
   - We'll review after the data is loaded so we can eyeball the shape of the historical series.
2. **Sector source**: WDI value-added (Option A) vs OEC/Comtrade RCA (Option B).
3. **Vertical taxonomy**: do we predefine a list of verticals (e.g. tech, energy, agriculture, manufacturing, finance, pharma, defense, logistics, mining, tourism) and map each unified nation to one — or let strengths emerge from the data?
4. **Independents**: are we computing verticals for the ~70 independents too, or only the 29 unified nations?
5. **Currency / base year** for GDP comparisons in 2041/42 (constant 2015 USD? 2020 USD?).
6. **Failure mode**: what to do for countries with sparse history (small island states), or codes the data sources don't cover (Palestine, Western Sahara, Somaliland, Taiwan in some IMF datasets).

---

## Implementation steps

### Phase 1 — Data plumbing
1. **Finish ISO-3 migration** for independents in the map save so all country IDs are alpha-3.
2. **Build a country-code mapping module**: alpha-3 ↔ ISO numeric ↔ World Bank code ↔ IMF code ↔ UN WPP code. Single source of truth so each fetcher can translate.
3. **WPP fetcher**: download CSV(s), filter to our country set, store local cache (TSV/JSON) keyed by alpha-3 with annual population 1950→2100.
4. **WDI fetcher**: World Bank API per-country for the GDP series above + sector value-added. Cache locally.
5. **WEO fetcher**: download IMF WEO dataset, extract real GDP and GDP-per-capita projections through ~year+5. Cache locally.
6. **(If Option B)** OEC or Comtrade fetcher for export composition / RCA. Cache locally.

### Phase 2 — Per-country projection to 2041–42
1. Population: read directly from WPP (medium variant).
2. GDP: **method TBD** — implement chosen method per country, anchored to WEO for the first 5 years, then long-range method through 2042.
3. Output: per-country table `{ alpha3, year, pop, gdp_real, gdp_per_capita }` for 2041 and 2042.

### Phase 3 — Aggregate to unified-nation level
1. For each entry in `allGroups`, sum population and GDP across its `countries[]`.
2. Compute combined GDP per capita.
3. Compute combined sector mix as GDP-weighted average of constituent countries (Option A) or as a merged export basket / aggregated RCA (Option B).

### Phase 4 — Vertical assignment
1. Decide vertical taxonomy (open question 3).
2. For each unified nation, score against each vertical using the combined sector / RCA signal from Phase 3.
3. Assign top vertical (and maybe a secondary).
4. Output to a new field on each `allGroups` entry, or to a sibling JSON keyed by nation ID.

### Phase 5 — Output & visualization
1. Replace the placeholder `calculateMegacorps()` in `src/index.js` with the real pipeline (or split into modules under `src/`).
2. Emit a CSV/JSON per unified nation: `{ name, pop_2041, gdp_2041, gdp_per_capita_2041, sector_mix, vertical }`.
3. Optional: feed back into the map UI to color/label nations by vertical.

---

## Decisions log

- **2026-05-07** — Population source = UN WPP, consumed as-is (no DIY projection). GDP method deferred until we see historical series. Sector source between WDI value-added and OEC/Comtrade RCA still open.
