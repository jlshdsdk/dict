# -*- coding: utf-8 -*-
"""把 book/*.zip(JSON Lines)精简转换为网站静态数据:
   site/data/manifest.json + site/data/books/<id>.json
字段精简:w 单词 us 美音 uk 英音 tr 释义 sen 例句 rex 真题例句 syn 同近 rel 同根
"""
import json, os, sys, zipfile

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\dict"
BOOK_DIR = os.path.join(ROOT, "book")
OUT = os.path.join(ROOT, "data")  # 网站文件已移到仓库根目录(GitHub Pages 从根部署)

# 只保留大学及以后阶段的词书(用户指定:排除小学/初中/高中/四级)
KEEP_GROUPS = {"六级", "考研", "专四", "专八", "雅思", "托福", "GRE", "SAT", "GMAT", "BEC"}
OUT_BOOKS = os.path.join(OUT, "books")
os.makedirs(OUT_BOOKS, exist_ok=True)

# ---- 词书元数据(bookLists.txt) ----
meta = {}
with open(os.path.join(ROOT, "bookLists.txt"), "rb") as f:
    raw = f.read()
for enc in ("utf-8", "gbk", "utf-8-sig"):
    try:
        data = json.loads(raw.decode(enc))
        break
    except Exception:
        continue
for b in data["data"]["normalBooksInfo"]:
    meta[b["id"]] = {
        "t": b.get("title", ""),
        "n": b.get("wordNum", 0),
        "tags": [t["tagName"] for t in b.get("tags", []) if t.get("tagName")],
    }

# ---- 分类规则(按书名+ID 匹配,顺序即优先级) ----
GROUP_RULES = [
    ("小学", ("小学", "XiaoXue")),
    ("初中", ("初中", "中考", "ChuZhong")),
    ("高中", ("高中", "高考", "GaoZhong")),
    ("四级", ("四级", "CET4")),
    ("六级", ("六级", "CET6")),
    ("考研", ("考研", "KaoYan")),
    ("专四", ("专四", "Level4")),
    ("专八", ("专八", "Level8")),
    ("雅思", ("雅思", "IELTS")),
    ("托福", ("托福", "TOEFL")),
    ("GRE", ("GRE",)),
    ("SAT", ("SAT",)),
    ("GMAT", ("GMAT",)),
    ("BEC", ("BEC", "商务英语")),
]

def classify(book_id, title):
    hay = book_id + " " + title
    for group, keys in GROUP_RULES:
        if any(k.lower() in hay.lower() for k in keys):
            return group
    return "其他"

# ---- 遍历 zip ----
manifest = []
skipped, missing_meta = [], []
for fn in sorted(os.listdir(BOOK_DIR)):
    if not fn.lower().endswith(".zip"):
        continue
    path = os.path.join(BOOK_DIR, fn)
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        skipped.append((fn, f"open fail: {e}"))
        continue
    names = [n for n in zf.namelist() if n.lower().endswith(".json")]
    if not names:
        skipped.append((fn, "no json inside"))
        continue
    name = names[0]
    book_id = os.path.splitext(os.path.basename(name))[0]
    try:
        txt = zf.read(name).decode("utf-8")
        lines = [json.loads(l) for l in txt.splitlines() if l.strip()]
    except Exception as e:
        skipped.append((fn, f"parse fail: {e}"))
        continue

    words = []
    for obj in lines:
        try:
            c = obj["content"]["word"]["content"]
        except (KeyError, TypeError):
            continue
        w = {"w": obj.get("headWord") or obj.get("content", {}).get("word", {}).get("wordHead", "")}
        if c.get("usphone"):
            w["us"] = c["usphone"]
        if c.get("ukphone"):
            w["uk"] = c["ukphone"]
        tr = [{"p": t.get("pos", ""), "c": t.get("tranCn", "")} for t in c.get("trans", []) if t.get("tranCn")]
        if tr:
            w["tr"] = tr
        sen = [{"e": s.get("sContent", ""), "c": s.get("sCn", "")}
               for s in c.get("sentence", {}).get("sentences", []) if s.get("sContent")]
        if sen:
            w["sen"] = sen
        rex = []
        for s in c.get("realExamSentence", {}).get("sentences", []):
            if not s.get("sContent"):
                continue
            si = s.get("sourceInfo") or {}
            src = " ".join(x for x in [si.get("level", ""), si.get("year", ""), si.get("type", "")] if x)
            rex.append({"e": s["sContent"], "src": src})
        if rex:
            w["rex"] = rex
        syn = [{"p": s.get("pos", ""), "t": s.get("tran", ""), "ws": [h.get("w", "") for h in s.get("hwds", [])]}
               for s in c.get("syno", {}).get("synos", [])]
        if syn:
            w["syn"] = syn
        rel = [{"p": r.get("pos", ""), "ws": [{"w": x.get("hwd", ""), "t": (x.get("tran") or "").strip()}
                                              for x in r.get("words", [])]}
               for r in c.get("relWord", {}).get("rels", [])]
        if rel:
            w["rel"] = rel
        if w["w"]:
            words.append(w)

    if not words:
        skipped.append((fn, "0 words extracted"))
        continue

    m = meta.get(book_id)
    if not m:
        missing_meta.append(book_id)
        m = {"t": book_id, "n": len(words), "tags": []}
    entry = {"id": book_id, "t": m["t"], "n": len(words), "g": classify(book_id, m["t"])}
    if entry["g"] not in KEEP_GROUPS:
        continue
    manifest.append(entry)

    out_path = os.path.join(OUT_BOOKS, book_id + ".json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"id": book_id, "t": m["t"], "words": words}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{book_id}: {len(words)} words -> {os.path.getsize(out_path)//1024} KB")

# ---- manifest ----
order_idx = {g: i for i, (g, _) in enumerate(GROUP_RULES)}
order_idx["其他"] = 99
manifest.sort(key=lambda e: (order_idx.get(e["g"], 99), -e["n"]))

# 清理不再保留的旧数据文件
keep_ids = {e["id"] + ".json" for e in manifest}
for fn in os.listdir(OUT_BOOKS):
    if fn.endswith(".json") and fn not in keep_ids:
        os.remove(os.path.join(OUT_BOOKS, fn))
        print("removed stale:", fn)
with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"books": manifest}, f, ensure_ascii=False, separators=(",", ":"))

total_words = sum(e["n"] for e in manifest)
total_size = sum(os.path.getsize(os.path.join(OUT_BOOKS, e["id"] + ".json")) for e in manifest)
print(f"\nbooks: {len(manifest)}, total words: {total_words}, total data size: {total_size/1048576:.1f} MB")
print("skipped:", skipped)
print("missing meta:", missing_meta)
