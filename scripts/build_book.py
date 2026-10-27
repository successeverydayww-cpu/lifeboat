#!/usr/bin/env python3
"""Build 'The Portion Principle' book PDF from book_ms/*.md using fpdf2."""
import os, re, math
from fpdf import FPDF

BASE = os.path.dirname(os.path.abspath(__file__))
MS = os.path.join(BASE, "book_ms")
OUT = os.path.join(BASE, "KDP_Interior_5.5x8.5.pdf" if os.environ.get("KDP_INTERIOR") else "The_Portion_Principle_Samuel_Amos.pdf")

FDIR = "/usr/share/fonts/truetype/dejavu/"
SERIF = FDIR + "DejaVuSerif.ttf"
SERIF_B = FDIR + "DejaVuSerif-Bold.ttf"
SERIF_I = FDIR + "DejaVuSerif-Italic.ttf"
SANS = FDIR + "DejaVuSans.ttf"
SANS_B = FDIR + "DejaVuSans-Bold.ttf"

PAGE_W, PAGE_H = 396.0, 612.0   # 5.5 x 8.5 in
ML, MR, MT, MB = 62.0, 62.0, 66.0, 62.0
TEXT_W = PAGE_W - ML - MR

BODY_SIZE = 13.2
LEAD = 1.6

class Book(FPDF):
    def __init__(self, pass_num, toc_entries=None):
        super().__init__(unit="pt", format=(PAGE_W, PAGE_H))
        self.pass_num = pass_num
        self.toc_entries = toc_entries or []
        self.collected = []
        self.set_margins(ML, MT, MR)
        self.set_auto_page_break(True, MB)
        self.set_title("The Portion Principle - Twelve Foundations of Wealth That Serves a Purpose")
        self.set_author("Skylar")
        self.alias_nb_pages()
        self.c_margin = 0

    def header(self):
        pass

    def footer(self):
        if self.page_no() <= 2 or getattr(self, "suppress_footer", False):
            return
        self.set_y(-36)
        self.set_font("serif", "", 9.5)
        self.cell(0, 12, str(self.page_no()), align="C")

    def register_toc(self, title, level=0):
        pg = self.page_no()
        self.collected.append((title, level, pg))
        return pg

def add_fonts(pdf):
    pdf.add_font("serif", "", SERIF)
    pdf.add_font("serif", "B", SERIF_B)
    pdf.add_font("serif", "I", SERIF)  # no italic serif available; style falls back to regular
    pdf.add_font("sans", "", SANS)
    pdf.add_font("sans", "B", SANS_B)

def body_font(pdf, style="", size=BODY_SIZE):
    pdf.set_font("serif", style, size)

def new_page(pdf):
    pdf.add_page()

def opener(pdf, title, subtitle=None, epigraph=None, register=None):
    pdf.add_page()
    pdf.ln(64)
    if register:
        pdf.register_toc(register, 0)
    # rule
    pdf.set_draw_color(150, 150, 150)
    pdf.set_line_width(0.5)
    y = pdf.get_y()
    pdf.line(ML, y, ML + 60, y)
    pdf.ln(26)
    parts = title.split(": ", 1)
    if len(parts) == 2:
        kicker, main = parts
    else:
        kicker, main = None, title
    if kicker:
        body_font(pdf, "", 12.5)
        pdf.set_text_color(90, 90, 90)
        pdf.multi_cell(TEXT_W, 18, kicker.upper(), align="L")
        pdf.ln(4)
    body_font(pdf, "B", 21)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(TEXT_W, 27, main, align="L")
    if subtitle:
        pdf.ln(6)
        body_font(pdf, "", 12.5)
        pdf.set_text_color(70, 70, 70)
        pdf.multi_cell(TEXT_W, 18, subtitle, align="L")
    pdf.ln(16)
    if epigraph:
        body_font(pdf, "I", 11.2)
        pdf.set_text_color(60, 60, 60)
        pdf.multi_cell(TEXT_W - 14, 17, epigraph, align="L")
        pdf.ln(10)
    pdf.set_text_color(20, 20, 20)

def section_head(pdf, text):
    pdf.ln(6)
    body_font(pdf, "B", 13.2)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(TEXT_W, 21, text, align="L")
    pdf.ln(7)

def paragraph(pdf, text, first=False):
    body_font(pdf, "", BODY_SIZE)
    pdf.set_text_color(25, 25, 25)
    pdf.multi_cell(TEXT_W, BODY_SIZE * LEAD, text, align="J")
    pdf.ln(5.4)

def list_item(pdf, text):
    body_font(pdf, "", BODY_SIZE)
    pdf.set_text_color(25, 25, 25)
    x0 = pdf.get_x()
    pdf.cell(14, BODY_SIZE * LEAD, "")
    pdf.multi_cell(TEXT_W - 16, BODY_SIZE * LEAD, text, align="J")
    pdf.ln(4.0)

def center_page(pdf, lines, size=13.5, lead=None, start_lns=0):
    pdf.add_page()
    pdf.ln(90 + start_lns * 10)
    for txt, sty, sz in lines:
        body_font(pdf, sty, sz)
        pdf.set_text_color(25, 25, 25)
        pdf.multi_cell(TEXT_W, (lead or sz * 1.9), txt, align="C")
        pdf.ln(8)


def notes_page(pdf, prompt):
    pdf.add_page()
    pdf.ln(8)
    body_font(pdf, "B", 12.5)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(TEXT_W, 19, prompt, align="L")
    pdf.ln(10)
    y = pdf.get_y()
    pdf.set_draw_color(170, 170, 170)
    pdf.set_line_width(0.3)
    while y < PAGE_H - MB - 8:
        pdf.line(ML, y, ML + TEXT_W, y)
        y += 26

def parse_md_blocks(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    lines = raw.split("\n")
    blocks = []
    cur = []
    def flush():
        if cur:
            blocks.append(("p", " ".join(cur)))
            cur.clear()
    for ln in lines:
        s = ln.strip()
        if s.startswith("# "):
            flush()
            blocks.append(("p", s))
        elif s.startswith("## "):
            flush()
            blocks.append(("p", s))
        elif s == "":
            flush()
        else:
            cur.append(s)
    flush()
    if cur:
        blocks.append(("p", " ".join(cur)))
    return blocks

def render_blocks(pdf, blocks):
    i = 0
    first_para_after_head = True
    while i < len(blocks):
        kind, text = blocks[i]
        if text.startswith("## "):
            section_head(pdf, text[3:])
            first_para_after_head = True
        elif re.match(r"^\d+\.\s", text) or text.startswith("Day "):
            if text.startswith("Day "):
                paragraph(pdf, text)
            else:
                list_item(pdf, text)
        elif re.match(r"^[A-Z][a-z]+ \d+:\d+", text):  # scripture index lines
            list_item(pdf, text)
        else:
            paragraph(pdf, text)
        i += 1

def build_chapter(pdf, path, register, chnum=None):
    blocks = parse_md_blocks(path)
    # first block is "# CHAPTER ..." title
    title = blocks[0][1][2:]
    epigraph = None
    rest = blocks[1:]
    if rest and rest[0][1].startswith('"'):
        epigraph = rest[0][1]
        rest = rest[1:]
    parts = title.split(" — ")
    t = parts[0]
    sub = parts[1] if len(parts) > 1 else None
    if chnum and chnum in GMAP and GMAP[chnum]:
        gblocks = [("p", "## VOICES FROM THE WIDE WORLD")] + [("p", g) for g in GMAP[chnum]]
        idx = None
        for j, (kk, tt) in enumerate(rest):
            if tt.startswith("## REFLECT AND ACT"):
                idx = j
                break
        if idx is None:
            rest = rest + gblocks
        else:
            rest = rest[:idx] + gblocks + rest[idx:]
    opener(pdf, t, sub, epigraph, register=register)
    # handle any additional top-level "# " sections inside the file
    i = 0
    while i < len(rest):
        kind, text = rest[i]
        if text.startswith("# ") and not text.startswith("## "):
            t2 = text[2:]
            opener(pdf, t2.split(" — ")[0], t2.split(" — ")[1] if " — " in t2 else None, None)
            i += 1
            while i < len(rest) and not rest[i][1].startswith("#"):
                render_blocks(pdf, [rest[i]])
                i += 1
        else:
            render_blocks(pdf, [rest[i]])
            i += 1
    # pre-render injection handled above via rest list rebuild below

    if t.startswith("CHAPTER"):
        notes_page(pdf, "MY NOTES ON " + t.upper() + "\nWhat God said to me here, and what I will do about it:")

def build_pass(pass_num, toc_entries=None):
    pdf = Book(pass_num, toc_entries)
    add_fonts(pdf)
    pdf.set_text_color(25, 25, 25)

    # --- Front cover (full-bleed)
    if not os.environ.get("KDP_INTERIOR"):
        pdf.add_page()
        pdf.image(os.path.join(BASE, "cover_front.png"), x=0, y=0, w=PAGE_W, h=PAGE_H)

    # --- Title page
    center_page(pdf, [
        ("THE PORTION PRINCIPLE", "B", 24),
        ("", "", 8),
        ("Twelve Foundations of Wealth That Serves a Purpose", "", 14),
        ("", "", 20),
        ("SAMUEL AMOS", "", 15),
    ], start_lns=2)
    # --- Copyright page
    pdf.add_page()
    pdf.ln(300)
    body_font(pdf, "", 8.6)
    pdf.multi_cell(TEXT_W, 13.5,
        "The Portion Principle: Twelve Foundations of Wealth That Serves a Purpose\n\n"
        "Copyright © 2026 Samuel Amos. All rights reserved. No part of this book may be reproduced, stored in a retrieval system, or transmitted in any form or by any means — electronic, mechanical, photocopying, recording or otherwise — without the prior written permission of the author, except for brief quotations in reviews and teaching.\n\n"
        "Scripture quotations are from the King James Version of the Holy Bible (public domain), unless otherwise noted.\n\n"
        "First edition, 2026. Written in Uyo, Akwa Ibom State, Nigeria.", align="C")

    # --- TOC placeholder (real TOC rendered in pass 2)
    if pass_num in (2, 3):
        pdf.add_page()
        pdf.register_toc__ = None
        body_font(pdf, "B", 17)
        pdf.cell(TEXT_W, 24, "Contents", align="L")
        pdf.ln(30)
        for title, level, pg in toc_entries:
            body_font(pdf, "", 10.2)
            if level == 1:
                pdf.cell(10, 16.5, "")
            avail = TEXT_W - 34 - (10 if level else 0)
            shown = title
            while pdf.get_string_width(shown) > avail:
                shown = shown.rsplit(" ", 1)[0]
            pdf.cell(avail, 16.5, shown)
            pdf.cell(34, 16.5, str(pg), align="R")
            pdf.ln(16.5)
        n_toc_pages = pdf.page_no()
    else:
        toc_entries = []
        n_toc_pages = None

    # --- Dedication
    center_page(pdf, [
        ("To every young person with a dream", "", 13),
        ("bigger than their pocket,", "", 13),
        ("and to the One who gives the power to get wealth,", "", 13),
        ("that His covenant may be established on the earth.", "", 13),
    ], start_lns=3)

    # --- Front matter sections
    front = parse_md_blocks(os.path.join(MS, "00_front.md"))
    # skip title/copyright/dedication blocks (already rendered): start from FOREWORD
    start = 0
    for idx, (k, t) in enumerate(front):
        if t.startswith("## FOREWORD"):
            start = idx
            break
    sec_titles = {
        "FOREWORD: THE NIGHT OF THE QUESTION": "Foreword: The Night of the Question",
        "ABOUT THE AUTHOR": "About the Author",
        "HOW TO READ THIS BOOK": "How to Read This Book",
    }
    i = start
    while i < len(front):
        kind, text = front[i]
        if text.startswith("## "):
            name = text[3:]
            tocname = sec_titles.get(name, name)
            opener(pdf, tocname if tocname == name else tocname.split(":")[0], None, None, register=tocname.split(":")[0] if ":" in tocname else tocname)
            i += 1
            while i < len(front) and not front[i][1].startswith("## "):
                t2 = front[i][1]
                if re.match(r"^\d+\.\s", t2):
                    list_item(pdf, t2)
                else:
                    paragraph(pdf, t2)
                i += 1
        else:
            i += 1

    # --- Introduction + Q&A
    iq = parse_md_blocks(os.path.join(MS, "00b_intro_qa.md"))
    build_chapter(pdf, os.path.join(MS, "00b_intro_qa.md"), register="Introduction: Why Scripture Speaks of Money")

    # --- Chapters 1-12
    for n in range(1, 13):
        p = os.path.join(MS, f"{n:02d}_chapter.md")
        blks = parse_md_blocks(p)
        title = blks[0][1][2:]
        CH_TITLES = {1:"The Power to Get Wealth",2:"Money Must Multiply, Not Sleep",3:"Sow in Famine",4:"Count the Cost",5:"The Ant's Reserve",6:"Hasty Wealth Shrinks",7:"Debt Is a Master",8:"Faithful in Little",9:"Contentment, the Bodyguard",10:"The Tap That Never Runs Dry",11:"Counsel Before Currency",12:"Skill Stands Before Kings"}
        short = "Chapter %d: %s" % (n, CH_TITLES[n])
        build_chapter(pdf, p, register=short, chnum=n)

    # --- Summary
    blks = parse_md_blocks(os.path.join(MS, "13_summary.md"))
    head13 = blks[0][1][2:].split(" — ")[0]
    n13, _, name13 = head13.partition(":")
    stitle = "Chapter 13: The One Sentence"
    build_chapter(pdf, os.path.join(MS, "13_summary.md"), register=stitle)

    # --- Back matter
    back = parse_md_blocks(os.path.join(MS, "14_back.md"))
    toc_map = {
        "THIRTY DAYS ON THE NARROW ROAD — A Reading and Action Plan": "Thirty Days on the Narrow Road",
        "THE STEWARD'S JOURNAL — Guided Pages": "The Steward's Journal",
        "THIRTY DAYS ON THE NARROW ROAD": "Thirty Days on the Narrow Road",
        "THE STEWARD'S JOURNAL": "The Steward's Journal",
        "A PRAYER FOR WEALTH WITH A PURPOSE": "A Prayer for Wealth with a Purpose",
        "A LETTER TO THE YOUNG BUILDER": "A Letter to the Young Builder",
        "SCRIPTURE INDEX": "Scripture Index",
    }
    # render back matter: section heads become mini-openers (new page each)
    i = 0
    while i < len(back):
        kind, text = back[i]
        if text.startswith("## "):
            name = text[3:]
            reg = toc_map.get(name, name)
            opener(pdf, name if name not in toc_map else reg, None, None, register=reg)
            i += 1
            while i < len(back) and not back[i][1].startswith("## "):
                t2 = back[i][1]
                if re.match(r"^\d+\.\s", t2) or re.match(r"^[A-Z][a-z]+ \d+", t2):
                    list_item(pdf, t2)
                elif t2.startswith("Day "):
                    paragraph(pdf, t2)
                else:
                    paragraph(pdf, t2)
                i += 1
        else:
            i += 1


    # --- Study guide, hundred verses, teaching outlines
    study = parse_md_blocks(os.path.join(MS, "15_study.md"))
    i = 0
    while i < len(study):
        kind, text = study[i]
        if text.startswith("## ") or text.startswith("# "):
            name = text[3:] if text.startswith("## ") else text[2:]
            opener(pdf, name if not name.startswith("GROUP") else "Group Study Guide", None, None,
                   register="Group Study Guide" if name.startswith("GROUP") else ("The Hundred Verses" if name.startswith("THE HUNDRED") else "Teaching Outlines"))
            i += 1
            while i < len(study) and not study[i][1].startswith("#"):
                t2 = study[i][1]
                if re.match(r"^WITH CHAPTER", t2):
                    pdf.ln(2); body_font(pdf, "B", 12.2); pdf.multi_cell(TEXT_W, 19, t2, align="L"); pdf.ln(3)
                elif re.match(r"^(SEMINAR|CHAPTER)", t2):
                    pdf.ln(6); body_font(pdf, "B", 12.6); pdf.multi_cell(TEXT_W, 19, t2, align="L"); pdf.ln(4)
                elif re.match(r"^\d+\.", t2):
                    list_item(pdf, t2)
                elif re.match(r"^[1-3A-Z][a-zA-Z ]+ \d+:\d+", t2) or re.match(r"^(Deuteronomy|Genesis|Proverbs|Matthew|Luke|Psalms?|2 Kings|1 Timothy|Romans|Galatians|Ecclesiastes|Zechariah|Philippians|Hebrews|Malachi|2 Corinthians|1 Corinthians|Exodus|Daniel|Colossians|Nehemiah|Job|Haggai|James|Acts|1 Kings|Song) \d+", t2):
                    list_item(pdf, t2)
                else:
                    paragraph(pdf, t2)
                i += 1
        else:
            i += 1


    # --- Character studies + 40-day devotional
    chars = parse_md_blocks(os.path.join(MS, "16_characters_devotional.md"))
    main_sections = ("MONEY IN THE LIVES OF SIX", "THE PORTION PRINCIPLE DEVOTIONAL")
    i = 0
    while i < len(chars):
        kind, text = chars[i]
        if text.startswith("## ") or text.startswith("# "):
            name = text[3:] if text.startswith("## ") else text[2:]
            if name.startswith(main_sections):
                reg = "Money in the Lives of Six" if name.startswith("MONEY") else "The Portion Principle Devotional: 40 Days"
                opener(pdf, reg, None, None, register=reg)
            else:
                pdf.add_page()
                pdf.ln(40)
                body_font(pdf, "B", 15.5)
                pdf.set_text_color(20, 20, 20)
                pdf.multi_cell(TEXT_W, 21, name, align="L")
                pdf.ln(8)
            i += 1
            while i < len(chars) and not chars[i][1].startswith("#"):
                paragraph(pdf, chars[i][1])
                i += 1
        else:
            i += 1

    # --- The Wide Shelf: further reading
    if SHELF:
        opener(pdf, "THE WIDE SHELF — Recommended Reading from the Wide World", None, None, register="The Wide Shelf: Further Reading")
        render_blocks(pdf, [("p", s) for s in SHELF])

    # --- Back cover (full-bleed, no page number)
    if not os.environ.get("KDP_INTERIOR"):
        pdf.suppress_footer = True
        pdf.add_page()
        pdf.image(os.path.join(BASE, "cover_back.png"), x=0, y=0, w=PAGE_W, h=PAGE_H)

    return pdf

# ---- load global voices (chapter -> blocks)
def load_global():
    blocks = parse_md_blocks(os.path.join(MS, "17_global.md"))
    gmap = {}
    shelf = []
    cur = None
    for k, t in blocks:
        if t.startswith("## FOR CHAPTER "):
            try:
                n = int(t.split()[3])
            except Exception:
                n = None
            cur = n
            gmap.setdefault(n, [])
        elif t.startswith("# ") or t.startswith("## "):
            cur = "shelf"
            shelf = []
        else:
            if cur == "shelf" or cur is None:
                shelf.append(t)
            else:
                gmap[cur].append(t)
    return gmap, shelf

GMAP, SHELF = load_global()

# ---- PASS 1 (layout without TOC) -> entry count
pdf1 = build_pass(1)
entries1 = pdf1.collected
fake = [(t, l, p + 1) for (t, l, p) in entries1]  # any numbers; only layout matters

# ---- PASS 2 (with TOC) -> TRUE page positions
pdf2 = build_pass(2, fake)
truth = [(t, l, p) for (t, l, p) in pdf2.collected]

# ---- PASS 3 (final, TOC shows true positions)
pdf3 = build_pass(3, truth)
pages = pdf3.page_no()
pdf3.output(OUT)
print(f"pass1 entries: {len(entries1)}")
print(f"FINAL PAGES: {pages}")
print(f"output: {OUT}, size: {os.path.getsize(OUT)/1024/1024:.2f} MB")

total_words = 0
for f in sorted(os.listdir(MS)):
    with open(os.path.join(MS, f), encoding="utf-8") as fh:
        total_words += len(fh.read().split())
print("total manuscript words:", total_words)
