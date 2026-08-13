# sitemap-csv-any-site

Cloudflare Worker that turns any website's sitemap (or sitemap index) into
CSV files, zipped for download. Fork of `sitemap-worker`, generalized to
work with any site instead of only `socialcounts.org`.

## What changed vs. the original

1. **Works on any website.** The hard-coded `socialcounts.org` allowlist is
   gone. `/api/sitemap` and `/api/batch` now accept any public `http(s)`
   URL. A basic SSRF guard blocks localhost / private / link-local
   hostnames so the Worker can't be used to probe internal networks.

2. **Fixes the "incomplete ZIP after ~200 sitemaps" bug.** The original
   built one big `csvFiles` array in the browser tab and only called
   `JSZip.generateAsync()` once, at the very end, to produce a single ZIP.
   On large jobs (hundreds of sitemaps, potentially tens of thousands of
   URLs) this holds everything in memory at once and downloads one huge
   blob — which is exactly the failure mode you hit: on big runs the
   in-memory build/download step gets interrupted (memory pressure, tab
   throttling, or the object URL being revoked before a large file
   finishes writing to disk) and you end up with a truncated ZIP that's
   missing the later sitemaps.

   The fix: the app now downloads a **ZIP part** as soon as it collects a
   configurable number of CSVs (default 150), instead of accumulating
   everything until the end. Each part is small, downloads immediately,
   and is fully independent — so even if something goes wrong on part 4,
   parts 1–3 are already safely on disk. Any leftover CSVs are flushed as
   a final part when the job finishes (or when you hit Stop, or if an
   error occurs partway through).

   You can tune "ZIP part size" in the UI (50 / 100 / 150 / 250 sitemaps
   per part) depending on how big each site's sitemap files are.

3. **Filenames are prefixed with hostname** (`example.com__sitemap-1.csv`)
   so CSVs from different domains never collide inside a ZIP part.

4. Minor hardening: 60MB cap per fetched sitemap file, longer delay before
   revoking each ZIP's object URL (helps slow connections/mobile), and
   errors mid-run now flush whatever CSVs were already collected instead
   of losing them.

## Deploy

```
npm install -g wrangler   # if you don't have it
wrangler deploy
```

That's it — no environment variables or bindings required.

## Notes

- Each Worker invocation fetches at most 20 sitemap files in parallel
  (`MAX_BATCH` in `src/index.js`). Raise this if you're on a paid
  Cloudflare plan and want more throughput; keep it conservative on the
  free plan's subrequest limits.
- Successfully fetched sitemap files are cached at the edge for 24 hours
  (`CACHE_TTL`), so re-running a job (e.g. after tuning ZIP part size) is
  fast the second time.
- The "child sitemap" filter only checks that discovered URLs are valid
  `http(s)` addresses — it does not restrict them to the same domain as
  your starting URL, since some sites host sitemap indexes that point to
  a CDN or subdomain. If you want to lock discovery to a single domain,
  tighten `validChild()` in the client script.
  
