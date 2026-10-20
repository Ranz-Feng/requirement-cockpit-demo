#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""归一化需求文档生成所需的三份输入材料。

产出:
  <out>/input-bundle.md    带内部定位标记的原文集合
  <out>/input-index.json   材料清单与统计信息

用法:
  python3 prepare_inputs.py \\
    --pdf 原型.pdf \\
    --transcript 评审录音.srt \\
    --history 历史需求拆解.docx \\
    --title "需求主题" \\
    --out ./work
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime


# ---------------------------------------------------------------- 通用工具


def die(msg):
    sys.stderr.write("[prepare_inputs] %s\n" % msg)
    sys.exit(1)


def read_text_file(path):
    for enc in ("utf-8", "utf-8-sig", "gb18030", "utf-16"):
        try:
            with open(path, "r", encoding=enc) as fh:
                return fh.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def file_meta(path):
    stat = os.stat(path)
    return {
        "path": os.path.abspath(path),
        "filename": os.path.basename(path),
        "size_bytes": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
    }


def normalize_timestamp(ts):
    """把 00:01:02,500 / 00:01:02.500 / 1:02 统一成 HH:MM:SS。"""
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    try:
        parts = [float(p) for p in parts]
    except ValueError:
        return ts
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h, m, s = 0, parts[0], parts[1]
    else:
        h, m, s = 0, 0, parts[0]
    return "%02d:%02d:%02d" % (int(h), int(m), int(s))


# ---------------------------------------------------------------- PDF


def text_quality(text):
    """评估提取文本的可信度（0~1）。中文乱码会显著拉低分数。"""
    total = 0
    good = 0
    noise = 0
    for ch in text:
        if ch.isspace():
            continue
        total += 1
        code = ord(ch)
        if 0x20 <= code <= 0x7E:
            good += 1
        elif 0x4E00 <= code <= 0x9FFF or 0x3000 <= code <= 0x303F or 0xFF00 <= code <= 0xFFEF:
            good += 1
        elif 0x80 <= code <= 0x2FF or 0xE000 <= code <= 0xF8FF or code == 0xFFFD:
            noise += 1
    if not total:
        return 0.0
    return max(0.0, good / total - 2.0 * (noise / total))


def _extract_with_engine(path, engine):
    if engine == "pypdf":
        from pypdf import PdfReader

        reader = PdfReader(path)
        pages = []
        for i, page in enumerate(reader.pages, start=1):
            try:
                pages.append((i, page.extract_text() or ""))
            except Exception:  # noqa: BLE001
                pages.append((i, ""))
        return pages

    import fitz  # PyMuPDF

    doc = fitz.open(path)
    try:
        return [(i + 1, doc.load_page(i).get_text() or "") for i in range(doc.page_count)]
    finally:
        doc.close()


def extract_pdf(path):
    """依次尝试各解析引擎，按文本质量择优返回 (pages, engine, notes)。"""
    notes = []
    candidates = []
    for engine in ("pypdf", "pymupdf"):
        try:
            pages = _extract_with_engine(path, engine)
        except ImportError:
            notes.append("%s 未安装" % engine)
            continue
        except Exception as exc:  # noqa: BLE001
            notes.append("%s 失败: %s" % (engine, exc))
            continue
        joined = "\n".join(t for _, t in pages)
        score = text_quality(joined)
        candidates.append((score, sum(len(t.strip()) for _, t in pages), engine, pages))
        notes.append("%s 质量分 %.2f" % (engine, score))

    if not candidates:
        raise RuntimeError("PDF 文本提取失败: " + "; ".join(notes))

    candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
    score, _, engine, pages = candidates[0]
    if score < 0.5:
        notes.append(
            "所有引擎提取质量分均低于 0.5（最高 %s=%.2f），文档可能是扫描件或使用特殊编码，需要 OCR 或人工核对。"
            % (engine, score)
        )
    if len(candidates) > 1:
        notes.append("已选用质量分最高的引擎：%s" % engine)
    return pages, engine, score, notes


def render_pdf_section(path, errors):
    pages, engine, score, notes = extract_pdf(path)
    errors.extend(notes)
    total_chars = sum(len(t.strip()) for _, t in pages)
    lines = []
    for page_no, text in pages:
        lines.append("[[PAGE %d]]" % page_no)
        body = re.sub(r"\n{3,}", "\n\n", text.strip())
        lines.append(body if body else "（本页无可提取文本，可能为纯图片或扫描件）")
        lines.append("")
    if total_chars < 40 * len(pages):
        errors.append(
            "原型 PDF 每页平均字符数偏低（%d 字符 / %d 页），可能是扫描件，需要 OCR。"
            % (total_chars, len(pages))
        )
    return {
        "text": "\n".join(lines),
        "engine": engine,
        "quality": round(score, 2),
        "pages": len(pages),
        "text_chars": total_chars,
    }


# ---------------------------------------------------------------- 转写


SRT_TIME = re.compile(
    r"(\d{1,2}:\d{2}(?::\d{2})?[.,]?\d*)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]?\d*)"
)


def parse_timed_text(raw):
    """解析 srt / vtt 为 [(start, text)]；解析失败返回 None。"""
    if "-->" not in raw:
        return None
    blocks = re.split(r"\n\s*\n", raw.replace("\r\n", "\n").replace("\r", "\n"))
    cues = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        if lines[0].strip().upper().startswith("WEBVTT"):
            lines = lines[1:]
            if not lines:
                continue
        time_idx = None
        for idx, line in enumerate(lines):
            if "-->" in line:
                time_idx = idx
                break
        if time_idx is None:
            continue
        match = SRT_TIME.search(lines[time_idx])
        start = normalize_timestamp(match.group(1)) if match else ""
        text = " ".join(ln.strip() for ln in lines[time_idx + 1 :]).strip()
        text = re.sub(r"<[^>]+>", "", text)  # 去掉 vtt 内联标签
        if text:
            cues.append((start, text))
    return cues or None


def read_docx(path):
    from docx import Document

    doc = Document(path)
    parts = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if text:
            parts.append(text)
    for t_idx, table in enumerate(doc.tables, start=1):
        parts.append("[表%d]" % t_idx)
        for row in table.rows:
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            parts.append("| " + " | ".join(cells) + " |")
    return "\n".join(parts)


def render_transcript_section(path, errors):
    ext = os.path.splitext(path)[1].lower()

    if ext == ".docx":
        raw = read_docx(path)
        cues = parse_timed_text(raw)
    else:
        raw = read_text_file(path)
        cues = parse_timed_text(raw)

    if cues:
        lines = []
        prev = None
        for start, text in cues:
            if text == prev:  # 去掉重复行
                continue
            prev = text
            lines.append("[[%s]] %s" % (start or "无时间戳", text))
        return {
            "text": "\n".join(lines),
            "format": "timed",
            "segments": len(lines),
            "text_chars": sum(len(t) for _, t in cues),
        }

    # 无时间戳：内部用段落编号定位
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\n", raw) if p.strip()]
    lines = ["[[段落 %d]] %s" % (i, p) for i, p in enumerate(paragraphs, start=1)]
    errors.append("转写材料无时间戳，内部改用段落编号定位；最终正文仍只标 `[评审会议录音]`。")
    return {
        "text": "\n".join(lines),
        "format": "paragraph",
        "segments": len(lines),
        "text_chars": sum(len(p) for p in paragraphs),
    }


# ---------------------------------------------------------------- 历史文档


def render_history_section(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        raw = read_docx(path)
    else:
        raw = read_text_file(path)
    raw = re.sub(r"\n{3,}", "\n\n", raw.strip())
    return {
        "text": raw,
        "text_chars": len(raw),
        "headings": len(re.findall(r"(?m)^#{1,6}\s", raw)),
    }


# ---------------------------------------------------------------- 主流程


def build_bundle(args):
    errors = []
    index = {
        "title": args.title,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "inputs": {},
        "warnings": errors,
    }
    sections = []

    header = [
        "# 输入材料归一化集合",
        "",
        "- 需求主题：%s" % args.title,
        "- 生成时间：%s" % index["generated_at"],
        "- 生成脚本：algo-requirement-spec/scripts/prepare_inputs.py",
        "",
        "> 本文件由脚本自动生成，只做归一化与内部定位标注，不做任何分析或改写。",
        "> `[[PAGE n]]`、`[[HH:MM:SS]]`、`[[段落 n]]` 只作内部定位，不得写入最终文档。",
        "> 最终正文只使用 `[原型]`、`[评审会议录音]`；历史拆解只参考结构和写法。",
        "",
    ]

    # 1. 原型
    sections.append("## 一、需求原型 PDF")
    sections.append("")
    if args.pdf:
        for path in args.pdf:
            if not os.path.isfile(path):
                die("找不到原型 PDF：%s" % path)
            meta = file_meta(path)
            result = render_pdf_section(path, errors)
            if len(args.pdf) > 1:
                sections.append("### 文件：%s" % meta["filename"])
                sections.append("")
            sections.append(
                "（引擎：%s，文本质量分：%.2f，页数：%d，文本字符数：%d）"
                % (result["engine"], result["quality"], result["pages"], result["text_chars"])
            )
            sections.append("")
            sections.append(result["text"])
            sections.append("")
            meta.update(
                {
                    "engine": result["engine"],
                    "text_quality": result["quality"],
                    "pages": result["pages"],
                    "text_chars": result["text_chars"],
                }
            )
            index["inputs"].setdefault("prototype_pdf", []).append(meta)
    else:
        sections.append("（未提供原型 PDF）")
        sections.append("")
        errors.append("缺少原型 PDF：界面与状态相关结论只能按历史写法保守处理，没有依据的留空。")

    # 2. 评审录音转写
    sections.append("## 二、需求评审录音内容（转写）")
    sections.append("")
    if args.transcript:
        path = args.transcript
        if not os.path.isfile(path):
            die("找不到评审转写文件：%s" % path)
        meta = file_meta(path)
        result = render_transcript_section(path, errors)
        sections.append(
            "（格式：%s，片段数：%d，文本字符数：%d）"
            % (result["format"], result["segments"], result["text_chars"])
        )
        sections.append("")
        sections.append(result["text"])
        sections.append("")
        meta.update(
            {
                "format": result["format"],
                "segments": result["segments"],
                "text_chars": result["text_chars"],
            }
        )
        index["inputs"]["transcript"] = meta
    else:
        sections.append("（未提供评审录音转写）")
        sections.append("")
        errors.append("缺少评审转写：业务口径可能过期，全部结论需标注未经最新评审确认。")

    # 3. 历史拆解文档
    sections.append("## 三、历史人工需求拆解文档")
    sections.append("")
    if args.history:
        path = args.history
        if not os.path.isfile(path):
            die("找不到历史拆解文档：%s" % path)
        meta = file_meta(path)
        result = render_history_section(path)
        sections.append(
            "（标题层级数：%d，文本字符数：%d）" % (result["headings"], result["text_chars"])
        )
        sections.append("")
        sections.append("> 本段仅作结构与命名参考，具体业务结论不继承。")
        sections.append("")
        sections.append(result["text"])
        sections.append("")
        meta.update({"text_chars": result["text_chars"], "headings": result["headings"]})
        index["inputs"]["history_doc"] = meta
    else:
        sections.append("（未提供历史拆解文档）")
        sections.append("")
        errors.append("缺少历史拆解文档：结构参考缺失，不阻塞，但需自行补齐拆解维度。")

    bundle = "\n".join(header + sections)

    os.makedirs(args.out, exist_ok=True)
    bundle_path = os.path.join(args.out, "input-bundle.md")
    with open(bundle_path, "w", encoding="utf-8") as fh:
        fh.write(bundle)

    index["outputs"] = {"input_bundle": bundle_path}
    index["bundle_chars"] = len(bundle)
    index_path = os.path.join(args.out, "input-index.json")
    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)

    return bundle_path, index_path, index


def main():
    parser = argparse.ArgumentParser(
        description="归一化需求文档生成所需的三份输入材料"
    )
    parser.add_argument("--pdf", action="append", help="原型 PDF，可重复传入")
    parser.add_argument("--transcript", help="评审录音转写（srt/vtt/txt/md/docx/json）")
    parser.add_argument("--history", help="历史人工需求拆解文档（docx/md/txt）")
    parser.add_argument("--title", default="未命名需求", help="需求主题")
    parser.add_argument("--out", default=".", help="输出目录")
    args = parser.parse_args()

    if not any([args.pdf, args.transcript, args.history]):
        parser.error("至少需要提供 --pdf / --transcript / --history 中的一项")

    bundle_path, index_path, index = build_bundle(args)

    print("[prepare_inputs] 需求主题：%s" % index["title"])
    for key, label in (
        ("prototype_pdf", "原型 PDF"),
        ("transcript", "评审转写"),
        ("history_doc", "历史拆解"),
    ):
        value = index["inputs"].get(key)
        if value:
            items = value if isinstance(value, list) else [value]
            for item in items:
                print(
                    "  - %s：%s（%d 字符）"
                    % (label, item["filename"], item.get("text_chars", 0))
                )
        else:
            print("  - %s：未提供" % label)
    if index["warnings"]:
        print("[prepare_inputs] 提醒：")
        for warning in index["warnings"]:
            print("  ! %s" % warning)
    print("[prepare_inputs] 输出：%s" % bundle_path)
    print("[prepare_inputs] 索引：%s" % index_path)


if __name__ == "__main__":
    main()
