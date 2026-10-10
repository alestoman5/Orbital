"""Records uv-vis/webapp/v_report.py's parse of tasks_summary.tex for test/report/texDoc.test.ts.

    python test/fixtures/report/v_report_parity.py   -> v_report_parity.json next to this file

SECTION, parse_items, parse_blocks and parse are copied VERBATIM from v_report.py (it imports
the web app's common module, so it is not imported).
"""
import json
import re
from pathlib import Path

SECTION = re.compile(r"(?m)^(\\clearpage\n)?\\section\*\{")
def parse_items(lines):
    items = []
    for line in lines:
        m = re.match(r"\s*\\item ?(.*)", line)
        if m:
            items.append(m.group(1))
        elif items:
            items[-1] += "\n" + line   # continuation line, kept verbatim
    return items


def parse_blocks(body):
    lines, blocks, i = body.split("\n"), [], 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        env = re.match(r"\\begin\{(\w+)\}", lines[i])
        j = i + 1
        if env:
            while j < len(lines) and not lines[j].startswith(f"\\end{{{env.group(1)}}}"):
                j += 1
            j += 1
        else:
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("\\begin{"):
                j += 1
        chunk = lines[i:j]
        if env and env.group(1) == "itemize":
            blocks.append({"type": "items", "head": chunk[0], "items": parse_items(chunk[1:-1])})
        else:
            blocks.append({"type": "raw", "tex": "\n".join(chunk)})
        i = j
    return blocks


def parse(text):
    end = text.rindex("\\end{document}")
    first_sec = SECTION.search(text)
    pre, rest = text[:first_sec.start()], text[first_sec.start():end]
    starts = [m for m in SECTION.finditer(rest)] + [None]
    sections = []
    for m, nxt in zip(starts, starts[1:]):
        chunk = rest[m.start():nxt.start() if nxt else len(rest)]
        clearpage = chunk.startswith("\\clearpage\n")
        head, _, body = chunk.removeprefix("\\clearpage\n").partition("\n")
        sections.append({"clearpage": clearpage, "title": head[len("\\section*{"):-1],
                         "blocks": parse_blocks(body)})
    return {"pre": pre, "sections": sections}


here = Path(__file__).parent
doc = parse((here / "tasks_summary.tex").read_text(encoding="utf-8"))
(here / "v_report_parity.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(len(doc["sections"]), "sections")
