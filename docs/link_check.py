#!/usr/bin/env python3
"""Walk docs/_site and verify every internal href/src resolves to a file that exists,
accounting for the site's baseurl. External links (http/https/mailto) are skipped.

Usage: python3 docs/link_check.py [path-to-_site] [baseurl]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from html.parser import HTMLParser

LINK_ATTRS = {"a": "href", "img": "src", "link": "href", "script": "src"}


class LinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        attr_name = LINK_ATTRS.get(tag)
        if not attr_name:
            return
        d = dict(attrs)
        val = d.get(attr_name)
        if val:
            self.links.append(val)


def is_external(url: str) -> bool:
    return bool(re.match(r"^(https?:)?//", url)) or url.startswith(
        ("mailto:", "tel:", "javascript:", "data:")
    )


def strip_fragment_query(url: str) -> str:
    url = url.split("#", 1)[0]
    url = url.split("?", 1)[0]
    return url


def resolve(url: str, site_dir: Path, baseurl: str, page_dir: Path) -> Path | None:
    """Return the filesystem path a URL should map to, or None if not resolvable
    as an internal link."""
    url = strip_fragment_query(url)
    if not url:
        return None
    if url.startswith("/"):
        if baseurl and url.startswith(baseurl + "/"):
            rel = url[len(baseurl) + 1 :]
        elif baseurl and url == baseurl:
            rel = ""
        elif not baseurl:
            rel = url.lstrip("/")
        else:
            # Absolute path that doesn't carry the baseurl prefix -> broken under baseurl.
            return site_dir / url.lstrip("/")
        return site_dir / rel
    # Relative URL: resolve against the directory of the current page.
    return (page_dir / url).resolve()


def target_exists(path: Path) -> bool:
    if path.exists():
        if path.is_dir():
            return (path / "index.html").exists()
        return True
    # Jekyll serves clean-ish paths; try index.html inside a dir-looking path.
    if (path / "index.html").exists():
        return True
    return False


def main() -> int:
    site_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("docs/_site")
    baseurl = sys.argv[2] if len(sys.argv) > 2 else "/tetravox"
    site_dir = site_dir.resolve()

    if not site_dir.exists():
        print(f"error: {site_dir} does not exist — build the site first", file=sys.stderr)
        return 2

    html_files = sorted(site_dir.rglob("*.html"))
    broken: list[tuple[str, str, str]] = []
    cross_repo: list[tuple[str, str]] = []
    checked = 0

    for html_file in html_files:
        text = html_file.read_text(encoding="utf-8", errors="replace")
        parser = LinkExtractor()
        parser.feed(text)
        page_dir = html_file.parent
        for url in parser.links:
            if is_external(url):
                continue
            checked += 1
            target = resolve(url, site_dir, baseurl, page_dir)
            if target is None:
                continue
            # A "../" link that escapes site_dir points at the surrounding repo
            # (e.g. examples/, scripts/, python/) — valid on GitHub, outside the
            # Jekyll build root by design. Report separately, not as broken.
            try:
                target.relative_to(site_dir)
            except ValueError:
                cross_repo.append((str(html_file.relative_to(site_dir)), url))
                continue
            if not target_exists(target):
                broken.append((str(html_file.relative_to(site_dir)), url, str(target)))

    print(f"Checked {checked} internal links/assets across {len(html_files)} pages.")
    if cross_repo:
        print(f"\n{len(cross_repo)} cross-repo links (outside docs/, GitHub-only by design):")
        for page, url in cross_repo:
            print(f"  [{page}] {url}")
    if broken:
        print(f"\n{len(broken)} BROKEN:")
        for page, url, target in broken:
            print(f"  [{page}] {url} -> missing {target}")
        return 1
    print("\nNo broken internal links found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
