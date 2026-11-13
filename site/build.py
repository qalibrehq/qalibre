"""Assemble the Qalibre site: every page shares one head, header and footer, so navigation never drifts.

    python build.py        (writes the .html pages next to this file from src/*.html)

Each src page starts with a front-matter block:
    <!-- title: Page title | description: One sentence | nav: security -->
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
GITHUB = 'https://github.com/qalibrehq/qalibre'

WORDMARK = '''<svg viewBox="0 -6 257 88" width="{w}" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="8"><circle cx="24" cy="40" r="16"/><path d="M40 24 V78"/><circle cx="73" cy="40" r="16"/><path d="M89 24 V60"/><path d="M106 4 V60"/><path d="M123 24 V60"/><path d="M140 4 V60"/><circle cx="156" cy="40" r="16"/><path d="M189 24 V60 M189 42 A16 16 0 0 1 205 26"/><path d="M215 40 H247 M247 40 A16 16 0 1 0 242.3 51.3"/></g><circle cx="123" cy="10" r="5.6" fill="#B08D57"/><circle cx="123" cy="10" r="1.9" fill="var(--paper)"/></svg>'''

SITE = 'https://qalibre.app'

# Clean URLs: GitHub Pages serves /faq from faq.html. Every path is root-absolute so pages also work from /404 and deep links.
NAV = [('security', 'Security', '/security'), ('roadmap', 'Roadmap', '/roadmap'), ('fees', 'Fees', '/fees'), ('faq', 'FAQ', '/faq')]


def page(title: str, description: str, nav: str, body: str, slug: str) -> str:
    links = '\n        '.join(
        f'<a href="{href}"{" aria-current=\"page\"" if key == nav else ""}>{label}</a>' for key, label, href in NAV
    )
    full_title = 'Qalibre · Every trade, protected' if nav == 'home' else f'{title} · Qalibre'
    url = f'{SITE}/' if slug == 'index' else f'{SITE}/{slug}'
    robots = '  <meta name="robots" content="noindex" />\n' if slug == '404' else ''
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{full_title}</title>
  <meta name="description" content="{description}" />
  <meta name="theme-color" content="#F6F4EF" />
  <meta property="og:title" content="{full_title}" />
  <meta property="og:description" content="{description}" />
{robots}  <link rel="canonical" href="{url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Qalibre" />
  <meta property="og:url" content="{url}" />
  <meta property="og:image" content="{SITE}/assets/fill.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/assets/icon-512.png" />
  <link rel="preload" href="/fonts/Inter-SemiBold.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/fonts/Inter-Regular.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/style.css" />
  <link rel="stylesheet" href="/pages.css" />
</head>
<body data-api="" class="page-{nav}">
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <div class="wrap nav-in">
      <a href="/" class="brand" aria-label="Qalibre home">{WORDMARK.format(w=104)}</a>
      <nav class="links" aria-label="Main">
        {links}
      </nav>
      <a class="btn btn-small" href="https://t.me/QalibreBot">Open in Telegram</a>
      <button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu" aria-label="Menu"><span></span><span></span></button>
    </div>
    <nav class="menu" id="menu" aria-label="Menu" hidden>
      <div class="wrap">
        <a href="/">Home</a>
        {links}
        <a class="btn" href="https://t.me/QalibreBot">Open in Telegram</a>
      </div>
    </nav>
  </header>
  <main id="main">
{body}
  </main>
  <footer class="foot">
    <div class="wrap foot-grid">
      <div class="foot-brand">{WORDMARK.format(w=96)}<p>Every trade, protected.</p></div>
      <div><b>Product</b><a href="https://t.me/QalibreBot">Open in Telegram</a><a href="/fees">Fees</a><a href="/roadmap">Roadmap</a><a href="/faq">FAQ</a></div>
      <div><b>Trust</b><a href="/security">Security</a><a href="{GITHUB}">Source code</a><a href="{GITHUB}/blob/main/docs/AUDIT.md">Audit report</a></div>
      <div><b>Legal</b><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/risk">Risk notice</a></div>
    </div>
    <div class="wrap foot-base"><span>© 2026 Qalibre · <a href="mailto:hello@qalibre.app">hello@qalibre.app</a></span><span>Not financial advice. Testnet only.</span></div>
  </footer>
  <script src="/main.js" defer></script>
</body>
</html>
'''


def main():
    for src in sorted(SRC.glob('*.html')):
        if src.name.startswith('_'):
            continue
        text = src.read_text(encoding='utf8')
        m = re.match(r'\s*<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*\|\s*nav:\s*(\w+)\s*-->\s*', text, re.S)
        if not m:
            raise SystemExit(f'{src.name}: missing front matter')
        title, description, nav = m.groups()
        (ROOT / src.name).write_text(page(title, description, nav, text[m.end():], src.stem), encoding='utf8', newline='\n')
        print('built', src.name)
    slugs = [p.stem for p in sorted(SRC.glob('*.html')) if not p.name.startswith('_') and p.stem != '404']
    urls = ''.join(f'  <url><loc>{SITE}/{"" if s == "index" else s}</loc></url>\n' for s in slugs)
    sitemap = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'
    (ROOT / 'sitemap.xml').write_text(sitemap, encoding='utf8', newline='\n')
    (ROOT / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n', encoding='utf8', newline='\n')


if __name__ == '__main__':
    main()
