# North Point website archive

This is an archive of **https://www.nrthpoint.com**, the website of North Point, a web consultancy. The live site is being replaced by a redirect, so this repository is the record of it. Nothing has been rebuilt or redesigned yet. Everything here is a faithful capture to rebuild from later.

- **Captured:** 17 November 2026 (UTC). Exact timestamps are in `archive/inventory.json` and `archive/assets/manifest.json`.
- **Source:** `https://www.nrthpoint.com`. The apex `https://nrthpoint.com` 308-redirects to it. The site was a Next.js app on Vercel with content in Contentful (space `cssyktxw8bf5`). The sitemap's `lastmod` for every page is 2025-10-11.
- **Re-run:** `node scripts/archive.mjs` (or `--no-screenshots`). It needs only Node 22 and the preinstalled Playwright. Behind a proxy, add `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS=…` if TLS fails). During this capture the origin sometimes returned 502 or reset the connection, so every request is retried with backoff.

## Layout

| Path | What it is |
| --- | --- |
| `archive/html/` | Raw server HTML of every page, saved at its path (`index.html`, `work.html`, `work/<slug>.html`), plus `sitemap.xml`. `robots.txt` returned 404, so it isn't saved. |
| `archive/assets/` | Every image, the logo, the favicon, the fonts and the site stylesheet. `manifest.json` maps each original URL to its local path. |
| `archive/inventory.json` | One record per page: URL, status, title, image counts, screenshot files and heights, and the fonts that loaded. |
| `archive/verification.json` | The result of the script's final checks. |
| `content/` | The copy as Markdown with YAML frontmatter (`home.md`, `work.md`, `work/<slug>.md`) and `site.json`. |
| `screenshots/desktop/`, `screenshots/mobile/` | Full-page PNGs at 1440px and 390px wide (device scale 1), mirroring the page paths. |
| `scripts/archive.mjs` | The capture script. |

## Page inventory

The sitemap lists **14 pages**: `/`, `/work` and 12 project pages. The brief expected 15 pages and 13 projects, but the sitemap only has these 12 project slugs. The script crawled every internal link on every page and found **no pages outside the sitemap**.

All pages returned 200 and share one `<title>` and meta description: "North Point | Web Consultancy" and "We are digital technology specialists. We are also perfectionists.". No page has per-page SEO or Open Graph tags.

"Images" counts the distinct content images rendered on the page; the logo is not counted. "Incl. variants" counts every distinct Contentful URL in the HTML. That includes the mobile hero sources in `<picture>` and, on `/`, mobile-hero URLs that appear only in the Next.js RSC payload.

| Path | Title | Images | Incl. variants |
| --- | --- | ---: | ---: |
| `/` | North Point \| Web Consultancy | 7 | 11 |
| `/work` | North Point \| Web Consultancy | 12 | 12 |
| `/work/project-catalyst` | North Point \| Web Consultancy | 9 | 9 |
| `/work/daniel-ricciardo` | North Point \| Web Consultancy | 8 | 8 |
| `/work/betterleap` | North Point \| Web Consultancy | 9 | 9 |
| `/work/eversys` | North Point \| Web Consultancy | 11 | 11 |
| `/work/palatine-homes` | North Point \| Web Consultancy | 7 | 7 |
| `/work/burbeck` | North Point \| Web Consultancy | 8 | 8 |
| `/work/waitrose` | North Point \| Web Consultancy | 1 | 1 |
| `/work/uk-home-office` | North Point \| Web Consultancy | 2 | 2 |
| `/work/sky` | North Point \| Web Consultancy | 2 | 2 |
| `/work/tiney` | North Point \| Web Consultancy | 2 | 2 |
| `/work/the-grid` | North Point \| Web Consultancy | 2 | 2 |
| `/work/shell-remote-sense` | North Point \| Web Consultancy | 2 | 2 |

Things to know about the live site's structure:

- **There is no nav menu.** The logo is the only persistent link. It is static on `/`, links to `/` on `/work`, and links back to `/work` on project pages. Nothing on `/` links to `/work`.
- On `/work`, the cards for **Waitrose, UK Home Office, Sky, Tiney, The Grid and Shell Remote Sense link straight to the client's external site**, not to their `/work/<slug>` page. Those six pages were reachable only from the sitemap. Each one is a title, tags, a hero image and a "visit →" button; Sky and UK Home Office also have one sentence of copy.
- **Burbeck's "visit →" button has no `href`**, so it goes nowhere.
- The home showcase is an auto-rotating cross-fade slideshow of 4 projects. The screenshot freezes it on whichever slide was showing.

## Assets

- **86 original URLs → 82 files, 29.0 MB.** Nothing failed to download (`manifest.json` → `failed: []`).
  - 66 image URLs → 62 files, 28.7 MB: 58 JPEG, 3 PNG, 1 WebP. Includes `images/logo.png`.
  - 18 fonts (`.woff2`), 355 KB.
  - 1 stylesheet (`css/c29b6cf248e3d6c7.css`), 30 KB.
  - `favicon.ico`, 2.8 KB.
- Contentful images are the **originals** from `images.ctfassets.net`, never the `/_next/image?url=…&w=…` variants. The script finds them in `src`, in `srcset`, in `<picture><source>` and in the RSC payload.
- **Naming:** each file keeps its original filename. When two *different* images share a filename, both are prefixed with their Contentful asset ID, e.g. `7EZVswrWiR4fCwIJnMvkny-Home_Wide.jpg` and `3KcuZoEdf8pEKPkQa4Udt9-Home_Wide.jpg`. Fonts are named `<family>-<weight>-<style>-<subset>.woff2`.
- **Deduplication:** 4 pairs of Contentful URLs served byte-identical files: `Burbeck_16.jpg`, `tiney-369897874.jpg`, `1598291191070.jpeg` and `shell-remote-sense.jpeg`. Each pair is stored once, and the second URL carries `duplicateOf` in the manifest.
- Each manifest entry holds `path`, `bytes`, `contentType`, `sha256`, `kind`, the Contentful asset ID, the pages that reference it and, for fonts, family, weight, style, subset and whether it was preloaded.
- `Hero_2.jpg` (Project Catalyst hero) is **actually WebP**, even though it has a `.jpg` name; Contentful serves it as `image/webp`. It is kept byte-for-byte under its original name.

## Design notes

These come from the stylesheet (`archive/assets/css/`, Tailwind CSS v3 output) and the screenshots.

- **Fonts** are self-hosted via `next/font` (Google Fonts):
  - **Lato** 300/700/900 is the body font (`html, body { font-family: var(--font-lato) }`). Body copy is mostly Lato Light. Small headings (`h3`, the "Web Development"-style service titles, card titles, tag pills) are uppercase Lato Bold with wide letter-spacing (`tracking-widest` / `0.1em`).
  - **Libre Baskerville** 400 is the serif for `h1`/`h2`: the hero statement, "What we offer.", "How we work.", "Our Work" and project titles.
  - **Inter** (variable 100–900) and **Ephesis** are declared and archived but never used. Only Lato 300/700 and Libre Baskerville 400 loaded on any page.
- **Colours:** it is a dark theme.
  - Background: black `#000`.
  - Headings: `rgb(241 245 249)` (slate-100). Body text: white and `gray-300` `#d1d5db`. Muted text and the copyright line: `gray-500` `#6b7280`.
  - Tag pills: `gray-900` `#111827` background with white text.
  - Dividers: `slate-800` `#1e293b`.
  - Links in the call to action: `blue-300` `#93c5fd`, underlined, turning `blue-500` `#3b82f6` on hover.
  - "Visit →" button: white background with black text.
  - Image captions sit on `bg-black/50` overlays.
- **Layout:**
  - Tailwind `container` with breakpoints at 640/768/1024/1280/1536px, padded `p-6 md:p-8 lg:p-12`.
  - Content is left-aligned, with `max-w-5xl` to `max-w-7xl` columns.
  - Home, top to bottom:
    - logo
    - hero statement and two intro paragraphs
    - a tall rounded slideshow (`h-96`, min 600px on desktop) with a translucent caption bar
    - "Featured", a 3-column grid of image cards with caption overlays
    - "What we offer.", a 2-column grid of 4 services
    - "How we work.", a 3-column grid of 3 engagement models
    - the call to action and the copyright line
  - `/work` is a 2-column grid of cards: title, image, summary.
  - Project pages run in this order:
    - title
    - copy (`prose`)
    - tag pills
    - a hero `<picture>` with separate mobile and desktop sources (switching at 768px)
    - a single-column stack of screenshots
    - the "visit →" button
- **Motion:** every block fades and rises in (`opacity-0 translate-y-4`, 2000ms, `cubic-bezier(0.19, 1, 0.22, 1)`). Cards scale to 105% on hover, and the home slideshow cross-fades over 1000ms.
- **Analytics:** Google Analytics (`gtag`, `G-KEYVC07J74`) was on every page. It remains in the raw HTML for fidelity but is left out of `content/`, and the screenshot run blocked it.

## Typos and copy quirks (kept verbatim)

The copy in `content/` is kept exactly as published, mistakes included. Fix these during the rebuild, not in the archive.

| Where | As published | Probably meant |
| --- | --- | --- |
| Home, intro | "digital products **what** will help" | that will help |
| Home, intro | "helping governments' architecture and launch" | helping governments architect and launch |
| Home, Mobile Development | "**excell**" | excel |
| Home, Security | "all the **lastest** web **vunlerabilites**" | latest, vulnerabilities |
| Home, Security | "web-app **penetrating testing**, that allows **use** to **asses**" | penetration testing, us, assess |
| Home, Partner Up | "extra **talet**" | talent |
| Daniel Ricciardo | "**Sqaurespace's** Toolbelt" | Squarespace's |
| Project Catalyst | "architecture **to integration** with", "GraphQL **to integration** several" | to integrate |
| Betterleap | "This was **build** using" | built |
| Palatine Homes, Burbeck | "the latest front-end **standings**" | standards |
| UK Home Office | "the police **nation** infrastructure" | national |
| Shell Remote Sense (summary) | "a new **lubricate** monitoring service" | lubricant |
| Sky | page says "NBCUniversal's streaming service", while the `/work` summary says "NBCUniversal streaming service" | (inconsistent) |
| Home, intro | "full-scale technical design" contains non-breaking spaces | (preserved) |

## Rebuilding

The `content/` files map onto the old pages like this:

| Old page | Content file | Notes |
| --- | --- | --- |
| `/` | `content/home.md` | The frontmatter `sections` array follows page order: `logo`, `hero` (heading + intro), `showcase` (rotating slideshow items with caption and image), `featured` (cards), `services` ("What we offer."), `engagement_models` ("How we work."), `call_to_action`, then `footer`. The Markdown body holds the same content in order, marked with `<!-- section: … -->` comments. |
| `/work` | `content/work.md` | `items` in display order, with title, slug, the card's `href` (external for six projects; see above), summary and card image. |
| `/work/<slug>` | `content/work/<slug>.md` | Frontmatter fields: `title`, `slug`, `client`, `summary` (the `/work` card text), `intro` (first paragraph), `url` (the "visit →" link, `null` for Burbeck), `tags` (the pills), `hero.desktop` / `hero.mobile`, `listing` (the `/work` card), `home_showcase` / `home_featured` where the project appears on `/`, `images` (gallery in order, with alt text) and `notes`. The body is the copy in order, then hero, gallery and the visit link. |
| site-wide | `content/site.json` | Title, meta description, logo, favicon, contact email (`hello@nrthpoint.com`), nav (the logo links described above), footer (copyright + call to action), social (founder's blog `https://northover.co`) and every external link, with the pages it appears on. |

How image paths work:

- Image references in `content/` are repo-root-relative paths such as `/archive/assets/images/Hero_2.jpg`; GitHub renders them, and a build can strip the leading slash.
- Each frontmatter image also keeps its `original` Contentful URL.
- Inline formatting (bold, links) is Markdown.
- The same images often appear in several roles, e.g. a project's home slide, `/work` card and hero. Each role is listed separately so the rebuild can reproduce the old pairing or simplify it.

## Verification

At the end of each run the script checks that:

- every sitemap page has HTML, Markdown and both screenshots;
- no screenshot has a broken image;
- every `archive/assets/…` path referenced in `content/` exists;
- no Contentful URL in `content/` is missing from the archive;
- no asset download failed.

The final run passed all checks: 14/14 pages, 177 image references checked, 0 failed downloads, 0 problems (`archive/verification.json`).

**Not captured:** JavaScript bundles (`/_next/static/chunks/*`) and the `/_next/image` resized variants, on purpose (the raw HTML still references them), and `robots.txt`, which doesn't exist (404). Nothing else failed.
