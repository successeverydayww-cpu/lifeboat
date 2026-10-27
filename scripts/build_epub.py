#!/usr/bin/env python3
"""Build Kindle EPUB for 'The Portion Principle' from book_ms/*.md."""
import os, re, zipfile, uuid, html

BASE = os.path.dirname(os.path.abspath(__file__))
MS = os.path.join(BASE, "book_ms")
OUT = os.path.join(BASE, "The_Portion_Principle_Samuel_Amos.epub")
BOOK_ID = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, "portion-principle-samuel-amos"))

FILES = ["00_front.md", "00b_intro_qa.md"] + [f"{n:02d}_chapter.md" for n in range(1, 13)] + \
        ["13_summary.md", "14_back.md", "15_study.md", "16_characters_devotional.md", "17_global.md"]

def esc(s):
    return html.escape(s, quote=False)

def parse(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    blocks, cur = [], []
    def flush():
        if cur:
            blocks.append(("p", " ".join(cur))); cur.clear()
    for ln in lines:
        s = ln.strip()
        if s.startswith("# ") or s.startswith("## "):
            flush(); blocks.append(("h", s))
        elif s == "":
            flush()
        else:
            cur.append(s)
    flush()
    return blocks

def to_html(blocks):
    out = []
    in_list = False
    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ol>"); in_list = False
    for k, t in blocks:
        if t.startswith("# "):
            close_list()
            level = "h1" if not t[2:].lower().startswith("chapter") or True else "h1"
            # split "TITLE — Subtitle"
            body = t[2:]
            main, _, sub = body.partition(" — ")
            out.append(f"<h1>{esc(main)}</h1>")
            if sub:
                out.append(f'<p class="subtitle">{esc(sub)}</p>')
        elif t.startswith("## "):
            close_list(); out.append(f"<h2>{esc(t[3:])}</h2>")
        elif re.match(r"^\d+\.\s", t):
            m = re.match(r"^(\d+)\.\s+(.*)$", t)
            if not in_list:
                out.append("<ol>"); in_list = True
            out.append(f"<li>{esc(m.group(2))}</li>")
        elif t.startswith('"') and t.rstrip().endswith('"') and "—" in t:
            close_list(); out.append(f"<blockquote>{esc(t)}</blockquote>")
        else:
            close_list(); out.append(f"<p>{esc(t)}</p>")
    close_list()
    return "\n".join(out)

chapters = []
titles = []
for idx, name in enumerate(FILES):
    blocks = parse(os.path.join(MS, name))
    body = to_html(blocks)
    first_h = next((t[2:] for k, t in blocks if t.startswith("# ")), name)
    titles.append(first_h.partition(" — ")[0].title().replace("'S", "'s"))
    fname = f"ch{idx:02d}.xhtml"
    doc = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>{esc(titles[-1])}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
{body}
</body></html>"""
    chapters.append((fname, doc))

cover_jpg = os.path.join(BASE, "ebook_cover.jpg")
from PIL import Image
im = Image.open(os.path.join(BASE, "cover_front.png")).convert("RGB")
im.thumbnail((1600, 2560))
im.save(cover_jpg, quality=88)

css = """body { font-family: serif; line-height: 1.6; margin: 5% 6%; }
h1 { font-size: 1.5em; text-align: center; margin: 2.5em 0 1em; page-break-before: always; }
h2 { font-size: 1.15em; margin-top: 1.8em; }
.subtitle { text-align: center; font-style: italic; color: #555; }
blockquote { font-style: italic; color: #333; margin: 1.2em 1.5em; }
ol { margin-left: 1.5em; } li { margin-bottom: 0.6em; }
"""

items, spine = [], []
items.append(('cover', 'cover.jpg', 'Cover', 'cover-image'))
spine.append('cover')
items.append(('nav', 'nav.xhtml', 'Contents', 'nav'))
spine.append('nav')
for i, (fname, doc) in enumerate(chapters):
    ident = f"c{i}"
    items.append((ident, fname, titles[i], 'xhtml'))
    spine.append(ident)

opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">{BOOK_ID}</dc:identifier>
<dc:title>The Portion Principle: Twelve Foundations of Wealth That Serves a Purpose</dc:title>
<dc:creator id="author">Samuel Amos</dc:creator>
<dc:language>en</dc:language>
<dc:description>Twelve load-bearing foundations of wealth drawn from Scripture and real life, for every young person who wants money to serve a purpose.</dc:description>
<meta property="dcterms:modified">2026-10-22T00:00:00Z</meta>
<meta name="cover" content="cover"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
{''.join(f'<item id="{i}" href="{h}" media-type="application/xhtml+xml"/>' for i,h,_t,_k in items if _k=='xhtml')}
</manifest>
<spine toc="ncx" page-progression-direction="ltr">
{''.join(f'<itemref idref="{i}"/>' for i,_h,_t,_k in items)}
</spine>
</package>"""

nav_items = []
for i,h,_t,_k in items:
    if _k in ('xhtml','nav'):
        href = '#' if i=='nav' else h
        label = 'Contents' if i=='nav' else titles[[x[0] for x in items].index(i)-2] if False else _t
        nav_items.append((i,h,_t))

nav = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
{''.join(f'<li><a href="{h}">{esc(t)}</a></li>' for _i,h,t in nav_items if h != '#')}
</ol></nav>
<nav epub:type="landmarks" hidden=""><ol>
<li><a epub:type="cover" href="cover.jpg">Cover</a></li>
<li><a epub:type="toc" href="nav.xhtml">Contents</a></li>
<li><a epub:type="bodymatter" href="ch00.xhtml">Begin Reading</a></li>
</ol></nav>
</body></html>"""

ncx = f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{BOOK_ID}"/></head>
<docTitle><text>The Portion Principle</text></docTitle>
<navMap>
{''.join(f'<navPoint id="n{i}" playOrder="{i}"><navLabel><text>{esc(t)}</text></navLabel><content src="{h}"/></navPoint>'.format() for i,(_i,h,t) in enumerate(nav_items))}
</navMap></ncx>"""

container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""

with zipfile.ZipFile(OUT, "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", container)
    z.write(cover_jpg, "OEBPS/cover.jpg")
    z.writestr("OEBPS/style.css", css)
    z.writestr("OEBPS/nav.xhtml", nav)
    z.writestr("OEBPS/toc.ncx", ncx)
    z.writestr("OEBPS/content.opf", opf)
    for fname, doc in chapters:
        z.writestr("OEBPS/" + fname, doc)

print("EPUB written:", OUT, os.path.getsize(OUT), "bytes")
