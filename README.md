# Russian Losses: Public Data

Data-only mirror of the [Russian Losses Dashboard public API](https://russianlosses.pages.dev/data/).
The application source, credentials, analytics and private Git history are not included.

## Download

- [Dataset manifest](data/v1/manifest.json): coverage, sources, schemas, file sizes and SHA-256 checksums.
- [Live API catalog](https://russianlosses.pages.dev/data/): JSON, CSV and GeoJSON downloads.
- [Raw manifest](https://raw.githubusercontent.com/MarioJemic/russianlosses-data/main/data/v1/manifest.json).

The initial collection contains 25 datasets: reported losses, replacement-cost
assumptions, territory area and maps, monthly territory changes, seven annual
Russia/Ukraine social comparisons, and additional economy/fire datasets.
The manifest is the current inventory; source coverage dates differ by dataset.

```js
const base = 'https://raw.githubusercontent.com/MarioJemic/russianlosses-data/main';
const catalog = await fetch(`${base}/data/v1/manifest.json`).then(r => r.json());
const dataset = catalog.datasets.find(d => d.id === 'territory_monthly_combined');
const file = dataset.files.find(f => f.media_type === 'application/json');
const data = await fetch(`${base}${file.path}`).then(r => r.json());
console.log(data);
```

Paths in the manifest are root-relative to an API host; append them to the raw
repository base as above. Pin a Git commit instead of `main` for reproducible work.

## Interpretation

- Losses are reported/claimed figures, not independently verified deaths.
- Replacement costs and human-cost allocations are models, not actual spending
  or geolocated deaths.
- NZZ national areas and DeepState geometry remain separate sources. Combined
  monthly changes use same-source endpoints and retain their source per row.
- Missing observations remain null, never invented zeros. Partial months retain
  their actual final observation date. Annual and edition-year series differ.
- Fire detections are thermal anomalies, not proof of attacks or combat damage.
- `generated_at` is an export timestamp, not proof that every source is current.

## Updates

The data-only sync workflow checks the two public Cloudflare hosts daily at
05:17 UTC and can be run manually. It publishes only when both catalogs agree,
all new/changed files match the advertised hashes on both hosts, and the catalog
remains unchanged during the check. Unchanged local files are checked against
their advertised hashes and reused. Host failures or mismatches leave the last
committed release in place. Scheduled runs are best-effort, not real-time.

The small files under `.github/` maintain this mirror; they contain no dashboard
application code and use no private-repository or hosting credentials. Only
allowlisted versioned API data is downloaded, never executable code from a host.

## Sources and Terms

See each dataset's `sources`, `methodology`, `limitation` and `license_notice`,
plus [DATA_TERMS.md](DATA_TERMS.md). Public availability is not a blanket license
or an endorsement by the upstream publishers.
