# -*- coding: utf-8 -*-
"""检查 bookLists.txt 编码与结构,解压样本词书查看 JSON 结构"""
import json, sys, zipfile, os, io

sys.stdout.reconfigure(encoding="utf-8")

raw = open(r"D:\dict\bookLists.txt", "rb").read()
data = None
for enc in ("utf-8", "gbk", "utf-8-sig"):
    try:
        data = json.loads(raw.decode(enc))
        print("encoding:", enc)
        break
    except Exception as e:
        print(enc, "fail:", type(e).__name__)

books = data["data"]["normalBooksInfo"]
print("book count:", len(books))
for b in books[:10]:
    tags = ",".join(t["tagName"] for t in b.get("tags", []))
    print(f"{b['id']} | {b['title']} | words:{b.get('wordNum')} | tags:{tags}")

# 解压一个样本 zip
sample = r"D:\dict\book\1521164649209_CET4_1.zip"
zf = zipfile.ZipFile(sample)
print("\nzip entries:", zf.namelist())
name = zf.namelist()[0]
txt = zf.read(name).decode("utf-8")
print("file:", name, "chars:", len(txt))
lines = [json.loads(l) for l in txt.splitlines() if l.strip()]
print("line count:", len(lines))
first = lines[0]
print(json.dumps(first, ensure_ascii=False, indent=1)[:4500])
