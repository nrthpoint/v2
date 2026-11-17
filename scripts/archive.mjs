#!/usr/bin/env node
/**
 * Archive https://www.nrthpoint.com into this repository.
 *
 *   node scripts/archive.mjs                  # full capture
 *   node scripts/archive.mjs --no-screenshots # skip the Playwright screenshots
 *
 * Steps:
 *   1. fetch sitemap.xml and crawl every page in it, following internal links
 *      to find pages that are not in the sitemap      -> archive/html/
 *   2. collect every asset the pages reference (Contentful originals, local
 *      images, favicon, CSS and the fonts the CSS loads), download, dedupe by
 *      content hash and name them readably             -> archive/assets/ + manifest.json
 *   3. extract the copy from the archived HTML (in a JS-disabled, offline
 *      browser page) into Markdown + YAML frontmatter  -> content/
 *   4. full-page screenshots at 1440px and 390px       -> screenshots/
 *   5. verify the result and write archive/inventory.json + archive/verification.json
 *
 * No dependencies beyond Node 22 and the preinstalled Playwright.
 * If fetch cannot connect behind a proxy, run with NODE_USE_ENV_PROXY=1
 * (and NODE_EXTRA_CA_CERTS=<ca bundle> if TLS fails).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.nrthpoint.com';
const CTF_SPACE = 'cssyktxw8bf5';
const ARGS = new Set(process.argv.slice(2));
const SKIP_SHOTS = ARGS.has('--no-screenshots');
const BLOCKED_HOSTS = ['googletagmanager.com', 'google-analytics.com', 'analytics.google.com', 'doubleclick.net', 'vercel-insights.com', 'vitals.vercel-insights.com'];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

// ---------------------------------------------------------------- fetching
/** fetch with retries; the origin is occasionally unreachable (502 / reset). */
async function get(url, { attempts = 8 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (site-archiver)' } });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      return { url, finalUrl: res.url, status: res.status, headers: Object.fromEntries(res.headers), contentType: res.headers.get('content-type') || '', body };
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1000 * 2 ** i, 15000));
    }
  }
  throw new Error(`${url}: ${lastErr?.cause?.code || lastErr?.message}`);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------- pages
const pageFile = (p) => (p === '/' ? 'index.html' : `${p.replace(/^\//, '').replace(/\/$/, '')}.html`);
const pageName = (p) => (p === '/' ? 'index' : p.replace(/^\//, '').replace(/\/$/, ''));

function internalLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    let h = m[1].replace(/&amp;/g, '&');
    if (h.startsWith(ORIGIN)) h = h.slice(ORIGIN.length) || '/';
    if (h.startsWith('https://nrthpoint.com')) h = h.slice('https://nrthpoint.com'.length) || '/';
    if (!h.startsWith('/') || h.startsWith('//')) continue;
    h = h.split('#')[0].split('?')[0];
    if (/^\/(_next|images)\//.test(h) || /\.[a-z0-9]{2,5}$/i.test(h)) continue; // assets, not pages
    out.add(h.length > 1 ? h.replace(/\/$/, '') : h);
  }
  return [...out];
}

// ---------------------------------------------------------------- assets
/** every Contentful / local asset URL in raw HTML, incl. /_next/image?url=… and the RSC payload */
function assetUrls(html) {
  const out = new Set();
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  for (const m of html.matchAll(/https(?::|%3A)(?:\/\/|%2F%2F)images\.ctfassets\.net(?:\/|%2F)[^"'\s&\\)<>,]+/gi)) {
    out.add(decode(m[0]).split('?')[0]);
  }
  for (const m of html.matchAll(/(?:url=)?(?:%2F|\/)images(?:%2F|\/)[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|svg|webp|avif|ico)/gi)) {
    out.add(ORIGIN + decode(m[0].replace(/^url=/, '')));
  }
  for (const m of html.matchAll(/<link[^>]+rel="(?:shortcut )?icon"[^>]*>/g)) {
    const h = m[0].match(/href="([^"]+)"/); if (h) out.add(new URL(h[1].replace(/&amp;/g, '&'), ORIGIN).href.split('?')[0]);
  }
  for (const m of html.matchAll(/<link[^>]+as="font"[^>]*>/g)) {
    const h = m[0].match(/href="([^"]+)"/); if (h) out.add(new URL(h[1], ORIGIN).href.split('?')[0]);
  }
  return [...out];
}
const stylesheetUrls = (html) => [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, '&'), ORIGIN).href.split('?')[0]);

const SUBSETS = [
  [/^U\+0460-052F/i, 'cyrillic-ext'], [/^U\+0301,\s*U\+0400-045F/i, 'cyrillic'], [/^U\+1F(00-1FFF|\?\?)/i, 'greek-ext'],
  [/^U\+0370/i, 'greek'], [/^U\+0102-0103/i, 'vietnamese'], [/^U\+0100-02/i, 'latin-ext'], [/^U\+(0000-00FF|00\?\?)/i, 'latin'],
];
function parseFontFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const b = m[1];
    const src = b.match(/url\(([^)]+)\)/); if (!src) continue;
    const prop = (k) => (b.match(new RegExp(`${k}:([^;]+)`)) || [])[1]?.trim().replace(/^["']|["']$/g, '');
    const range = prop('unicode-range') || '';
    faces.push({
      url: new URL(src[1].replace(/["']/g, ''), ORIGIN).href,
      family: prop('font-family'), weight: prop('font-weight') || '400', style: prop('font-style') || 'normal',
      subset: (SUBSETS.find(([re]) => re.test(range)) || [, 'other'])[1], unicodeRange: range,
    });
  }
  return faces;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

function ctfParts(url) {
  const m = new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? { space: m[1], assetId: m[2], hash: m[3], filename: decodeURIComponent(m[4]) } : null;
}

// ---------------------------------------------------------------- yaml / md
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? JSON.stringify(v)
  : Array.isArray(v) ? '[]' : isObj(v) ? '{}' : String(v));
function yamlObj(o, ind = '') {
  let s = '';
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length) s += `${ind}${k}:\n${yamlArr(v, `${ind}  `)}`;
    else if (isObj(v) && Object.keys(v).length) s += `${ind}${k}:\n${yamlObj(v, `${ind}  `)}`;
    else s += `${ind}${k}: ${scalar(v)}\n`;
  }
  return s;
}
function yamlArr(a, ind) {
  let s = '';
  for (const v of a) {
    if (isObj(v) && Object.keys(v).length) s += `${ind}- ${yamlObj(v, `${ind}  `).slice(ind.length + 2)}`;
    else if (Array.isArray(v) && v.length) s += `${ind}-\n${yamlArr(v, `${ind}  `)}`;
    else s += `${ind}- ${scalar(v)}\n`;
  }
  return s;
}
const frontmatter = (o) => `---\n${yamlObj(o)}---\n`;

// ------------------------------------------------- in-browser extraction
// Runs inside the page (JS disabled, offline) against the archived HTML.
function extractInPage(ORIGIN) {
  const clean = (s) => (s || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
  const imgUrl = (src) => {
    if (!src) return null;
    const u = new URL(src, ORIGIN);
    if (u.pathname === '/_next/image') return new URL(u.searchParams.get('url'), ORIGIN).href.split('?')[0];
    return u.href.split('?')[0];
  };
  function md(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName.toLowerCase();
      const inner = md(n);
      const wrap = (mark) => { const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/); return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner; };
      if (t === 'b' || t === 'strong') out += wrap('**');
      else if (t === 'i' || t === 'em') out += wrap('*');
      else if (t === 'a') out += n.getAttribute('href') ? `[${inner}](${n.getAttribute('href')})` : inner;
      else if (t === 'br') out += '  \n';
      else out += inner;
    }
    return out;
  }
  const text = (el) => clean(el?.textContent);
  const para = (p) => ({ markdown: clean(md(p)), text: text(p) });
  const img = (el) => el && ({ src: imgUrl(el.getAttribute('src')), alt: el.getAttribute('alt') ?? '' });
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), text: text(a) || null, imgAlt: a.querySelector('img')?.getAttribute('alt') ?? null }));
  const anchorsWithoutHref = [...document.querySelectorAll('a:not([href])')].map((a) => text(a));
  const main = document.querySelector('main');
  const siteFooter = [...document.querySelectorAll('footer')].filter((f) => !main?.contains(f)).map((f) => [...f.querySelectorAll('p')].map(para).filter((p) => p.text));
  const meta = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
    lang: document.documentElement.lang,
    favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
    og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"],meta[name^="twitter:"]')].map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.getAttribute('content')])),
  };
  const base = { meta, links, anchorsWithoutHref, siteFooter: siteFooter.flat() };
  if (!main) return { ...base, kind: 'unknown' };

  // ---- home: header + sections inside main > div
  if (main.querySelector('h1') && main.querySelector('header')) {
    const container = main.querySelector('header').parentElement;
    const sections = [];
    for (const el of container.children) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'header') { sections.push({ type: 'logo', image: img(el.querySelector('img')) }); continue; }
      if (tag === 'footer') { sections.push({ type: 'cta', paragraphs: [...el.querySelectorAll('p')].map(para).filter((p) => p.text) }); continue; }
      const h1 = el.querySelector('h1');
      const h2 = el.querySelector('h2');
      if (h1) { sections.push({ type: 'hero', heading: text(h1), paragraphs: [...el.querySelectorAll('p')].map(para) }); continue; }
      if (!h2 && el.querySelector('a[href]')) {
        sections.push({ type: 'showcase', items: [...el.querySelectorAll(':scope a[href]')].map((a) => ({ href: a.getAttribute('href'), title: text(a.querySelector('h3')), caption: text(a.querySelector('p')) || null, image: img(a.querySelector('img')) })) });
        continue;
      }
      if (h2 && !el.querySelector('h3 ~ p, p ~ h3') && el.querySelector('a[href] img')) {
        sections.push({ type: 'cards', heading: text(h2), items: [...el.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), title: text(a.querySelector('h3')), image: img(a.querySelector('img')) })) });
        continue;
      }
      if (h2) {
        // querySelectorAll returns document order: h2, intro <p>s, then h3 / <p> pairs
        const intro = []; const items = []; let cur = null;
        for (const n of el.querySelectorAll('h2, h3, p')) {
          const t = n.tagName.toLowerCase();
          if (t === 'h3') { cur = { title: text(n), paragraphs: [] }; items.push(cur); } else if (t === 'p') (cur ? cur.paragraphs : intro).push(para(n));
        }
        sections.push({ type: 'list', heading: text(h2), intro, items });
        continue;
      }
      sections.push({ type: 'unknown', html: el.outerHTML.slice(0, 500) });
    }
    return { ...base, kind: 'home', sections };
  }

  // ---- work index
  if (main.querySelector('h1') && main.querySelector('ul li')) {
    return {
      ...base, kind: 'work-index',
      heading: text(main.querySelector('h1')),
      logo: { href: main.querySelector('a')?.getAttribute('href'), image: img(main.querySelector('a img')) },
      items: [...main.querySelectorAll('ul li')].map((li) => ({
        title: text(li.querySelector('h2')), href: li.querySelector('a[href]')?.getAttribute('href'),
        image: img(li.querySelector('img')), summary: clean(md(li.querySelector('p') || document.createElement('p'))),
      })),
    };
  }

  // ---- project page
  const logoA = main.querySelector('a');
  const blocks = [];
  for (const n of main.querySelectorAll('h1,h2,h3,h4,h5,h6,p,picture,img,a')) {
    const t = n.tagName.toLowerCase();
    if (n === logoA || logoA?.contains(n)) continue;
    if (t === 'img' && n.closest('picture')) continue;
    if ((t === 'a' && n.closest('p')) || n.closest('p') !== null && t !== 'p') continue;
    if (t === 'p') { const p = para(n); if (p.text) blocks.push({ type: 'p', ...p }); } else if (t === 'picture') {
      const sources = [...n.querySelectorAll('source')].map((s) => ({ media: s.getAttribute('media'), src: imgUrl(s.getAttribute('srcset')) }));
      const i = n.querySelector('img');
      blocks.push({ type: 'hero', alt: i?.getAttribute('alt') ?? '', src: imgUrl(i?.getAttribute('src')), sources });
    } else if (t === 'img') blocks.push({ type: 'img', ...img(n) });
    else if (t === 'a') blocks.push({ type: 'link', href: n.getAttribute('href'), text: text(n) });
    else if (t === 'h4') blocks.push({ type: 'tag', text: text(n), raw: n.textContent });
    else blocks.push({ type: t, text: text(n) });
  }
  return { ...base, kind: 'project', logo: { href: logoA?.getAttribute('href'), image: img(logoA?.querySelector('img')) }, blocks };
}

// ================================================================ main
async function main() {
  const startedAt = new Date();
  const htmlDir = path.join(ROOT, 'archive/html');
  const assetsDir = path.join(ROOT, 'archive/assets');

  // ---- 1. sitemap + crawl
  log('· sitemap');
  const sm = await get(`${ORIGIN}/sitemap.xml`);
  await write(path.join(htmlDir, 'sitemap.xml'), sm.body);
  const sitemapPaths = [...sm.body.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => { const p = new URL(m[1].trim()).pathname; return p.length > 1 ? p.replace(/\/$/, '') : '/'; });
  for (const extra of ['robots.txt']) {
    try { const r = await get(`${ORIGIN}/${extra}`, { attempts: 4 }); if (r.status === 200) await write(path.join(htmlDir, extra), r.body); else log(`  ${extra}: HTTP ${r.status}`); } catch (e) { log(`  ${extra}: ${e.message}`); }
  }

  const pages = new Map(); // path -> page record
  const queue = sitemapPaths.map((p) => ({ path: p, from: 'sitemap' }));
  while (queue.length) {
    const { path: p, from } = queue.shift();
    if (pages.has(p)) continue;
    log(`· page ${p}`);
    const rec = { path: p, url: ORIGIN + (p === '/' ? '/' : p), inSitemap: sitemapPaths.includes(p), discoveredFrom: from, file: `archive/html/${pageFile(p)}` };
    pages.set(p, rec);
    try {
      const r = await get(rec.url);
      rec.status = r.status; rec.finalUrl = r.finalUrl; rec.contentType = r.contentType;
      rec.html = r.body.toString('utf8');
      await write(path.join(ROOT, rec.file), r.body);
      for (const l of internalLinks(rec.html)) if (!pages.has(l) && !queue.some((q) => q.path === l)) queue.push({ path: l, from: p });
    } catch (e) { rec.error = e.message; log(`  ! ${e.message}`); }
  }

  // ---- 2. assets
  log('· assets');
  const refs = new Map(); // url -> {kind, pages:Set, extra}
  const addRef = (url, kind, page, extra = {}) => {
    if (!refs.has(url)) refs.set(url, { kind, pages: new Set(), ...extra });
    if (page) refs.get(url).pages.add(page);
  };
  const cssUrls = new Set();
  for (const pg of pages.values()) {
    if (!pg.html) continue;
    for (const u of assetUrls(pg.html)) {
      const kind = u.includes('ctfassets.net') ? 'image' : /\.woff2?$/.test(u) ? 'font' : /favicon|\.ico$/.test(u) ? 'favicon' : 'image';
      addRef(u, kind, pg.path);
    }
    for (const c of stylesheetUrls(pg.html)) { cssUrls.add(c); addRef(c, 'css', pg.path); }
  }
  const fontFaces = [];
  for (const c of cssUrls) {
    try {
      const r = await get(c);
      const css = r.body.toString();
      for (const f of parseFontFaces(css)) { fontFaces.push(f); addRef(f.url, 'font', null, { font: f }); }
      for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
        const u = new URL(m[1].replace(/["']/g, ''), c).href;
        if (!u.startsWith('data:') && !refs.has(u)) addRef(u, /\.woff2?$/.test(u) ? 'font' : 'image', null, { fromCss: c });
      }
    } catch (e) { log(`  ! css ${c}: ${e.message}`); }
  }
  for (const [u, r] of refs) if (r.kind === 'font' && !r.font) r.font = fontFaces.find((f) => f.url === u);

  const urls = [...refs.keys()].sort();
  const downloads = new Map();
  const failed = [];
  await pool(urls, 6, async (u) => {
    try {
      const r = await get(u);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      downloads.set(u, { body: r.body, contentType: r.contentType, sha256: crypto.createHash('sha256').update(r.body).digest('hex') });
    } catch (e) { failed.push({ url: u, error: e.message, pages: [...refs.get(u).pages] }); log(`  ! ${u}: ${e.message}`); }
  });

  // name: identical bytes share one file; different bytes sharing a filename get the Contentful asset id
  const byHash = new Map();
  for (const u of urls) { const d = downloads.get(u); if (!d) continue; if (!byHash.has(d.sha256)) byHash.set(d.sha256, []); byHash.get(d.sha256).push(u); }
  const baseName = (u) => {
    const r = refs.get(u);
    if (r.kind === 'font' && r.font) return `fonts/${slug(r.font.family)}-${r.font.weight.replace(/\s+/g, '-')}-${r.font.style}-${r.font.subset}.woff2`;
    if (r.kind === 'font') return `fonts/${path.basename(new URL(u).pathname)}`;
    if (r.kind === 'css') return `css/${path.basename(new URL(u).pathname)}`;
    if (r.kind === 'favicon') return path.basename(new URL(u).pathname);
    const c = ctfParts(u);
    return `images/${safeName(c && u.includes('ctfassets') ? c.filename : path.basename(new URL(u).pathname))}`;
  };
  const groups = [...byHash.values()];
  const nameCount = new Map();
  for (const g of groups) { const n = baseName(g[0]).toLowerCase(); nameCount.set(n, (nameCount.get(n) || 0) + 1); }
  const localOf = new Map();
  for (const g of groups) {
    let n = baseName(g[0]);
    if (nameCount.get(n.toLowerCase()) > 1) {
      const c = ctfParts(g[0]);
      n = c && g[0].includes('ctfassets') ? `images/${c.assetId}-${safeName(c.filename)}` : n.replace(/(\.[^.]+)$/, `-${downloads.get(g[0]).sha256.slice(0, 8)}$1`);
    }
    for (const u of g) localOf.set(u, `archive/assets/${n}`);
    await write(path.join(ROOT, `archive/assets/${n}`), downloads.get(g[0]).body);
  }
  const manifest = {
    source: ORIGIN, capturedAt: startedAt.toISOString(),
    note: 'Keys are the original URLs (Contentful originals, never /_next/image variants). URLs with identical bytes share one local file (see duplicateOf).',
    assets: Object.fromEntries(urls.filter((u) => downloads.has(u)).map((u) => {
      const d = downloads.get(u); const r = refs.get(u); const c = u.includes('ctfassets') ? ctfParts(u) : null;
      const firstUrl = byHash.get(d.sha256)[0];
      return [u, {
        path: localOf.get(u), bytes: d.body.length, contentType: d.contentType, sha256: d.sha256, kind: r.kind,
        ...(c ? { contentfulAssetId: c.assetId } : {}),
        ...(r.font ? { font: { family: r.font.family, weight: r.font.weight, style: r.font.style, subset: r.font.subset, preloaded: /\.p\.woff2$/.test(u) } } : {}),
        ...(firstUrl !== u ? { duplicateOf: firstUrl } : {}),
        pages: [...r.pages].sort(),
      }];
    })),
    failed,
  };
  await write(path.join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const assetPath = (u) => (u && localOf.has(u) ? `/${localOf.get(u)}` : null);

  // ---- 3. content
  log('· content');
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const offline = await browser.newContext({ javaScriptEnabled: false });
  await offline.route('**/*', (route) => route.abort());
  const extracted = new Map();
  for (const pg of pages.values()) {
    if (!pg.html) continue;
    const page = await offline.newPage();
    await page.setContent(pg.html, { waitUntil: 'domcontentloaded' });
    const data = await page.evaluate(extractInPage, ORIGIN);
    await page.close();
    extracted.set(pg.path, data);
    if (process.env.DEBUG_EXTRACT) await write(path.join(process.env.DEBUG_EXTRACT, `${pageName(pg.path)}.json`), JSON.stringify(data, null, 2));
    pg.title = data.meta.title;
  }
  await offline.close();
  const imageRef = (i) => i && i.src && ({ src: assetPath(i.src) ?? i.src, alt: i.alt, original: i.src });
  const mdImage = (i) => `![${(i.alt || '').replace(/[[\]]/g, '\\$&')}](${i.src})`;

  // home
  const home = extracted.get('/');
  const workIndex = extracted.get('/work');
  const homeHomeShowcase = home?.sections.find((s) => s.type === 'showcase')?.items || [];
  const homeFeatured = home?.sections.find((s) => s.type === 'cards')?.items || [];
  if (home) {
    const fm = { title: home.meta.title, description: home.meta.description, path: '/', source: `${ORIGIN}/`, sections: [] };
    let body = '';
    for (const s of home.sections) {
      if (s.type === 'logo') { fm.sections.push({ type: 'logo', image: imageRef(s.image) }); body += `${mdImage(imageRef(s.image))}\n\n`; }
      if (s.type === 'hero') {
        fm.sections.push({ type: 'hero', heading: s.heading, intro: s.paragraphs.map((p) => p.markdown) });
        body += `<!-- section: hero -->\n# ${s.heading}\n\n${s.paragraphs.map((p) => p.markdown).join('\n\n')}\n\n`;
      }
      if (s.type === 'showcase') {
        fm.sections.push({ type: 'showcase', note: 'Auto-rotating slideshow; first item is shown on load.', items: s.items.map((i) => ({ title: i.title, href: i.href, caption: i.caption, image: imageRef(i.image) })) });
        body += `<!-- section: showcase (rotating slideshow) -->\n${s.items.map((i) => `[${mdImage(imageRef(i.image))}](${i.href})\n\n**${i.title}** — ${i.caption}`).join('\n\n')}\n\n`;
      }
      if (s.type === 'cards') {
        fm.sections.push({ type: 'featured', heading: s.heading, items: s.items.map((i) => ({ title: i.title, href: i.href, image: imageRef(i.image) })) });
        body += `<!-- section: featured -->\n## ${s.heading}\n\n${s.items.map((i) => `- [${i.title}](${i.href}) ${mdImage(imageRef(i.image))}`).join('\n')}\n\n`;
      }
      if (s.type === 'list') {
        const type = /offer/i.test(s.heading) ? 'services' : /work/i.test(s.heading) ? 'engagement_models' : 'list';
        fm.sections.push({ type, heading: s.heading, intro: s.intro.map((p) => p.markdown), items: s.items.map((i) => ({ title: i.title, body: i.paragraphs.map((p) => p.markdown).join('\n\n') })) });
        body += `<!-- section: ${type} -->\n## ${s.heading}\n\n${s.intro.map((p) => p.markdown).join('\n\n')}\n\n${s.items.map((i) => `### ${i.title}\n\n${i.paragraphs.map((p) => p.markdown).join('\n\n')}`).join('\n\n')}\n\n`;
      }
      if (s.type === 'cta') {
        fm.sections.push({ type: 'call_to_action', paragraphs: s.paragraphs.map((p) => p.markdown) });
        body += `<!-- section: call_to_action -->\n${s.paragraphs.map((p) => p.markdown).join('\n\n')}\n\n`;
      }
      if (s.type === 'unknown') log('  ! unknown home section', s.html);
    }
    fm.footer = home.siteFooter.map((p) => p.markdown);
    body += `<!-- section: footer -->\n${home.siteFooter.map((p) => p.markdown).join('\n\n')}\n`;
    await write(path.join(ROOT, 'content/home.md'), `${frontmatter(fm)}\n${body}`);
  }

  // work index
  if (workIndex) {
    const fm = {
      title: workIndex.meta.title, description: workIndex.meta.description, path: '/work', source: `${ORIGIN}/work`, heading: workIndex.heading,
      items: workIndex.items.map((i) => ({ title: i.title, slug: (sitemapPaths.find((p) => p.startsWith('/work/') && extracted.get(p)?.blocks?.find((b) => b.type === 'h2')?.text === i.title) || '').replace('/work/', '') || null, href: i.href, summary: i.summary, image: imageRef(i.image) })),
    };
    const body = `# ${workIndex.heading}\n\n${workIndex.items.map((i) => `## ${i.title}\n\n[${mdImage(imageRef(i.image))}](${i.href})\n\n${i.summary}`).join('\n\n')}\n\n${workIndex.siteFooter.map((p) => p.markdown).join('\n\n')}\n`;
    await write(path.join(ROOT, 'content/work.md'), `${frontmatter(fm)}\n${body}`);
  }

  // projects
  for (const [p, d] of extracted) {
    if (d.kind !== 'project') continue;
    const slugName = p.replace(/^\/work\//, '');
    const title = d.blocks.find((b) => b.type === 'h2')?.text || d.logo?.image?.alt;
    const paras = d.blocks.filter((b) => b.type === 'p');
    const hero = d.blocks.find((b) => b.type === 'hero');
    const gallery = d.blocks.filter((b) => b.type === 'img');
    const visit = d.blocks.find((b) => b.type === 'link' && b.href && /visit/i.test(b.text));
    const visitNoHref = d.anchorsWithoutHref.find((t) => /visit/i.test(t));
    const card = workIndex?.items.find((i) => i.title === title);
    const show = homeHomeShowcase.find((i) => i.href === p);
    const feat = homeFeatured.find((i) => i.href === p);
    const notes = [];
    if (visitNoHref && !visit) notes.push('The "visit →" link on the live page has no href (renders as an inert link).');
    if (card && card.href !== p) notes.push(`On /work this project's card links to ${card.href}, not to ${p}; the page is only reachable via the sitemap or direct URL.`);
    const heroDesktop = hero?.sources.find((s) => /min-width/.test(s.media || ''))?.src || hero?.src;
    const heroMobile = hero?.sources.find((s) => /max-width/.test(s.media || ''))?.src;
    const fm = {
      title, slug: slugName, path: p, source: ORIGIN + p,
      seo_title: d.meta.title, meta_description: d.meta.description,
      client: title,
      summary: card?.summary ?? null,
      intro: paras[0]?.markdown ?? null,
      url: visit?.href ?? null,
      tags: d.blocks.filter((b) => b.type === 'tag').map((b) => b.text),
      hero: hero ? { alt: hero.alt, desktop: assetPath(heroDesktop), mobile: assetPath(heroMobile), desktop_original: heroDesktop, mobile_original: heroMobile ?? null } : null,
      listing: card ? { href: card.href, image: imageRef(card.image) } : null,
      home_showcase: show ? { caption: show.caption, image: imageRef(show.image) } : undefined,
      home_featured: feat ? { image: imageRef(feat.image) } : undefined,
      images: gallery.map((g) => imageRef(g)),
      notes: notes.length ? notes : undefined,
    };
    let body = paras.map((b) => b.markdown).join('\n\n');
    if (hero) body += `\n\n${mdImage({ alt: hero.alt, src: assetPath(heroDesktop) })}`;
    if (gallery.length) body += `\n\n${gallery.map((g) => mdImage(imageRef(g))).join('\n\n')}`;
    if (visit) body += `\n\n[${visit.text}](${visit.href})`;
    await write(path.join(ROOT, `content/work/${slugName}.md`), `${frontmatter(fm)}\n${body.trim()}\n`);
  }

  // site.json
  const allLinks = [...extracted.entries()].flatMap(([pg, d]) => d.links.map((l) => ({ ...l, page: pg })));
  const external = new Map();
  for (const l of allLinks) {
    if (!/^https?:/.test(l.href) || l.href.startsWith(ORIGIN)) continue;
    if (!external.has(l.href)) external.set(l.href, { href: l.href, text: l.text || l.imgAlt, pages: new Set() });
    external.get(l.href).pages.add(l.page);
  }
  const ctaLinks = home?.sections.find((s) => s.type === 'cta');
  const site = {
    title: home?.meta.title, description: home?.meta.description, lang: home?.meta.lang, url: ORIGIN,
    favicon: assetPath(`${ORIGIN}/favicon.ico`), logo: assetPath(`${ORIGIN}/images/logo.png`),
    contact_email: (allLinks.find((l) => l.href.startsWith('mailto:'))?.href || '').replace('mailto:', '') || null,
    nav: {
      note: 'There is no navigation menu. The logo is the only persistent link: it is static on /, links to / on /work, and links back to /work on project pages. Projects are reached from the home slideshow and Featured cards, and from /work.',
      items: [
        { label: 'North Point (logo)', href: '/', on: '/work' },
        { label: 'North Point (logo)', href: '/work', on: '/work/*' },
      ],
    },
    footer: {
      copyright: home?.siteFooter.map((p) => p.text).join(' ') || null,
      call_to_action: ctaLinks?.paragraphs.map((p) => p.markdown) || [],
    },
    social: [...external.values()].filter((e) => /northover\.co|twitter\.com|\/\/x\.com|linkedin\.com|instagram\.com/i.test(e.href)).map((e) => ({ label: e.text, href: e.href })),
    external_links: [...external.values()].map((e) => ({ label: e.text, href: e.href, pages: [...e.pages].sort() })),
    analytics: 'Google Analytics (gtag) was loaded on every page; intentionally not carried over.',
    pages: [...pages.values()].map((pg) => ({ path: pg.path, title: pg.title ?? null, in_sitemap: pg.inSitemap })),
  };
  await write(path.join(ROOT, 'content/site.json'), `${JSON.stringify(site, null, 2)}\n`);

  // ---- 4. screenshots (live site; every request is served via Node fetch with retries + cache)
  const shots = {};
  if (!SKIP_SHOTS) {
    log('· screenshots');
    const cache = new Map();
    const serve = async (route) => {
      const req = route.request(); const u = req.url();
      const host = new URL(u).hostname;
      if (BLOCKED_HOSTS.some((h) => host.endsWith(h))) return route.abort('blockedbyclient');
      if (req.method() !== 'GET') return route.abort();
      try {
        if (!cache.has(u)) cache.set(u, get(u, { attempts: 8 }));
        const r = await cache.get(u);
        const headers = { ...r.headers }; delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
        return route.fulfill({ status: r.status, headers, body: r.body });
      } catch (e) { cache.delete(u); log(`  ! ${u}: ${e.message}`); return route.abort('failed'); }
    };
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, reducedMotion: 'no-preference' });
      await ctx.route('**/*', serve);
      for (const pg of pages.values()) {
        if (pg.error) continue;
        const page = await ctx.newPage();
        const out = `screenshots/${vpName}/${pageName(pg.path)}.png`;
        try {
          await page.goto(pg.url, { waitUntil: 'networkidle', timeout: 120000 });
          await page.evaluate(() => document.fonts.ready);
          // scroll through so lazy images load and fade-in reveals fire
          await page.evaluate(async () => {
            const step = Math.max(200, window.innerHeight / 2);
            for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
            window.scrollTo(0, 0);
          });
          await page.waitForLoadState('networkidle');
          await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 60000 });
          await page.waitForTimeout(2500); // 2s reveal transitions
          const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && !i.naturalWidth && i.currentSrc).map((i) => i.currentSrc));
          const loadedFonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`));
          await fs.mkdir(path.dirname(path.join(ROOT, out)), { recursive: true });
          // the home slideshow cross-fades every few seconds: wait for a moment with no running
          // transitions, then disable transitions so a slide change can't blend mid-capture
          await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 30000, polling: 50 }).catch(() => {});
          await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
          await page.screenshot({ path: path.join(ROOT, out), fullPage: true });
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          (shots[pg.path] ||= {})[vpName] = { file: out, height: h, brokenImages: broken, fontsLoaded: [...new Set(loadedFonts)] };
          log(`  ${out} (${h}px${broken.length ? `, ${broken.length} broken images` : ''})`);
        } catch (e) { (shots[pg.path] ||= {})[vpName] = { file: null, error: e.message }; log(`  ! ${out}: ${e.message}`); }
        await page.close();
      }
      await ctx.close();
    }
  }
  await browser.close();

  // ---- 5. inventory + verification
  const inventory = [...pages.values()].map((pg) => {
    const d = extracted.get(pg.path);
    const rendered = new Set();
    if (d?.kind === 'home') d.sections.forEach((s) => { if (s.items) s.items.forEach((i) => i.image && rendered.add(i.image.src)); });
    if (d?.kind === 'work-index') d.items.forEach((i) => rendered.add(i.image.src));
    if (d?.kind === 'project') d.blocks.forEach((b) => { if (b.type === 'img') rendered.add(b.src); if (b.type === 'hero') { rendered.add(b.src); b.sources.forEach((s) => rendered.add(s.src)); } });
    const ctfOnPage = [...refs.entries()].filter(([u, r]) => r.pages.has(pg.path) && u.includes('ctfassets')).map(([u]) => u);
    return {
      path: pg.path, url: pg.url, title: pg.title ?? null, inSitemap: pg.inSitemap, discoveredFrom: pg.discoveredFrom,
      status: pg.status ?? null, error: pg.error ?? null, html: pg.error ? null : pg.file,
      content: pg.path === '/' ? 'content/home.md' : pg.path === '/work' ? 'content/work.md' : `content${pg.path}.md`,
      images: rendered.size, imagesIncludingMobileVariants: ctfOnPage.length,
      screenshots: shots[pg.path] || null,
    };
  });

  const problems = [];
  const exists = async (f) => fs.access(path.join(ROOT, f)).then(() => true, () => false);
  for (const p of sitemapPaths) {
    const inv = inventory.find((i) => i.path === p);
    if (!inv?.html || !(await exists(inv.html))) problems.push(`${p}: missing HTML`);
    if (!(await exists(inv.content))) problems.push(`${p}: missing Markdown (${inv.content})`);
    if (!SKIP_SHOTS) for (const vp of Object.keys(VIEWPORTS)) if (!inv.screenshots?.[vp]?.file || !(await exists(inv.screenshots[vp].file))) problems.push(`${p}: missing ${vp} screenshot`);
    if (inv.screenshots) for (const [vp, s] of Object.entries(inv.screenshots)) if (s.brokenImages?.length) problems.push(`${p}: ${s.brokenImages.length} broken images in ${vp} screenshot`);
  }
  const contentFiles = [];
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else contentFiles.push(f); } };
  await walk(path.join(ROOT, 'content'));
  let imageRefsChecked = 0;
  for (const f of contentFiles) {
    const txt = await fs.readFile(f, 'utf8');
    for (const m of txt.matchAll(/\/?archive\/assets\/[^\s)"'\]]+/g)) {
      imageRefsChecked++;
      if (!(await exists(m[0].replace(/^\//, '')))) problems.push(`${rel(f)}: references missing ${m[0]}`);
    }
    for (const m of txt.matchAll(/https:\/\/images\.ctfassets\.net[^\s)"']+/g)) {
      if (!localOf.has(m[0])) problems.push(`${rel(f)}: references un-archived ${m[0]}`);
    }
  }
  for (const f of failed) problems.push(`download failed: ${f.url} (${f.error})`);
  const verification = { checkedAt: new Date().toISOString(), sitemapPages: sitemapPaths.length, pagesCaptured: inventory.filter((i) => i.html).length, imageRefsChecked, assets: Object.keys(manifest.assets).length, failedDownloads: failed.length, problems };
  await write(path.join(ROOT, 'archive/inventory.json'), `${JSON.stringify({ source: ORIGIN, capturedAt: startedAt.toISOString(), sitemap: sitemapPaths, pages: inventory }, null, 2)}\n`);
  await write(path.join(ROOT, 'archive/verification.json'), `${JSON.stringify(verification, null, 2)}\n`);

  log(`\npages ${inventory.length} (sitemap ${sitemapPaths.length}), assets ${Object.keys(manifest.assets).length} files ${groups.length}, failed ${failed.length}, image refs checked ${imageRefsChecked}`);
  if (problems.length) { log('PROBLEMS:\n  ' + problems.join('\n  ')); process.exitCode = 1; } else log('verification OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
