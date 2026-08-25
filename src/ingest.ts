/**
 * Source ingestion.
 *
 * The free plan allows 10ms CPU per invocation, and this is the only CPU-heavy
 * work in the loop. Every choice here is about staying under that:
 *   - HTMLRewriter (native streaming Rust) instead of regex over a giant string
 *   - hard caps on both bytes fetched and characters collected
 *   - fixed-length slicing for chunking, no backtracking regex
 * See README §4.2. Measure before trusting.
 */

/** Max characters of extracted text kept per source. Bounds the final join cost. */
const MAX_TEXT_CHARS = 60_000;

/**
 * CPU-safety cap for the HTML path only, enforced against bytes actually
 * streamed through HTMLRewriter — not the declared `Content-Length`, which
 * chunked responses often omit or understate. MAX_TEXT_CHARS does not bound
 * this cost: it stops `parts.push()`, not the parser, which keeps consuming
 * the rest of the body regardless.
 *
 * Measured (bugs.md #15, `wrangler tail --format json` cpuTime): a 1.84MB
 * page cost 241ms, three other large pages ~20ms, a 70KB page 11ms — against
 * a 10ms Free-plan ceiling. The runtime kills the isolate mid-parse on that
 * limit; it is not a catchable JS exception, so the only fix is to never
 * start parsing a body that could get there. Capped well under the 70KB
 * point that was already over, not at it.
 */
const MAX_HTML_BYTES = 40_000;

/** Content-bearing elements. Everything else contributes no text. */
const CONTENT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, dd, dt';

/** Stripped before text extraction — boilerplate and non-prose. */
const DROP_SELECTOR = 'script, style, noscript, svg, iframe, nav, footer, header, aside, form';

/** Max links harvested per page. Bounds CPU and the dedupe set. */
const MAX_LINKS = 120;

export interface Extracted {
  text: string;
  bytes: number;
  truncated: boolean;
  contentType: string;
  /**
   * Links that ACTUALLY EXIST on this page, normalised and absolute.
   * The model is only allowed to propose next-sources from this set — asking it
   * to invent URLs produced ~40% fabricated domains (bugs.md #12).
   */
  links: string[];
}

/**
 * Canonical form for comparison and dedupe: lowercase host, no `www.`, no
 * fragment, no tracking params, no trailing slash. Without this,
 * `smallbizai.au/` and `www.smallbizai.au` queue as two distinct sources.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(p)) u.searchParams.delete(p);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export async function fetchSource(url: string, maxBytes: number): Promise<Extracted> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'cf-research-loop/1.0 (+https://developers.cloudflare.com/workers/)',
      accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const contentType = res.headers.get('content-type') ?? '';

  // Reject oversized bodies before doing any parsing work at all.
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new Error(`source too large: ${declared} bytes > ${maxBytes} cap`);
  }

  // Plain text and JSON need no parsing — the expensive path is HTML only.
  if (!contentType.includes('html')) {
    const raw = await res.text();
    const truncated = raw.length > MAX_TEXT_CHARS;
    return {
      text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
      bytes: raw.length,
      truncated,
      contentType,
      links: [],
    };
  }

  // Same check as above, tightened to the HTML-specific ceiling — catches
  // the common case cheaply when the server does send a Content-Length.
  if (declared > MAX_HTML_BYTES) {
    throw new Error(`source too large: ${declared} bytes > ${MAX_HTML_BYTES} HTML cap`);
  }

  const parts: string[] = [];
  const links = new Set<string>();
  let total = 0;
  let truncated = false;

  const rewritten = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        if (links.size >= MAX_LINKS) return;
        const href = el.getAttribute('href');
        if (!href) return;
        const abs = normalizeUrl(href, res.url || url);
        if (abs) links.add(abs);
      },
    })
    .on(DROP_SELECTOR, {
      element(el) {
        el.remove();
      },
    })
    .on(CONTENT_SELECTOR, {
      text(t) {
        if (total >= MAX_TEXT_CHARS) {
          truncated = true;
          return;
        }
        const s = t.text;
        if (s.length > 0) {
          parts.push(s);
          total += s.length;
        }
        // Block boundary — keep sentences from fusing across elements.
        if (t.lastInTextNode) {
          parts.push('\n');
          total += 1;
        }
      },
    })
    .transform(res);

  // Handlers only fire as the body streams; consuming it drives extraction.
  // Capped live: a server that sends no Content-Length (or understates one
  // on a chunked response) must not be able to run HTMLRewriter past the
  // point a declared header would have caught.
  const bytes = await drain(rewritten.body, MAX_HTML_BYTES);

  return {
    text: denoise(normalize(parts.join(''))),
    bytes,
    truncated,
    contentType,
    links: [...links],
  };
}

/**
 * Drop navigation boilerplate that survives element removal — language
 * switchers, category menus, and link lists live in bare <li>/<p> outside any
 * <nav>, so selectors alone don't catch them.
 *
 * Heuristic: prose lines are either long or end in sentence punctuation. Nav
 * items are short fragments ("Deutsch", "Zero Trust"). This costs one pass over
 * an already-bounded string.
 *
 * Trade-off: short headings are dropped too. Body text carries the meaning, and
 * embedding a menu is strictly worse than losing a heading.
 */
function denoise(text: string): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.length === 0) continue;
    if (l.length >= 30 || /[.!?:;]$/.test(l)) kept.push(l);
  }
  return kept.join('\n');
}

/**
 * Consume a stream without materialising it, returning byte count.
 *
 * With `cap` set, cancels the reader and throws as soon as cumulative bytes
 * exceed it — bounding CPU spent pulling a transform (e.g. HTMLRewriter)
 * through the rest of a body that a declared Content-Length either didn't
 * cover or wasn't sent at all. Exported so the cap logic is testable without
 * the Workers-only HTMLRewriter global (bugs.md #15).
 */
export async function drain(body: ReadableStream | null, cap?: number): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (cap !== undefined && bytes > cap) {
      await reader.cancel();
      throw new Error(`source too large: exceeded ${cap} byte HTML cap while streaming`);
    }
  }
  return bytes;
}

/** Collapse runs of whitespace. Bounded input, so this regex is safe. */
function normalize(s: string): string {
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * The prefix of a source carried into the prompt, bounded by CHARACTERS rather
 * than by a chunk count.
 *
 * A count was the wrong unit. On an RSS feed — newest-first — "first 6 chunks"
 * is a newest-N window that shrinks as the feed grows, so a source small enough
 * to show in full was still being cut: Startup Daily is 14,762 chars across 11
 * chunks and the loop read 8,400 of them. Four posts arriving on 2026-08-14
 * pushed the agtech/biotech evidence past the cut and goal 1 went Answered ->
 * Unanswered while those facts sat in the feed and in Vectorize, measured at
 * 0/8 against 3/3 once the whole feed was shown.
 *
 * A budget says the useful thing instead: show the source WHOLE when it fits,
 * and bound the prompt when it does not. Always returns at least one chunk —
 * a source larger than the budget must still contribute something.
 */
export function freshExcerpts(pieces: string[], budget: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (const piece of pieces) {
    if (out.length > 0 && total + piece.length > budget) break;
    out.push(piece);
    total += piece.length;
  }
  return out;
}

/**
 * Fixed-length slicing with overlap. Deliberately dumb: no sentence detection,
 * no lookaround regex. Overlap keeps facts from being split across a boundary.
 */
export function chunk(text: string, size = 1400, overlap = 160): string[] {
  if (text.length <= size) return text.length > 0 ? [text] : [];

  const out: string[] = [];
  const stride = size - overlap;
  for (let i = 0; i < text.length; i += stride) {
    const piece = text.slice(i, i + size);
    if (piece.trim().length > 50) out.push(piece);
    if (i + size >= text.length) break;
  }
  return out;
}

/**
 * Next-source selection, grounded in observed links.
 *
 * The model proposes URLs; we keep only those that were actually present on a
 * page we fetched. Syntax validation alone is not enough — `australianstartup.org`
 * is valid syntax and does not exist. Run 19ac529b spent ~40% of its fetch budget
 * on invented domains (bugs.md #12).
 *
 * `observed` empty (e.g. a plain-text source has no links) means nothing is
 * enqueued from that iteration, which is the safe default.
 */
export function selectNextSources(
  proposed: unknown,
  observed: string[],
  limit = 3,
): { accepted: string[]; rejected: string[] } {
  if (!Array.isArray(proposed)) return { accepted: [], rejected: [] };

  const allowed = new Set(observed);
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const raw of proposed) {
    if (typeof raw !== 'string') continue;
    const norm = normalizeUrl(raw);
    if (!norm) {
      rejected.push(String(raw));
      continue;
    }
    if (!allowed.has(norm)) {
      rejected.push(norm); // fabricated, or not on any page we read
      continue;
    }
    if (accepted.includes(norm) || accepted.length >= limit) continue;
    accepted.push(norm);
  }
  return { accepted, rejected };
}
