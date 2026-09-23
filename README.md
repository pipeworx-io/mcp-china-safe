# @pipeworx/china-safe

China's official reserve assets, balance of payments, and external debt —
外汇储备 (FX reserves), 国际收支 (balance of payments), 外债 (external debt) —
parsed from the English-language data pages of SAFE, the State Administration
of Foreign Exchange (国家外汇管理局).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

## Tools

- `china_fx_reserves({months})` — monthly official reserve assets: headline
  FX reserves (外汇储备), IMF reserve position, SDR holdings, gold (value +
  ounces), other reserve assets, and the total. MONTHLY, published roughly
  one week after month-end. Verified 2026-09-07: August 2026 was the newest
  month — FX reserves USD 3,438.325bn, total official reserve assets
  USD 3,854.885bn — published on 2026-09-07.
- `china_balance_of_payments({quarters, currency})` — quarterly BOP summary:
  current account (goods, services, primary/secondary income), capital and
  financial account (incl. the reserve-assets change), and net errors and
  omissions. `currency` is `usd` (default), `rmb`, or `sdr`. QUARTERLY, with
  roughly a 3-month lag after quarter-end — this is the standard BPM6 release
  cadence, not a stale site. Verified 2026-09-07: latest quarter was 2026Q1,
  published 2026-06-26.
- `china_external_debt({quarters})` — quarterly gross external debt position
  (外债) since 2014Q4: total, by original-contract maturity (short/long-term),
  and by institutional sector (general government, central bank, other
  depository corporations, other sectors, direct-investment intercompany
  lending). Same ~3-month quarterly lag as BOP. Verified 2026-09-07: latest
  quarter was 2026Q1, published 2026-06-26.
- `china_safe_releases({limit})` — the REAL publish dates behind the other
  three tools, read from each source page's own `PubDate` metadata and its
  attached file's upload timestamp, not the page's permalink. Use this before
  citing a number from the other tools if freshness matters to the caller.

## Auth

Keyless.

## Data sources

- <https://www.safe.gov.cn/en/ForexReserves/index.html> — official reserve
  assets, one cumulative .xlsx per calendar year (columns YYYY.01–YYYY.12).
- <https://www.safe.gov.cn/en/BalanceofPayments/index.html> — one .xlsx with
  the full BOP time series in annual + quarterly sheets, each in RMB/USD/SDR.
- <https://www.safe.gov.cn/en/ExternalDebt/index.html> — one .xlsx with the
  gross external debt position by sector, quarterly since 2014Q4.

### Traps recorded here so nobody re-discovers them

- **The permalink URL is not the publish date.** SAFE republishes each year's
  reserve table, and the BOP/debt time series, IN PLACE at a URL minted years
  earlier — e.g. "Official Reserve Assets (2026)" lives at
  `/en/2021/0203/2045.html`, a 2021-dated path, and was still updating live
  data as of 2026-09-07. Trust the article page's own
  `<meta name="PubDate">` and the date embedded in the attached file's own
  path (`/en/file/file/20260907/....xlsx`), never the permalink.
- **No JSON, no CSV, no rendered HTML table with the numbers in it.** Each
  article page only *links* an .xlsx (and usually a matching .pdf); the page
  body is a stub. This pack parses the .xlsx directly with a hand-rolled,
  dependency-free ZIP+XML reader (`src/xlsx.ts`, ported from the
  `ema-medicines` pack's reader) — a Worker can't carry a full xlsx library
  for three files.
- **The xlsx link's anchor text differs by page.** Reserves pages link with
  plain anchor text (`<a href="...">xlsx</a>`); BOP/external-debt pages put
  the full report title as the anchor text and the filename only in a
  `title="..."` attribute. Match on the `.xlsx` href extension, not the
  anchor text.
- **Reserve rows are fixed by position, not by column header repetition.**
  Each month is a pair of columns (USD, then SDR) but only the USD column
  carries the "YYYY.MM" header text — the SDR column is a merged cell with no
  header of its own. The six metric rows (FX reserves, IMF position, SDRs,
  gold value, gold ounces, other reserve assets, total) are at fixed row
  numbers within the sheet; verified against the live file before shipping
  (row totals reproduce column sums to the cent).
- **BOP is a ~280-row BPM6 breakdown; this pack surfaces the 17 summary
  lines**, not the full sub-account detail (financial-instrument-by-sector
  breakdowns run four levels deep). Row numbers are looked up dynamically by
  matching normalized column-A label text, not hardcoded, since the same
  template is reused across the RMB/USD/SDR sheets.
- **External debt sector totals equal the sum of their own short+long-term
  subtotal rows**, and the grand total equals the sum of the five sector
  totals — checked against the live 2026Q1 figures before shipping
  (24,120.799 = 3,601.510 + 1,034.221 + 9,886.860 + 6,820.844 + 2,777.364).
- **Gold ounces are reported in units of 10,000 (万盎司)** — e.g. "7673万盎司"
  is 76,730,000 ounces; this pack converts to `gold_million_oz` directly.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-safe": {
      "url": "https://gateway.pipeworx.io/china-safe/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-safe/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/china_fx_reserves \
  -H 'Content-Type: application/json' \
  -d '{"months":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/china_fx_reserves`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-safe": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-safe"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-safe
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Safe data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
