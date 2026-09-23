interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * China SAFE (State Administration of Foreign Exchange) — 国家外汇管理局
 *
 * FX reserves, official reserve assets, balance of payments, and external
 * debt, sourced from safe.gov.cn's ENGLISH data pages. Auth: none.
 *
 * Source shape (learned probing 2026-09-07, all from the English site):
 *  - Each data category (ForexReserves, BalanceofPayments, ExternalDebt) has
 *    an index page at /en/<Category>/index.html listing article permalinks.
 *  - THE PERMALINK IS NOT THE PUBLISH DATE. safe.gov.cn republishes each
 *    year's reserve table and the BOP/debt time series IN PLACE at a
 *    permalink minted years ago (e.g. "Official Reserve Assets (2026)" lives
 *    at /en/2021/0203/2045.html — a 2021 URL). The article page's own
 *    `<meta name="PubDate">` and the date embedded in its attached XLSX's
 *    file path are what actually move. Trust those, never the permalink.
 *  - Official Reserve Assets: ONE xlsx per calendar year, columns
 *    YYYY.01..YYYY.12, published monthly ~1 week after month-end. Verified
 *    live 2026-09-07: the 2026 page's PubDate is 2026-09-07 and the xlsx
 *    (path .../20260907/....xlsx) carries data through 2026.08 — August's
 *    reserves, published on schedule. MONTHLY, ~1-week lag.
 *  - Balance of Payments / External Debt: each is ONE xlsx covering the full
 *    time series back to the 1990s/2014, in annual+quarterly sheets across
 *    RMB/USD/SDR. Verified live 2026-09-07: PubDate 2026-06-26, latest
 *    column 2026Q1 — QUARTERLY, roughly a 3-MONTH lag after quarter-end
 *    (standard for BOP/external-debt releases worldwide; Q2 2026 was not yet
 *    due as of this probe). This is NOT a stale-site problem, it's the
 *    normal BPM6 release cadence — but every tool below says so, because the
 *    permalink alone would suggest otherwise.
 *  - No JSON, no CSV. Parse the linked .xlsx (a plain ZIP of XML sheets) —
 *    see xlsx.ts, a hand-rolled no-dependency reader (a Worker cannot carry a
 *    full xlsx library for three files). No HTML-table scraping: the pages
 *    only link the file, they don't render the numbers.
 */


// ── minimal read-only XLSX reader (inlined, not a sibling module) ──────────
// Kept in THIS file rather than a sibling xlsx.ts: the standalone-publish
// not a pack's own local module files, so a separate './xlsx.js' import
// breaks `tsc` in the generated standalone repo with "Cannot find module"
// (verified against ema-medicines, which hits the identical failure with its
// own sibling xlsx.ts — a pre-existing gap in the publish tooling, not a
// china-safe-specific bug). Ported from ema-medicines/src/xlsx.ts unchanged;
// enough for one machine-generated sheet, no deps — a Worker can't carry a
// full zip/xlsx library for one file.
//   1. ZIP central-directory walk + DecompressionStream('deflate-raw').
//   2. A regex scan of sheet XML that handles shared strings AND inline strings.

const xlsxTd = new TextDecoder();

function findEocd(view: DataView): number {
  // End-of-central-directory record: signature 0x06054b50, at most 64 KB of
  // trailing comment after it. Scan backwards.
  const min = Math.max(0, view.byteLength - 66_000);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes: Uint8Array): Promise<string> {
  // `bytes` is a subarray VIEW into the whole zip buffer, so `.buffer` alone
  // would hand Response the entire archive, not just this entry — copy first
  // so the ArrayBuffer's bounds match the slice exactly. The copy (rather
  // than the Uint8Array itself) is also what keeps this typechecking under
  // the standalone-publish build's plain DOM lib, which — unlike Workers'
  // lib.dom augmentation — doesn't accept a Uint8Array as BodyInit directly.
  const body = new Response(bytes.slice().buffer as ArrayBuffer).body;
  if (!body) throw new Error('cannot stream zip entry');
  return await new Response(body.pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

/**
 * Extract the named entries from a ZIP archive as UTF-8 text.
 * Entries absent from the archive are simply missing from the result.
 */
async function unzipText(buffer: ArrayBuffer, wanted: string[]): Promise<Record<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const want = new Set(wanted);
  const out: Record<string, string> = {};

  for (let i = 0; i < count && p + 46 <= view.byteLength; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = xlsxTd.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!want.has(name)) continue;

    // The local header repeats the name/extra with DIFFERENT lengths than the
    // central directory, so the data offset has to be read from the local one.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const slice = bytes.subarray(start, start + compressedSize);
    out[name] = method === 0 ? xlsxTd.decode(slice) : await inflateRaw(slice);
  }
  return out;
}

const XLSX_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
};

function unescapeXml(s: string): string {
  if (s.indexOf('&') === -1) return s;
  const out = s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const known = XLSX_ENTITIES[m];
    if (known !== undefined) return known;
    const code = m[2] === 'x' || m[2] === 'X'
      ? parseInt(m.slice(3, -1), 16)
      : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
  // Indication text is pasted out of HTML, so `&amp;nbsp;` survives the XML
  // unescape as a literal `&nbsp;` sitting in the middle of a sentence.
  return out.indexOf('&nbsp;') === -1 ? out : out.replace(/&nbsp;/g, ' ');
}

const XLSX_T_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;

function textOf(xml: string): string {
  let s = '';
  XLSX_T_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XLSX_T_RE.exec(xml)) !== null) s += m[1];
  return unescapeXml(s);
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(textOf(m[1]));
  return out;
}

// The `[^>]*?` MUST be lazy: a greedy attribute match swallows the `/` of a
// self-closing `<c .../>` and then runs on to the NEXT cell's `</c>`, which
// shifts every value in the row by one column. That silent off-by-one is the
// single easiest way to get this file wrong.
const XLSX_CELL_RE = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const XLSX_V_RE = /<v>([\s\S]*?)<\/v>/;

interface SheetScan {
  /** Column letter → cell text, per row number. Blank cells are omitted. */
  rows: Map<number, Record<string, string>>;
}

/**
 * Scan sheet XML into a sparse row map. One pass, no DOM.
 */
function scanSheet(sheetXml: string, shared: string[]): SheetScan {
  const rows = new Map<number, Record<string, string>>();
  XLSX_CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XLSX_CELL_RE.exec(sheetXml)) !== null) {
    const inner = m[4];
    if (!inner) continue;
    const attrs = m[3];
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
    let value: string;
    if (type === 's') {
      const v = XLSX_V_RE.exec(inner);
      if (!v) continue;
      value = shared[Number(v[1])] ?? '';
    } else if (type === 'inlineStr' || type === 'str') {
      // Header cells in some exports are inlineStr, not shared strings — a
      // parser that only reads shared strings sees a blank header row.
      value = textOf(inner);
    } else {
      const v = XLSX_V_RE.exec(inner);
      if (!v) continue;
      value = unescapeXml(v[1]);
    }
    value = value.trim();
    if (!value) continue;
    const rowNum = Number(m[2]);
    let row = rows.get(rowNum);
    if (!row) {
      row = {};
      rows.set(rowNum, row);
    }
    row[m[1]] = value;
  }
  return { rows };
}

const UA = 'pipeworx-mcp-china-safe/1.0 (+https://pipeworx.io)';
const SOURCE_NAME =
  "State Administration of Foreign Exchange (SAFE, 国家外汇管理局) — safe.gov.cn/en";

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'SAFE (China)');
}

const BASE = 'https://www.safe.gov.cn';
const INDEX_RESERVES = `${BASE}/en/ForexReserves/index.html`;
const INDEX_BOP = `${BASE}/en/BalanceofPayments/index.html`;
const INDEX_EXTDEBT = `${BASE}/en/ExternalDebt/index.html`;

/** Six-hour cache at the edge on top of the in-isolate cache below — SAFE has
 * no documented rate limit, but every other gov.cn source we've probed does,
 * and a burst of tool calls should not each go back to origin. */
const EDGE_CACHE: RequestInit = {
  cf: { cacheTtlByStatus: { '200-299': 21600, '400-499': 60, '500-599': 10 } },
} as RequestInit;

function abs(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Find `<a href="...">TEXT</a>` links on an index page, optionally filtered
 * by a regex over the anchor text. */
function findLinks(html: string, textRe?: RegExp): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[2].trim();
    if (!text || text === 'Next' || text === 'End') continue;
    if (textRe && !textRe.test(text)) continue;
    out.push({ text, href: m[1] });
  }
  return out;
}

interface ArticleMeta {
  title: string | null;
  pubDate: string | null;
  xlsxUrl: string | null;
  pdfUrl: string | null;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/​/g, '');
}

function articleMeta(html: string): ArticleMeta {
  const titleRaw = /<meta name="ArticleTitle" content="([^"]*)"/.exec(html)?.[1] ?? null;
  const title = titleRaw ? unescapeHtml(titleRaw) : null;
  const pubDate = /<meta name="PubDate" content="([^"]*)"/.exec(html)?.[1] ?? null;
  // The reserves pages link the file with plain anchor text ("xlsx"); the BOP
  // and external-debt pages instead put the whole report title as the anchor
  // text and the filename only in a `title="..."` attribute. Match on the
  // href extension alone so both shapes work.
  const xlsxHref = /<a[^>]*href="([^"]+\.xlsx)"/i.exec(html)?.[1] ?? null;
  const pdfHref = /<a[^>]*href="([^"]+\.pdf)"/i.exec(html)?.[1] ?? null;
  return {
    title,
    pubDate,
    xlsxUrl: xlsxHref ? abs(xlsxHref) : null,
    pdfUrl: pdfHref ? abs(pdfHref) : null,
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await pwFetch(url, EDGE_CACHE);
  if (!res.ok) throw new Error(`safe_http_${res.status}:${url}`);
  return res.text();
}

async function fetchArticle(url: string): Promise<{ html: string; meta: ArticleMeta }> {
  const html = await fetchText(url);
  return { html, meta: articleMeta(html) };
}

// ── column-letter arithmetic (reserves file never exceeds 'Z') ─────────────
function colToNum(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}
function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Pull only the rows we care about out of a (possibly huge) sheet, then run
 * the shared-string cell scanner on just that slice — avoids paying the
 * regex cost of every one of a BOP sheet's ~4,000 detail rows when a summary
 * tool needs 17 of them. Cell refs are self-describing (`r="COL#"`), so
 * concatenating the wanted rows' raw XML and handing it to scanSheet works
 * unchanged. */
function extractRows(sheetXml: string, wanted: Set<number>): string {
  const re = /<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  let out = '';
  while ((m = re.exec(sheetXml)) !== null) {
    if (wanted.has(Number(m[1]))) out += m[2];
  }
  return out;
}

async function downloadXlsx(url: string, sheetPath: string): Promise<{ sheet: string; shared: string[] }> {
  const res = await pwFetch(url, EDGE_CACHE);
  if (!res.ok) throw new Error(`safe_xlsx_http_${res.status}:${url}`);
  const buffer = await res.arrayBuffer();
  const entries = await unzipText(buffer, [sheetPath, 'xl/sharedStrings.xml']);
  const sheet = entries[sheetPath];
  if (!sheet) throw new Error(`safe_sheet_missing:${sheetPath}`);
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ?? '');
  return { sheet, shared };
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ── 1. Official reserve assets (monthly) ────────────────────────────────────

const RESERVES_ROW = {
  header: 4,
  fx: 8,
  imf_position: 10,
  sdrs: 12,
  gold_value: 14,
  gold_ounces: 16,
  other: 17,
  total: 19,
};
const RESERVES_ROWSET = new Set(Object.values(RESERVES_ROW));

interface ReserveMonth {
  month: string; // YYYY-MM
  fx_reserves_usd_100m: number | null;
  fx_reserves_sdr_100m: number | null;
  fx_reserves_usd_billion: number | null;
  imf_reserve_position_usd_100m: number | null;
  imf_reserve_position_sdr_100m: number | null;
  sdr_holdings_usd_100m: number | null;
  sdr_holdings_sdr_100m: number | null;
  gold_usd_100m: number | null;
  gold_sdr_100m: number | null;
  gold_million_oz: number | null;
  other_reserve_assets_usd_100m: number | null;
  other_reserve_assets_sdr_100m: number | null;
  total_official_reserve_assets_usd_100m: number | null;
  total_official_reserve_assets_sdr_100m: number | null;
  total_official_reserve_assets_usd_billion: number | null;
}

interface ReservesDataset {
  months: ReserveMonth[]; // ascending by month
  fetchedAt: number;
  sourcePages: { year: number; pageUrl: string; pubDate: string | null; xlsxUrl: string | null }[];
}

let RESERVES_CACHE: ReservesDataset | null = null;
let RESERVES_INFLIGHT: Promise<ReservesDataset> | null = null;
const RESERVES_TTL_MS = 12 * 60 * 60 * 1000;

function parseGoldOz(raw: string | undefined): number | null {
  // "7673万盎司" (or split across two cells as "7673" + "万盎司") = 7,673 * 10,000 oz.
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n * 0.01 : null; // → million oz
}

async function loadReserveYear(
  year: number,
  indexLinks: { text: string; href: string }[],
): Promise<{ year: number; pageUrl: string; pubDate: string | null; xlsxUrl: string | null; months: ReserveMonth[] }> {
  const link = indexLinks.find((l) => l.text === `Official Reserve Assets (${year})`);
  if (!link) return { year, pageUrl: '', pubDate: null, xlsxUrl: null, months: [] };
  const pageUrl = abs(link.href);
  const { meta } = await fetchArticle(pageUrl);
  if (!meta.xlsxUrl) return { year, pageUrl, pubDate: meta.pubDate, xlsxUrl: null, months: [] };

  const { sheet, shared } = await downloadXlsx(meta.xlsxUrl, 'xl/worksheets/sheet1.xml');
  const wanted = new Set([RESERVES_ROW.header, ...RESERVES_ROWSET]);
  const { rows } = scanSheet(extractRows(sheet, wanted), shared);
  const header = rows.get(RESERVES_ROW.header);
  if (!header) return { year, pageUrl, pubDate: meta.pubDate, xlsxUrl: meta.xlsxUrl, months: [] };

  const monthCols: { col: string; month: string }[] = [];
  for (const [col, text] of Object.entries(header)) {
    const m = /^(\d{4})\.(\d{2})$/.exec(text);
    if (m) monthCols.push({ col, month: `${m[1]}-${m[2]}` });
  }
  monthCols.sort((a, b) => colToNum(a.col) - colToNum(b.col));

  const fx = rows.get(RESERVES_ROW.fx) ?? {};
  const imf = rows.get(RESERVES_ROW.imf_position) ?? {};
  const sdr = rows.get(RESERVES_ROW.sdrs) ?? {};
  const goldV = rows.get(RESERVES_ROW.gold_value) ?? {};
  const goldOz = rows.get(RESERVES_ROW.gold_ounces) ?? {};
  const other = rows.get(RESERVES_ROW.other) ?? {};
  const total = rows.get(RESERVES_ROW.total) ?? {};

  const months: ReserveMonth[] = [];
  for (const { col, month } of monthCols) {
    const usdCol = col;
    const sdrCol = numToCol(colToNum(col) + 1);
    const fxUsd = num(fx[usdCol]);
    if (fxUsd === null) continue; // month not yet published
    months.push({
      month,
      fx_reserves_usd_100m: fxUsd,
      fx_reserves_sdr_100m: num(fx[sdrCol]),
      fx_reserves_usd_billion: fxUsd * 0.1,
      imf_reserve_position_usd_100m: num(imf[usdCol]),
      imf_reserve_position_sdr_100m: num(imf[sdrCol]),
      sdr_holdings_usd_100m: num(sdr[usdCol]),
      sdr_holdings_sdr_100m: num(sdr[sdrCol]),
      gold_usd_100m: num(goldV[usdCol]),
      gold_sdr_100m: num(goldV[sdrCol]),
      gold_million_oz: parseGoldOz(goldOz[usdCol] ?? goldOz[sdrCol]),
      other_reserve_assets_usd_100m: num(other[usdCol]),
      other_reserve_assets_sdr_100m: num(other[sdrCol]),
      total_official_reserve_assets_usd_100m: num(total[usdCol]),
      total_official_reserve_assets_sdr_100m: num(total[sdrCol]),
      total_official_reserve_assets_usd_billion:
        num(total[usdCol]) !== null ? (num(total[usdCol]) as number) * 0.1 : null,
    });
  }
  return { year, pageUrl, pubDate: meta.pubDate, xlsxUrl: meta.xlsxUrl, months };
}

async function loadReserves(): Promise<ReservesDataset> {
  const indexHtml = await fetchText(INDEX_RESERVES);
  const links = findLinks(indexHtml, /^Official Reserve Assets \(\d{4}\)$/);
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const [cur, prev] = await Promise.all([
    loadReserveYear(thisYear, links),
    loadReserveYear(thisYear - 1, links),
  ]);
  const months = [...prev.months, ...cur.months].sort((a, b) => (a.month < b.month ? -1 : 1));
  if (!months.length) throw new Error('safe_reserves_no_data');
  return {
    months,
    fetchedAt: Date.now(),
    sourcePages: [
      { year: prev.year, pageUrl: prev.pageUrl, pubDate: prev.pubDate, xlsxUrl: prev.xlsxUrl },
      { year: cur.year, pageUrl: cur.pageUrl, pubDate: cur.pubDate, xlsxUrl: cur.xlsxUrl },
    ],
  };
}

async function reservesDataset(): Promise<ReservesDataset> {
  const now = Date.now();
  if (RESERVES_CACHE && now - RESERVES_CACHE.fetchedAt < RESERVES_TTL_MS) return RESERVES_CACHE;
  if (RESERVES_INFLIGHT) return RESERVES_INFLIGHT;
  RESERVES_INFLIGHT = loadReserves()
    .then((d) => {
      RESERVES_CACHE = d;
      RESERVES_INFLIGHT = null;
      return d;
    })
    .catch((e) => {
      RESERVES_INFLIGHT = null;
      if (RESERVES_CACHE) return RESERVES_CACHE;
      throw e;
    });
  return RESERVES_INFLIGHT;
}

// ── 2. Balance of payments (quarterly) ──────────────────────────────────────

const BOP_SHEET_BY_CURRENCY: Record<string, string> = {
  usd: 'xl/worksheets/sheet4.xml',
  rmb: 'xl/worksheets/sheet2.xml',
  sdr: 'xl/worksheets/sheet6.xml',
};

const BOP_ROW_LABELS: [string, string][] = [
  ['current_account', '1. Current account'],
  ['goods_and_services', '1.A Goods and services'],
  ['goods', '1.A.a Goods'],
  ['services', '1.A.b Services'],
  ['primary_income', '1.B Primary income'],
  ['secondary_income', '1.C Secondary income'],
  ['capital_and_financial_account', '2. Capital and financial account'],
  ['capital_account', '2.1 Capital account'],
  ['financial_account', '2.2 Financial account'],
  ['financial_account_excl_reserve_assets', '2.2.1 Financial account excluding reserve assets'],
  ['reserve_assets', '2.2.2 Reserve assets'],
  ['monetary_gold', '2.2.2.1 Monetary gold'],
  ['sdr_reserve_assets', '2.2.2.2 Special drawing rights'],
  ['reserve_position_in_imf', '2.2.2.3 Reserve position in the IMF'],
  ['foreign_currency_reserves', '2.2.2.4 Foreign currency reserves'],
  ['other_reserve_assets', '2.2.2.5 Other reserve assets'],
  ['net_errors_and_omissions', '3.Net errors and omissions'],
];

interface BopDataset {
  quarters: Record<string, Record<string, number | null>>; // quarter -> field -> value
  order: string[]; // quarters ascending
  fetchedAt: number;
  pageUrl: string;
  pubDate: string | null;
  xlsxUrl: string | null;
  currency: string;
}

const BOP_CACHE = new Map<string, BopDataset>();
const BOP_INFLIGHT = new Map<string, Promise<BopDataset>>();
const BOP_TTL_MS = 24 * 60 * 60 * 1000;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function loadBop(currency: string): Promise<BopDataset> {
  const indexHtml = await fetchText(INDEX_BOP);
  const links = findLinks(indexHtml, /time-series data of Balance of Payments/i);
  const link = links[0];
  if (!link) throw new Error('safe_bop_index_link_missing');
  const pageUrl = abs(link.href);
  const { meta } = await fetchArticle(pageUrl);
  if (!meta.xlsxUrl) throw new Error('safe_bop_xlsx_missing');

  const sheetPath = BOP_SHEET_BY_CURRENCY[currency] ?? BOP_SHEET_BY_CURRENCY.usd;
  const res = await pwFetch(meta.xlsxUrl, EDGE_CACHE);
  if (!res.ok) throw new Error(`safe_xlsx_http_${res.status}`);
  const buffer = await res.arrayBuffer();
  const entries = await unzipText(buffer, [sheetPath, 'xl/sharedStrings.xml']);
  const sheet = entries[sheetPath];
  if (!sheet) throw new Error('safe_bop_sheet_missing');
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ?? '');

  // First pass: find the row number for each label by scanning column A only.
  const colARe = /<c r="A(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;
  const labelToRow = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = colARe.exec(sheet)) !== null) {
    const inner = m[2];
    if (!inner) continue;
    const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
    if (!vMatch) continue;
    const tMatch = /\bt="([^"]+)"/.exec(m[0]);
    let text: string;
    if (tMatch?.[1] === 's') {
      text = shared[Number(vMatch[1])] ?? '';
    } else {
      text = vMatch[1];
    }
    labelToRow.set(norm(text), Number(m[1]));
  }

  const rowByField = new Map<string, number>();
  for (const [field, label] of BOP_ROW_LABELS) {
    const row = labelToRow.get(label);
    if (row !== undefined) rowByField.set(field, row);
  }
  const headerRow = labelToRow.get('Item');
  if (headerRow === undefined) throw new Error('safe_bop_header_missing');

  const wanted = new Set([headerRow, ...rowByField.values()]);
  const { rows } = scanSheet(extractRows(sheet, wanted), shared);
  const header = rows.get(headerRow) ?? {};

  const qCols: { col: string; quarter: string }[] = [];
  for (const [col, text] of Object.entries(header)) {
    if (/^\d{4}Q[1-4]$/.test(text)) qCols.push({ col, quarter: text });
  }
  qCols.sort((a, b) => colToNum(a.col) - colToNum(b.col));

  const quarters: Record<string, Record<string, number | null>> = {};
  const order: string[] = [];
  for (const { col, quarter } of qCols) {
    const rec: Record<string, number | null> = {};
    let any = false;
    for (const [field, row] of rowByField) {
      const rowVals = rows.get(row) ?? {};
      const v = num(rowVals[col]);
      rec[field] = v;
      if (v !== null) any = true;
    }
    if (any) {
      quarters[quarter] = rec;
      order.push(quarter);
    }
  }
  if (!order.length) throw new Error('safe_bop_no_data');

  return { quarters, order, fetchedAt: Date.now(), pageUrl, pubDate: meta.pubDate, xlsxUrl: meta.xlsxUrl, currency };
}

async function bopDataset(currency: string): Promise<BopDataset> {
  const now = Date.now();
  const cached = BOP_CACHE.get(currency);
  if (cached && now - cached.fetchedAt < BOP_TTL_MS) return cached;
  const inflight = BOP_INFLIGHT.get(currency);
  if (inflight) return inflight;
  const p = loadBop(currency)
    .then((d) => {
      BOP_CACHE.set(currency, d);
      BOP_INFLIGHT.delete(currency);
      return d;
    })
    .catch((e) => {
      BOP_INFLIGHT.delete(currency);
      const c = BOP_CACHE.get(currency);
      if (c) return c;
      throw e;
    });
  BOP_INFLIGHT.set(currency, p);
  return p;
}

// ── 3. External debt (quarterly) ────────────────────────────────────────────

interface ExtDebtQuarter {
  quarter: string;
  total_usd_100m: number | null;
  by_sector: {
    general_government: { total: number | null; short_term: number | null; long_term: number | null };
    central_bank: { total: number | null; short_term: number | null; long_term: number | null };
    other_depository_corporations: { total: number | null; short_term: number | null; long_term: number | null };
    other_sectors: { total: number | null; short_term: number | null; long_term: number | null };
    direct_investment_intercompany_lending: { total: number | null };
  };
  by_maturity: { short_term_total: number | null; long_term_total: number | null };
}

interface ExtDebtDataset {
  quarters: ExtDebtQuarter[]; // ascending
  fetchedAt: number;
  pageUrl: string;
  pubDate: string | null;
  xlsxUrl: string | null;
}

let EXTDEBT_CACHE: ExtDebtDataset | null = null;
let EXTDEBT_INFLIGHT: Promise<ExtDebtDataset> | null = null;
const EXTDEBT_TTL_MS = 24 * 60 * 60 * 1000;

async function loadExtDebt(): Promise<ExtDebtDataset> {
  const indexHtml = await fetchText(INDEX_EXTDEBT);
  const links = findLinks(indexHtml, /Gross External Debt Position by Sector/i);
  const link = links[0];
  if (!link) throw new Error('safe_extdebt_index_link_missing');
  const pageUrl = abs(link.href);
  const { meta } = await fetchArticle(pageUrl);
  if (!meta.xlsxUrl) throw new Error('safe_extdebt_xlsx_missing');

  const { sheet, shared } = await downloadXlsx(meta.xlsxUrl, 'xl/worksheets/sheet1.xml');

  // Fixed row numbers verified live 2026-09-07 against the published sheet
  // (sector totals sum to short+long, and sector totals sum to the grand
  // total — checked against 2026Q1's own numbers before shipping).
  const ROWS = {
    header: 2,
    gg_total: 3, gg_short: 4, gg_long: 10,
    cb_total: 17, cb_short: 18, cb_long: 24,
    odc_total: 31, odc_short: 32, odc_long: 38,
    os_total: 44, os_short: 45, os_long: 51,
    dii_total: 57,
    grand_total: 61,
  };
  const wanted = new Set(Object.values(ROWS));
  const { rows } = scanSheet(extractRows(sheet, wanted), shared);
  const header = rows.get(ROWS.header) ?? {};

  const qCols: { col: string; quarter: string }[] = [];
  for (const [col, text] of Object.entries(header)) {
    if (/^\d{4}Q[1-4]$/.test(text)) qCols.push({ col, quarter: text });
  }
  qCols.sort((a, b) => colToNum(a.col) - colToNum(b.col));

  const v = (row: number, col: string) => num((rows.get(row) ?? {})[col]);

  const quarters: ExtDebtQuarter[] = [];
  for (const { col, quarter } of qCols) {
    const total = v(ROWS.grand_total, col);
    if (total === null) continue;
    const gg = { total: v(ROWS.gg_total, col), short_term: v(ROWS.gg_short, col), long_term: v(ROWS.gg_long, col) };
    const cb = { total: v(ROWS.cb_total, col), short_term: v(ROWS.cb_short, col), long_term: v(ROWS.cb_long, col) };
    const odc = { total: v(ROWS.odc_total, col), short_term: v(ROWS.odc_short, col), long_term: v(ROWS.odc_long, col) };
    const os = { total: v(ROWS.os_total, col), short_term: v(ROWS.os_short, col), long_term: v(ROWS.os_long, col) };
    const dii = { total: v(ROWS.dii_total, col) };
    const shortSum = [gg.short_term, cb.short_term, odc.short_term, os.short_term];
    const longSum = [gg.long_term, cb.long_term, odc.long_term, os.long_term];
    const sumOrNull = (arr: (number | null)[]) =>
      arr.every((x) => x !== null) ? (arr as number[]).reduce((a, b) => a + b, 0) : null;
    quarters.push({
      quarter,
      total_usd_100m: total,
      by_sector: {
        general_government: gg,
        central_bank: cb,
        other_depository_corporations: odc,
        other_sectors: os,
        direct_investment_intercompany_lending: dii,
      },
      by_maturity: { short_term_total: sumOrNull(shortSum), long_term_total: sumOrNull(longSum) },
    });
  }
  if (!quarters.length) throw new Error('safe_extdebt_no_data');

  return { quarters, fetchedAt: Date.now(), pageUrl, pubDate: meta.pubDate, xlsxUrl: meta.xlsxUrl };
}

async function extDebtDataset(): Promise<ExtDebtDataset> {
  const now = Date.now();
  if (EXTDEBT_CACHE && now - EXTDEBT_CACHE.fetchedAt < EXTDEBT_TTL_MS) return EXTDEBT_CACHE;
  if (EXTDEBT_INFLIGHT) return EXTDEBT_INFLIGHT;
  EXTDEBT_INFLIGHT = loadExtDebt()
    .then((d) => {
      EXTDEBT_CACHE = d;
      EXTDEBT_INFLIGHT = null;
      return d;
    })
    .catch((e) => {
      EXTDEBT_INFLIGHT = null;
      if (EXTDEBT_CACHE) return EXTDEBT_CACHE;
      throw e;
    });
  return EXTDEBT_INFLIGHT;
}

// ── shared helpers ───────────────────────────────────────────────────────

function unavailable(prefix: string, e: unknown) {
  const message = (e as Error)?.message ?? String(e);
  return {
    found: false,
    reason: message.startsWith('safe_') ? message.split(':')[0] : `${prefix}_unavailable`,
    detail: message,
    hint: 'safe.gov.cn did not answer as expected, or its page layout changed since this pack was verified (2026-09-07). Retry once; if it persists the site structure likely moved.',
    source: SOURCE_NAME,
  };
}

function intArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const n = Number(args[key]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// ── tool definitions ─────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'china_fx_reserves',
    description:
      "China's official reserve assets (官方储备资产) by month, from SAFE's English site: headline FX reserves " +
      '(外汇储备), IMF reserve position, SDR holdings, gold (value + ounces), other reserve assets, and the total. ' +
      'MONTHLY data, published roughly one week after month-end (verified 2026-09-07: August 2026 reserves — ' +
      'USD 3,438.325bn FX reserves, USD 3,854.885bn total — were the newest data, published 2026-09-07). ' +
      'Values in 100-million USD/SDR as SAFE publishes them, plus a convenience *_usd_billion field for the two ' +
      'headline totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        months: { type: 'integer', description: 'How many of the most recent months to return (default 12, max 24).' },
      },
      required: [],
    },
  },
  {
    name: 'china_balance_of_payments',
    description:
      "China's quarterly balance of payments (国际收支平衡表) from SAFE's English site — current account " +
      '(goods, services, primary/secondary income), capital and financial account, reserve-assets change, and net ' +
      'errors and omissions. QUARTERLY, with roughly a 3-month lag after quarter-end (verified 2026-09-07: latest ' +
      'available quarter was 2026Q1, published 2026-06-26 — this is the standard BPM6 release cadence, not a stale ' +
      'site; Q2 2026 was not yet due). Sign convention for the financial account: a positive value for assets is a ' +
      'net DECREASE, negative is a net INCREASE (SAFE\'s own footnote).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        quarters: { type: 'integer', description: 'How many of the most recent quarters to return (default 8, max 40).' },
        currency: { type: 'string', description: 'Reporting currency: "usd" (default), "rmb", or "sdr".' },
      },
      required: [],
    },
  },
  {
    name: 'china_external_debt',
    description:
      "China's gross external debt position by sector (外债, since 2014Q4) from SAFE's English site — total, by " +
      'maturity (short-term/long-term, on an original-contract basis), and by institutional sector (general ' +
      'government, central bank, other depository corporations, other sectors, direct-investment intercompany ' +
      'lending). QUARTERLY, roughly a 3-month lag after quarter-end (verified 2026-09-07: latest was 2026Q1, ' +
      'published 2026-06-26 — same normal BPM6 cadence as the balance-of-payments release). Values in 100-million USD.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        quarters: { type: 'integer', description: 'How many of the most recent quarters to return (default 8, max 40).' },
      },
      required: [],
    },
  },
  {
    name: 'china_safe_releases',
    description:
      'Lists the actual publish dates of SAFE\'s reserves/BOP/external-debt English pages, straight from each ' +
      "page's own PubDate metadata and its attached file's upload timestamp — NOT the article's permalink date, " +
      'which is frequently years stale (SAFE republishes data in place at old URLs; a 2026 reserves table can sit ' +
      'at a 2021-dated link). Use this to check how current the other three tools\' data is before citing it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'integer', description: 'Max releases to return (default 6, max 15).' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'china_fx_reserves': {
      const months = intArg(args, 'months', 12, 24);
      try {
        const d = await reservesDataset();
        const slice = d.months.slice(-months);
        return {
          found: true,
          source: SOURCE_NAME,
          source_urls: d.sourcePages.map((p) => p.pageUrl).filter(Boolean),
          latest_month: slice[slice.length - 1]?.month ?? null,
          cadence: 'monthly, ~1 week lag after month-end',
          months: slice,
        };
      } catch (e) {
        return unavailable('china_fx_reserves', e);
      }
    }
    case 'china_balance_of_payments': {
      const quarters = intArg(args, 'quarters', 8, 40);
      const currencyRaw = String(args.currency ?? 'usd').toLowerCase();
      const currency = ['usd', 'rmb', 'sdr'].includes(currencyRaw) ? currencyRaw : 'usd';
      try {
        const d = await bopDataset(currency);
        const qs = d.order.slice(-quarters);
        return {
          found: true,
          source: SOURCE_NAME,
          source_url: d.pageUrl,
          published: d.pubDate,
          currency,
          unit: currency === 'rmb' ? '100 million RMB' : currency === 'sdr' ? '100 million SDR' : '100 million USD',
          cadence: 'quarterly, ~3 month lag after quarter-end (standard BPM6 release schedule)',
          latest_quarter: qs[qs.length - 1] ?? null,
          quarters: qs.map((q) => ({ quarter: q, ...d.quarters[q] })),
        };
      } catch (e) {
        return unavailable('china_balance_of_payments', e);
      }
    }
    case 'china_external_debt': {
      const quarters = intArg(args, 'quarters', 8, 40);
      try {
        const d = await extDebtDataset();
        const slice = d.quarters.slice(-quarters);
        return {
          found: true,
          source: SOURCE_NAME,
          source_url: d.pageUrl,
          published: d.pubDate,
          unit: '100 million USD',
          cadence: 'quarterly, ~3 month lag after quarter-end (standard BPM6 release schedule)',
          latest_quarter: slice[slice.length - 1]?.quarter ?? null,
          quarters: slice,
        };
      } catch (e) {
        return unavailable('china_external_debt', e);
      }
    }
    case 'china_safe_releases': {
      const limit = intArg(args, 'limit', 6, 15);
      try {
        const [reservesIdx, bopIdx, extdebtIdx] = await Promise.all([
          fetchText(INDEX_RESERVES),
          fetchText(INDEX_BOP),
          fetchText(INDEX_EXTDEBT),
        ]);
        const now = new Date().getUTCFullYear();
        const reserveLinks = findLinks(reservesIdx, /^Official Reserve Assets \(\d{4}\)$/)
          .filter((l) => {
            const y = Number(/\((\d{4})\)/.exec(l.text)?.[1]);
            return y >= now - 2;
          })
          .map((l) => ({ category: 'Official Reserve Assets', ...l }));
        const bopLinks = findLinks(bopIdx, /time-series data of Balance of Payments/i).map((l) => ({
          category: 'Balance of Payments',
          ...l,
        }));
        const extdebtLinks = findLinks(extdebtIdx, /Gross External Debt Position by Sector/i).map((l) => ({
          category: 'External Debt',
          ...l,
        }));
        // Interleave categories first so a small `limit` still returns one
        // of each, rather than exhausting itself on the 3 reserve-year links.
        const candidates = [...bopLinks, ...extdebtLinks, ...reserveLinks].slice(0, limit);
        const releases = await Promise.all(
          candidates.map(async (c) => {
            const pageUrl = abs(c.href);
            try {
              const { meta } = await fetchArticle(pageUrl);
              return {
                category: c.category,
                title: meta.title ?? c.text,
                published: meta.pubDate,
                page_url: pageUrl,
                xlsx_url: meta.xlsxUrl,
                pdf_url: meta.pdfUrl,
              };
            } catch (e) {
              return {
                category: c.category,
                title: c.text,
                published: null,
                page_url: pageUrl,
                error: (e as Error).message,
              };
            }
          }),
        );
        releases.sort((a, b) => ((b.published ?? '') < (a.published ?? '') ? -1 : 1));
        return {
          found: releases.length > 0,
          source: SOURCE_NAME,
          note:
            "Each article's permalink URL is fixed at first creation and can be years old — 'published' above is " +
            "the page's own PubDate metadata, which is what actually changes when SAFE updates the data.",
          releases,
        };
      } catch (e) {
        return unavailable('china_safe_releases', e);
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
