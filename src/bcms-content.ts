// @bettercms-ai/convert helper v20
// Values come from bcms-content/*.json, written into the tree before the build. The committed
// stubs are {} — a build with them renders every fallback below and still succeeds.
import layoutSnapshot from "../bcms-content/layout.json";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Dotted keys and `[n]` indices, positionally — the editor's own path grammar. */
function readPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (!segment) return undefined;
    const key = segment.replace(/\[\d+\]/g, "");
    if (key) {
      if (!isRecord(cursor)) return undefined;
      cursor = cursor[key];
    }
    for (const index of segment.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[Number(index[1])];
    }
  }
  return cursor;
}

/**
 * A repository image path — `@/images/x.avif`, `~/assets/x.png`, `../assets/x.jpg`, `/src/x.png`.
 * The bundler resolves one at build and nothing else can, so as a value it is never rendered: the
 * template's own fallback (the picture the build already imported) shows instead of a broken image.
 */
const REPO_IMAGE_PATH = /^(?:@[\w-]*|~|\.{1,2}|\/?src)\/[^\s?#"'<>]*\.(?:avif|png|jpe?g|webp|gif|svg|bmp|ico|tiff?|jxl|heic)(?:[?#]\S*)?$/i;

/** A stored value as a template renders it: richtext is its html, an image is its url. */
function render(value: unknown): string | undefined {
  if (typeof value === "string") return REPO_IMAGE_PATH.test(value.trim()) ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) {
    if (typeof value.html === "string") return value.html;
    if (typeof value.url === "string") return value.url;
    // A V2 link value ({ type, href, ... }): its href is what the template renders.
    if (typeof value.href === "string") return value.href;
  }
  return undefined;
}

/**
 * The PUBLISHED copy, on a server BetterCMS hosts — read at request time, not at build time.
 *
 * BetterCMS keeps one file current for a running server app (`BCMS_CONTENT_FILE`, the same
 * bcms-content.json the build was given) and rewrites it on every publish, so a server-rendered
 * page shows a publish within seconds instead of after a rebuild. Each snapshot this module reads
 * resolves to its live counterpart: the shared layout by identity, a page by its `slug`.
 *
 * Nowhere else does anything change: with no variable (a build, `astro dev`, a browser, an edge
 * runtime) every snapshot is the one the bundle imported, exactly as before. A file that cannot be
 * read keeps the last good copy. Its modification time is asked on EVERY read (a stat, microseconds;
 * the file is parsed again only when it changed), so a publish shows on the very next request.
 */
type BcmsLiveContent = {
  helper: string;
  stamp: number;
  bySlug: Map<string, unknown>;
  entries: Record<string, unknown>;
  layout: unknown;
  /** Each published page's `fieldStyles`, by its slug; null for a page that styles no field. */
  fieldStyles: Map<string, unknown>;
};
let bcmsLive: BcmsLiveContent | null = null;

function liveContent(): BcmsLiveContent | null {
  const proc = (globalThis as {
    process?: { env?: Record<string, string | undefined>; getBuiltinModule?: (id: string) => unknown };
  }).process;
  const file = proc?.env?.BCMS_CONTENT_FILE;
  if (!file || typeof proc?.getBuiltinModule !== "function") return null;
  try {
    const fs = proc.getBuiltinModule("node:fs") as {
      statSync(path: string): { mtimeMs: number };
      readFileSync(path: string, encoding: "utf8"): string;
    };
    const stamp = fs.statSync(file).mtimeMs;
    if (bcmsLive && bcmsLive.stamp === stamp) return bcmsLive;
    const snapshot: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const bySlug = new Map<string, unknown>();
    const collections = isRecord(snapshot) && isRecord(snapshot.collections) ? snapshot.collections : {};
    for (const rows of Object.values(collections)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        // A published row carries its values under `data` (the delivery API's shape); the snapshot a
        // template reads is the values themselves. Read flat, as before, where a row has none.
        if (isRecord(row) && typeof row.slug === "string" && !bySlug.has(row.slug)) {
          bySlug.set(row.slug, isRecord(row.data) ? { ...row.data, slug: row.slug } : row);
        }
      }
    }
    // A dynamic route reads `page.entries[slug]`: every published row, by its slug.
    const entries: Record<string, unknown> = Object.fromEntries(bySlug);
    for (const row of bySlug.values()) if (isRecord(row) && !("entries" in row)) row.entries = entries;
    const pages = isRecord(snapshot) && Array.isArray(snapshot.pages) ? snapshot.pages : [];
    const withLayout = pages.find((page: unknown) => isRecord(page) && isRecord(page.layout));
    // The site's Layout first; a page's own (its overrides resolved in) only where there is no other.
    const delivered = isRecord(snapshot) && isRecord(snapshot.layout) ? snapshot.layout : isRecord(withLayout) ? withLayout.layout : undefined;
    // A template addresses a Layout value as `<section id>:<field id>`; the published Layout holds
    // each Section's values under `sections.<slug>.fields`. Both spellings are answered.
    const layout: Record<string, unknown> | undefined = isRecord(delivered) ? { ...delivered } : undefined;
    for (const section of layout && isRecord(delivered) && isRecord(delivered.sections) ? Object.values(delivered.sections) : []) {
      if (!isRecord(section) || typeof section.id !== "string" || !isRecord(section.fields)) continue;
      for (const [field, value] of Object.entries(section.fields)) layout![section.id + ":" + field] = value;
    }
    // A page's field styles live on its `pages[]` row, not on the values a template reads. A row
    // without the key styles no field: that is an answer too, never a reason to read the build's.
    const fieldStyles = new Map<string, unknown>();
    for (const page of pages) {
      if (isRecord(page) && typeof page.slug === "string" && !fieldStyles.has(page.slug)) {
        fieldStyles.set(page.slug, isRecord(page.fieldStyles) ? page.fieldStyles : null);
      }
    }
    // `helper` names this reader in the built bundle: the platform reads it to know the app shows a
    // publish on its next request, and an image BetterCMS copied beside it (@see bcmsImage).
    bcmsLive = { helper: "bcms-helper@20", stamp, bySlug, entries, layout, fieldStyles };
  } catch {
    // Unreadable, or caught mid-write: keep serving the last good copy.
  }
  return bcmsLive;
}

/** The published counterpart of a snapshot this module was handed, or the snapshot itself. */
function live(page: unknown): unknown {
  const content = liveContent();
  if (!content) return page;
  if (page === layoutSnapshot) return isRecord(content.layout) ? content.layout : page;
  if (isRecord(page) && typeof page.slug === "string") {
    // A collection's page has no row of its own: its entries are the published ones all the same.
    return content.bySlug.get(page.slug) ?? ("entries" in page ? page : { ...page, entries: content.entries });
  }
  return page;
}

/** One field of one page. `slug` selects the entry on a dynamic route. */
export function bcms(page: unknown, path: string, fallback: string, slug?: string): string {
  page = live(page);
  const entries = isRecord(page) ? page.entries : undefined;
  const root = slug !== undefined && isRecord(entries) ? entries[slug] : page;
  return render(readPath(root, path)) ?? fallback;
}

/** One field of the shared layout — the header and footer every route renders. */
export function bcmsLayout(path: string, fallback: string): string {
  const layout = live(layoutSnapshot);
  // The whole address first: a field id may carry a dot of its own (`derived.nav-cta`).
  const whole = isRecord(layout) ? layout[path] : undefined;
  return render(whole !== undefined ? whole : readPath(layout, path)) ?? fallback;
}

/**
 * The ROWS of a repeater. `fallback` is every row the template shipped with, so a build against
 * an empty snapshot still renders the same number of cards it always did.
 */
export function bcmsRows<T>(page: unknown, path: string, fallback: T[], slug?: string): T[] {
  page = live(page);
  const entries = isRecord(page) ? page.entries : undefined;
  const root = slug !== undefined && isRecord(entries) ? entries[slug] : page;
  const value = readPath(root, path);
  return Array.isArray(value) ? (value as T[]) : fallback;
}

/**
 * The rows of a repeater whose template renders its OWN property names.
 *
 * 🔴 A ROW IS MORE THAN ITS COPY. The template's array carries `tone`, `link`, an icon — styling
 * the brief never heard of, because the CMS holds the four sentences and not the class names. So a
 * CMS row is merged OVER the row the template shipped with rather than replacing it, and `keys`
 * says which template property each CMS leaf lands on. A row an editor ADDS has no counterpart, so
 * it inherits row 0's styling — the only answer that renders at all.
 */
export function bcmsRowsAs<T>(
  page: unknown,
  path: string,
  fallback: T[],
  keys: Record<string, string>,
  slug?: string,
): T[] {
  const rows = bcmsRows<unknown>(page, path, [], slug);
  if (rows.length === 0) return fallback;
  return rows.map((row, index) => {
    const base = { ...(fallback[index] ?? fallback[0] ?? {}) } as Record<string, unknown>;
    for (const property of Object.keys(keys)) {
      const value = render(readPath(row, keys[property] as string));
      if (value !== undefined) base[property] = value;
    }
    return base as T;
  });
}

/**
 * A list of PRIMITIVES — `const tags = ["…", "…"]` — with one CMS field per ELEMENT.
 *
 * 🔴 THE LENGTH IS `paths`, NOT THE CMS. Unlike `bcmsRows`, which reads the array itself and
 * renders as many rows as the CMS holds, this maps over the path list the codemod wrote — so a row
 * an editor ADDS has no path here and never renders, and a row an editor DELETES leaves its path
 * resolving to nothing, which falls back to the copy the template shipped with. Every row's TEXT is
 * editable; the number of rows is the template's. @see the PRIMITIVE_LIST receipt note, which says
 * this out loud rather than leaving an editor to discover it.
 */
export function bcmsList(page: unknown, paths: string[], fallback: string[], slug?: string): string[] {
  page = live(page);
  const entries = isRecord(page) ? page.entries : undefined;
  const root = slug !== undefined && isRecord(entries) ? entries[slug] : page;
  return paths.map((path, index) => render(readPath(root, path)) ?? fallback[index] ?? "");
}

/**
 * The same for a list of TUPLES — `[["q", "a"], …]` — with one field per tuple POSITION, and the
 * same ceiling: `paths` decides how many rows render, and an added or deleted CMS row does not.
 */
export function bcmsTuples(page: unknown, paths: string[][], fallback: string[][], slug?: string): string[][] {
  return paths.map((row, index) => bcmsList(page, row, fallback[index] ?? [], slug));
}

/**
 * An image field's url, or the asset the template already imports. @see IMAGE_ASSET_UNRESOLVED
 *
 * 🔴 AN IMPORTED ASSET IS KEPT AT BUILD. `<Image src={…}>` from `astro:assets` refuses a remote
 * url string without width, height and an allowed domain, so returning the CMS url here broke the
 * build the moment an editor replaced the image. The build renders the optimised import; the
 * release write (`writeImage`) puts the editor's image on the `data-bcms-field` element, which
 * is where every published value lands. A plain string fallback (`<img src="/hero.png">`) has
 * no such rule and takes the CMS url directly.
 *
 * 🔴 ON A HOSTED SERVER THE EDITOR'S IMAGE IS A LOCAL FILE. A page the app renders per request has no
 * release write: what this returns is the page. BetterCMS copies a replaced image beside the app and
 * names the copy on the published value (`local`, with its size), and it is returned in the shape
 * of an import (`{ src, width, height, format }`), so `<Image>` optimises it like the site's own.
 * Absent (a build, or the site's own picture) the import stands.
 */
export function bcmsImage<T>(page: unknown, path: string, fallback: T, slug?: string): T | string {
  page = live(page);
  const entries = isRecord(page) ? page.entries : undefined;
  const root = slug !== undefined && isRecord(entries) ? entries[slug] : page;
  const value = readPath(root, path);
  if (fallback !== null && typeof fallback === "object") {
    if (!isRecord(value) || typeof value.local !== "string" || typeof value.width !== "number" || typeof value.height !== "number") return fallback;
    const format = /\.([a-z0-9]+)$/i.exec(value.local)?.[1]?.toLowerCase() ?? "";
    return { src: value.local, width: value.width, height: value.height, format: format === "jpg" ? "jpeg" : format } as unknown as T;
  }
  return render(value) ?? fallback;
}

/**
 * ONE SECTION's copy, for a component extracted by `--componentize`.
 *
 * OVERRIDES FIRST, PER KEY: `overrides[key] ?? group[key]`. An instance that owns its copy
 * (Phase B) carries an override for every prop it declares, so the group underneath it is never
 * read; a placement still bound to a page field group (Phase A) carries none, so the group is all
 * there is. The interesting case is the one in between — a section half moved — where a key the
 * instance does not hold has to keep rendering the page's value rather than nothing.
 *
 * 🔴 `??`, NOT `||`. An empty string is a value an editor typed, and treating it as absent put
 * the page's old copy back into a heading somebody had deliberately cleared.
 *
 * With neither an override nor a group, the answer is `{}` and every `bcms(...)` below renders
 * the fallback the template shipped with — which is why a section renders correctly against the
 * committed `{}` stub.
 */
export function bcmsSection(
  page: unknown,
  bind?: string,
  overrides?: unknown,
  bindPaths?: Record<string, string>,
): Record<string, unknown> {
  page = live(page);
  const group = bind ? readPath(page, bind) : undefined;
  const base: Record<string, unknown> = isRecord(group) ? { ...group } : {};
  // A locale copy on its twin's component spells its fields its own way: each prop's copy is
  // read from the path the placement names for it.
  if (bind && isRecord(bindPaths)) {
    for (const [key, path] of Object.entries(bindPaths)) base[key] = readPath(page, path);
  }
  if (!isRecord(overrides)) return base;
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    /**
     * 🔴 A TABLE PROP IS STORED AS `{ rows: [...] }` AND READ AS A LIST. That is the shape the
     * dashboard edits a repeater in; handing it to `bcmsRows` unchanged is not an array, so the
     * helper fell back to the rows the template shipped with and the editor's work never showed.
     */
    base[key] = isRecord(value) && Array.isArray(value.rows) ? value.rows : value;
  }
  return base;
}

/**
 * WHICH ADDRESS one bound element declares — decided at RENDER time, from the placement.
 *
 * An element carries exactly ONE `data-bcms-field`, and which lane it names depends on where its
 * copy lives. A placement that owns its copy declares the BLOCK lane —
 * `<blockId>__overrides.<propKey>` — because that is the address the editor commits an instance's
 * own value to. A placement bound to a page field group declares the PAGE path, which is what the
 * page form and the coverage meter already know.
 *
 * 🔴 THE BOUND ADDRESS IS RE-BASED ONTO **THIS** PLACEMENT'S GROUP. The markup was cut from ONE
 * page and carries that page's paths (`hero.title`); the whole point of `shapeHash` is that a
 * second page renders the same component bound to a group of its own (`bind="landingHero"`).
 * Handing the embedded path through unchanged declared `hero.title` on a page whose field is
 * `landingHero.title` — an address that page does not have, so the editor wrote into nothing and
 * the meter counted a binding that was never there. The prefix the markup was cut with comes out,
 * the placement's own group goes in.
 *
 * 🔴 THE SAME EXTRACTED FILE SERVES BOTH LANES. The choice is a function of the props, never of
 * how the codemod ran: one component renders a Phase A placement on one page and a Phase B
 * instance on the next, and a repository does not have to be re-cut when its copy moves.
 */
/** How a flat field family maps page paths to an instance's override keys. @see bcmsSectionPaths */
export type BcmsPathMap = {
  scalars?: Record<string, string>;
  tables?: Record<string, { key: string; columns: Record<string, string> }>;
};

/**
 * The snapshot for a section whose page fields are a FLAT family (`wrap-h2-latest`, not `wrap.h2_latest`).
 *
 * `bcmsSection` returns a group object read through a dotted path, which a flat family does not have: its
 * copy lives in top-level keys of the page snapshot. So this answers in the page's own spelling — the
 * markup reads `bcms(snapshot, "wrap-h2-latest", …)` verbatim — with every mapped path set explicitly:
 *
 * - the instance's override for that key when it holds one (a table's rows re-spelled with the page's
 *   column names, `{ rows }` unwrapped as in `bcmsSection`);
 * - else, for a placement bound to a group, the page value at the path re-based onto that group;
 * - else NOTHING — a placement that owns its copy never falls back to the page's stale copy, exactly as
 *   `bcmsSection` synthesizes no group for it.
 *
 * Every other page key passes through, so reads outside the family (a shared link) keep working.
 */
export function bcmsSectionPaths(
  page: unknown,
  bind: string | undefined,
  overrides: unknown,
  prefix: string,
  map: BcmsPathMap,
  bindPaths?: Record<string, string>,
): Record<string, unknown> {
  page = live(page);
  const out: Record<string, unknown> = isRecord(page) ? { ...page } : {};
  const own = isRecord(overrides) ? overrides : {};
  const separator = prefix.slice(-1);
  // A re-keyed locale copy names each prop's path on its own page; any other placement re-bases.
  const fromPage = (path: string, key: string): unknown =>
    !bind ? undefined
    : isRecord(bindPaths) && typeof bindPaths[key] === "string" ? readPath(page, bindPaths[key])
    : readPath(page, bind + separator + path.slice(prefix.length));
  for (const [path, key] of Object.entries(map.scalars ?? {})) {
    const value = own[key];
    out[path] = value !== undefined && value !== null ? value : fromPage(path, key);
  }
  for (const [path, table] of Object.entries(map.tables ?? {})) {
    const held = own[table.key];
    const rows = isRecord(held) && Array.isArray(held.rows) ? held.rows : held;
    if (!Array.isArray(rows)) {
      out[path] = fromPage(path, table.key);
      continue;
    }
    const pageColumn = new Map(Object.entries(table.columns).map(([column, key]) => [key, column]));
    out[path] = rows.map((row) => {
      if (!isRecord(row)) return row;
      const spelled: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) spelled[pageColumn.get(key) ?? key] = value;
      return spelled;
    });
  }
  return out;
}

export function bcmsFields(
  placement: { blockId?: string; bind?: string; overrides?: unknown; bindPaths?: Record<string, string> },
  pathPrefix: string,
  map?: BcmsPathMap,
): (path: string) => string {
  const id = placement.blockId;
  const own = typeof id === "string" && id !== "" && !placement.bind && isRecord(placement.overrides);
  /** A re-keyed locale copy's own path for a prop, with whatever follows the prop kept. */
  const moved = (key: string | undefined, rest: string): string | undefined => {
    const paths = placement.bind && isRecord(placement.bindPaths) ? placement.bindPaths : undefined;
    return key !== undefined && paths && typeof paths[key] === "string" ? paths[key] + rest : undefined;
  };
  /**
   * What replaces the prefix the markup was cut with, or null for "leave every path alone".
   *
   * Null covers a placement with neither a bind nor an instance — a shipped fallback, or a page
   * nobody has componentized yet — and a bound placement in a component whose prefix is EMPTY,
   * where the plan said the prop key IS the whole page path: there is no group segment to swap,
   * so prepending one would invent an address rather than correct it.
   */
  const lane = own ? `${id}__overrides.` : placement.bind && pathPrefix ? `${placement.bind}.` : null;
  if (map) {
    /**
     * A FLAT family: the address is not "prefix swapped". The instance lane names the override key the
     * plan allocated (`h2_latest`, `group_webgl[0].a_webgl`); the bind lane keeps the page's own
     * separator (`landing-h2-latest`, never `landing.h2-latest`).
     */
    const separator = pathPrefix.slice(-1);
    return (path: string): string => {
      if (!path.startsWith(pathPrefix) || !(own || placement.bind)) return path;
      const scalar = map.scalars?.[path];
      const row = /^([^[]+)\[(\d+)\]\.(.+)$/.exec(path);
      const table = row ? map.tables?.[row[1]] : undefined;
      if (!own) {
        return moved(scalar, "") ?? moved(table?.key, row ? "[" + row[2] + "]." + row[3] : "")
          ?? placement.bind + separator + path.slice(pathPrefix.length);
      }
      if (scalar !== undefined) return id + "__overrides." + scalar;
      const column = row && table ? table.columns[row[3]] : undefined;
      return table && column !== undefined ? id + "__overrides." + table.key + "[" + row![2] + "]." + column : path;
    };
  }
  return (path: string): string => {
    // A path outside the group this section was cut from is not one this placement re-addresses:
    // it names a key the instance does not hold and a group this placement is not bound to.
    // (An EMPTY prefix is a plan saying the prop key IS the page path, and matches everything.)
    if (lane === null || !path.startsWith(pathPrefix)) return path;
    const rest = path.slice(pathPrefix.length);
    const key = /^[^.[]+/.exec(rest)?.[0];
    return (own ? undefined : moved(key, rest.slice(key?.length ?? 0))) ?? lane + rest;
  };
}

/**
 * C3/C4 — a section's `block.style` as the inline CSS the BetterCMS SDK draws for it.
 *
 * A converted section root carries `data-bcms-style` beside `data-bcms-block`, which is the
 * site's promise to the editor that "this root's inline style is `blockStyleToCss(block.style)`"
 * — and the editor only offers a section's spacing handles where every stamped root makes it.
 * This is `blockStyleToCss` from `@bettercms-ai/types`, INLINED for the same reason `readPath`
 * is (zero dependencies); `helper.test.ts` runs it against the original over a token table.
 */
const STYLE_SPACE_PX: Record<string, string> = { none: "0", xs: "4px", sm: "8px", md: "16px", lg: "32px", xl: "64px" };
const STYLE_FONT_SIZE_REM: Record<string, string> = {
  sm: "0.875rem",
  base: "1rem",
  lg: "1.25rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "2.25rem",
  "4xl": "3rem",
  "5xl": "4rem",
};
const STYLE_WEIGHT: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };
const STYLE_RADIUS_PX: Record<string, string> = { none: "0", sm: "4px", md: "8px", lg: "16px", full: "9999px" };
const STYLE_COLOR_HEX: Record<string, string> = { white: "#ffffff", black: "#111111", muted: "#6b7280", mutedBg: "#f3f4f6", primary: "#111111", accent: "#4f46e5" };
const STYLE_SPACE_TOKEN_PX: Record<string, string> = {
  "section-space-none": "0px",
  "section-space-xsmall": "16px",
  "section-space-small": "32px",
  "section-space-medium": "56px",
  "section-space-large": "88px",
  "section-space-xlarge": "128px",
  "section-space-nav-overlap": "-72px",
  "space-none": "0px",
  "space-s": "8px",
  "space-m": "16px",
  "space-l": "32px",
  "space-xl": "64px",
};

const STYLE_THEME: Record<string, { colorScheme: string; background: string; color: string }> = {
  light: { colorScheme: "light", background: "#ffffff", color: "#111111" },
  dark: { colorScheme: "dark", background: "#0b0b0d", color: "#f7f8f8" },
};
const STYLE_BG: Record<string, string> = {
  surface: "var(--bcms-bg-surface,#ffffff)",
  muted: "var(--bcms-bg-muted,#f3f4f6)",
  accent: "var(--bcms-bg-accent,#4f46e5)",
  dark: "var(--bcms-bg-dark,#0b0b0d)",
};
const STYLE_DARK_BG: Record<string, string> = { surface: "#0b0b0d", muted: "#1c1c1e" };
const STYLE_FILL_SCHEME: Record<string, { colorScheme: string; color: string }> = {
  dark: { colorScheme: "dark", color: "#f7f8f8" },
  accent: { colorScheme: "var(--bcms-accent-scheme,dark)", color: "var(--bcms-on-accent,#ffffff)" },
};
const STYLE_CORNER_PX: Record<string, string> = { "0": "0", s: "4px", m: "8px", l: "16px", xl: "24px", "2xl": "32px" };
const STYLE_SHADOW: Record<string, string> = {
  "0": "none",
  s: "0 1px 2px rgba(0,0,0,.06)",
  m: "0 4px 12px rgba(0,0,0,.08)",
  l: "0 10px 24px rgba(0,0,0,.10)",
  xl: "0 24px 48px rgba(0,0,0,.14)",
};
const STYLE_HAIRLINE = "1px solid rgba(0,0,0,.10)";

/** A map entry by OWN key only, so a token like `constructor` never reaches CSS. */
function styleOwn<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** An http(s) or root-relative url with nothing that could end `url(…)`; "" for anything else. */
function styleSafeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const url = raw.trim();
  if (!url || url.length > 2000) return "";
  if (/["'()\;]|\s/.test(url)) return "";
  if (url.startsWith("//")) return "";
  if (url.startsWith("/")) return url;
  return /^https?:\/\//i.test(url) ? url : "";
}

function styleClamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function styleSpaceToken(token: unknown): string {
  const px = typeof token === "string" ? STYLE_SPACE_TOKEN_PX[token] : undefined;
  return px ? "var(--bcms-" + token + "," + px + ")" : "";
}

/** The declarations as a React-style object (camelCase), or undefined when there are none. */
export function bcmsSectionStyle(style: unknown): Record<string, string | number> | undefined {
  if (!style || typeof style !== "object") return undefined;
  const s = style as Record<string, string>;
  const css: Record<string, string | number> = {};
  if (s.paddingY && STYLE_SPACE_PX[s.paddingY] != null) { css.paddingTop = STYLE_SPACE_PX[s.paddingY]!; css.paddingBottom = STYLE_SPACE_PX[s.paddingY]!; }
  if (s.paddingX && STYLE_SPACE_PX[s.paddingX] != null) { css.paddingLeft = STYLE_SPACE_PX[s.paddingX]!; css.paddingRight = STYLE_SPACE_PX[s.paddingX]!; }
  const top = styleSpaceToken(s.spaceTop);
  // A negative band that pulls content under the nav makes sense at the TOP only (SPACE_BOTTOM_TOKENS).
  const bottom = /^section-space-(none|xsmall|small|medium|large|xlarge)$/.test(String(s.spaceBottom)) ? styleSpaceToken(s.spaceBottom) : "";
  const sidesVar = styleSpaceToken(s.spaceSides);
  // A section step on the sides never renders under 16px (V2); an old space-* step is unchanged.
  const sides = sidesVar && /^section-space-(none|xsmall|small|medium|large|xlarge)$/.test(String(s.spaceSides)) ? `max(16px,${sidesVar})` : sidesVar;
  const navOverlap = s.spaceTop === "section-space-nav-overlap";
  if (top && !navOverlap) css.paddingTop = top;
  if (bottom) css.paddingBottom = bottom;
  if (sides) { css.paddingLeft = sides; css.paddingRight = sides; }
  if (s.marginTop && STYLE_SPACE_PX[s.marginTop] != null) css.marginTop = STYLE_SPACE_PX[s.marginTop]!;
  if (top && navOverlap) { css.marginTop = top; css.paddingTop = "calc(-1 * " + top + ")"; }
  if (s.marginBottom && STYLE_SPACE_PX[s.marginBottom] != null) css.marginBottom = STYLE_SPACE_PX[s.marginBottom]!;
  if (s.background && STYLE_COLOR_HEX[s.background]) css.background = STYLE_COLOR_HEX[s.background]!;
  if (s.textColor && STYLE_COLOR_HEX[s.textColor]) css.color = STYLE_COLOR_HEX[s.textColor]!;
  if (s.align === "left" || s.align === "center" || s.align === "right") css.textAlign = s.align;
  if (s.fontSize && STYLE_FONT_SIZE_REM[s.fontSize]) css.fontSize = STYLE_FONT_SIZE_REM[s.fontSize]!;
  if (s.weight && STYLE_WEIGHT[s.weight] != null) css.fontWeight = STYLE_WEIGHT[s.weight]!;
  if (s.radius && STYLE_RADIUS_PX[s.radius] != null) css.borderRadius = STYLE_RADIUS_PX[s.radius]!;
  const radiusPx = (style as Record<string, unknown>).radiusPx;
  if (typeof radiusPx === "number" && Number.isFinite(radiusPx)) css.borderRadius = `${Math.min(96, Math.max(0, Math.round(radiusPx)))}px`;
  const theme = styleOwn(STYLE_THEME, s.theme);
  if (theme) { css.colorScheme = theme.colorScheme; css.background = theme.background; css.color = theme.color; }
  if (s.bg === "custom") { if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.bgCustom ?? "")) css.background = s.bgCustom!; }
  else if (styleOwn(STYLE_BG, s.bg)) {
    css.background = (s.theme === "dark" && styleOwn(STYLE_DARK_BG, s.bg)) || styleOwn(STYLE_BG, s.bg)!;
    const fill = styleOwn(STYLE_FILL_SCHEME, s.bg);
    if (fill) { css.colorScheme = fill.colorScheme; css.color = fill.color; }
  }
  const bgImage = styleSafeUrl(s.bgImage);
  if (bgImage) { css.backgroundImage = "url(" + bgImage + ")"; css.backgroundSize = "cover"; css.backgroundPosition = "center"; }
  const n = style as Record<string, unknown>;
  if (!top && typeof n.paddingTop === "number") css.paddingTop = styleClamp(n.paddingTop, 0, 240) + "px";
  if (!bottom && typeof n.paddingBottom === "number") css.paddingBottom = styleClamp(n.paddingBottom, 0, 240) + "px";
  if (!sides && typeof n.paddingSides === "number") {
    const px = styleClamp(n.paddingSides, 0, 240) + "px";
    css.paddingLeft = px; css.paddingRight = px;
  }
  if (n.fullHeight === true) { css.minHeight = "100vh"; css.display = "flex"; css.flexDirection = "column"; css.justifyContent = "center"; }
  if (typeof n.opacity === "number") css.opacity = styleClamp(n.opacity, 0, 100) / 100;
  if (styleOwn(STYLE_CORNER_PX, s.corner) != null) { css.borderRadius = styleOwn(STYLE_CORNER_PX, s.corner)!; css.overflow = "hidden"; }
  if (styleOwn(STYLE_SHADOW, s.shadow)) css.boxShadow = styleOwn(STYLE_SHADOW, s.shadow)!;
  if (n.borderTop === true) css.borderTop = STYLE_HAIRLINE;
  if (n.borderBottom === true) css.borderBottom = STYLE_HAIRLINE;
  if ((style as { border?: unknown }).border === true) css.border = "1px solid currentColor";
  return Object.keys(css).length ? css : undefined;
}

/** The same declarations as an Astro `style` string (kebab-case, `;`-joined), or undefined. */
export function bcmsSectionStyleText(style: unknown): string | undefined {
  const css = bcmsSectionStyle(style);
  if (!css) return undefined;
  return Object.entries(css)
    .map(([k, v]) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()) + ":" + v)
    .join(";");
}

/**
 * C3/C9 — ONE PAGE FIELD's stored style, as the inline CSS the BetterCMS SDK's `fieldAttrs` draws.
 *
 * An element stamped `data-bcms-field` that also carries `data-bcms-style` is the site's promise
 * to the editor that "this element's inline style is `fieldStyleToCss(page.fieldStyles[path])`" —
 * and the editor offers a field's width, spacing, Align, Size and Weight handles only where an
 * element makes it — its element Size (`size`, painted as `zoom`) only where the marker is "2".
 * This is `fieldStyleToCss` from `@bettercms-ai/types`, INLINED like `bcmsSectionStyle` (zero
 * dependencies); `helper.test.ts` runs it against the original.
 *
 * The styles are the PAGE's (`pages[].fieldStyles`, keyed by the `data-bcms-field` address), so a
 * server BetterCMS hosts reads them from `BCMS_CONTENT_FILE` at request time like every other
 * value, and a build reads the ones its snapshot carries. None: no declarations, no `style`.
 */
const STYLE_FIELD_KEYS = ["contentWidth", "contentAlign", "marginTop", "marginBottom", "align", "fontSize", "weight", "size"];
/** `full` is absent on purpose: a full-width field has no max-width. */
const STYLE_CONTENT_WIDTH_PX: Record<string, string> = { narrow: "640px", default: "1024px", wide: "1280px" };
/** A whole element's Small / Large (a button's), as `zoom`. Medium is unset: no entry, no declaration. */
const STYLE_SIZE_ZOOM: Record<string, string> = { sm: "0.875", lg: "1.125" };

/** The stored style for `path` (by OWN key), from the published page when there is one. */
function fieldStyleAt(page: unknown, path: string, slug?: string): unknown {
  const content = liveContent();
  const key = slug ?? (isRecord(page) && typeof page.slug === "string" ? page.slug : undefined);
  let styles: unknown;
  if (content && key !== undefined && content.fieldStyles.has(key)) styles = content.fieldStyles.get(key);
  else {
    const entries = isRecord(page) ? page.entries : undefined;
    const root = slug !== undefined && isRecord(entries) ? entries[slug] : page;
    styles = isRecord(root) ? root.fieldStyles : undefined;
  }
  return isRecord(styles) && Object.prototype.hasOwnProperty.call(styles, path) ? styles[path] : undefined;
}

/** A field's declarations as a React-style object (camelCase), or undefined when there are none. */
export function bcmsStyle(page: unknown, path: string, slug?: string): Record<string, string | number> | undefined {
  const style = fieldStyleAt(page, path, slug);
  if (!style || typeof style !== "object") return undefined;
  // Only a field's keys, so a stored section key can never paint a field.
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) if (STYLE_FIELD_KEYS.includes(k) && v != null) s[k] = v;
  const css: Record<string, string | number> = { ...bcmsSectionStyle(s) };
  // The width is the field's own box: a max-width, placed by left/right margins only (never the
  // `margin` shorthand, which would take the vertical margins the spacing just set).
  const max = styleOwn(STYLE_CONTENT_WIDTH_PX, s.contentWidth);
  if (max) {
    const placement = s.contentAlign ?? s.align;
    css.maxWidth = max;
    css.marginLeft = placement === "left" ? "0" : "auto";
    css.marginRight = placement === "right" ? "0" : "auto";
  }
  // Last, so a style without a size keeps the declarations, in the order, it always had.
  const zoom = styleOwn(STYLE_SIZE_ZOOM, s.size);
  if (zoom) css.zoom = zoom;
  return Object.keys(css).length ? css : undefined;
}

/** The same declarations as an Astro `style` string (kebab-case, `;`-joined), or undefined. */
export function bcmsStyleText(page: unknown, path: string, slug?: string): string | undefined {
  const css = bcmsStyle(page, path, slug);
  if (!css) return undefined;
  return Object.entries(css)
    .map(([k, v]) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()) + ":" + v)
    .join(";");
}
