#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查需求拆解文档是否符合固定模版。

用法:
  python3 check_output.py <输出文档.md>

退出码:
  0 = 全部通过
  1 = 有❌项，需返工
  2 = 只有⚠️项，可交付但需人工确认
"""

import argparse
import os
import re
import sys

LEVELS = {"ERROR": "❌", "WARN": "⚠️", "OK": "✅"}

REQUIRED_H1 = ["前言", "版本信息", "变更日志", "需求背景", "需求范围", "需求拆解"]
REQUIRED_H2 = ["【功能入口】", "【新增功能】", "【算法】", "【后端】"]
REQUIRED_H3 = ["【算法功能】", "【后端需求】"]

MIN_SUBSECTION_CHARS = {
    "前言": 80,
    "需求背景": 80,
    "【功能入口】": 80,
    "【新增功能】": 150,
    "【算法功能】": 350,
    "【后端需求】": 300,
}

REQUIRED_LABELS = {
    "需求背景": ["最晚评审时间", "开发时间", "联调时间", "端测时间", "平台上线", "合规测试", "CTC验收"],
    "【新增功能】": ["需要建设什么", "流程简要说明", "特殊情况处理"],
    "【算法功能】": ["需要建设的算法功能", "目标算法效果", "大致流程", "算法实验"],
    "【后端需求】": ["需要建设的后端功能", "需要和前端配合", "调用什么模型", "特殊情况处理"],
}


def parse_headings(text):
    headings = []
    for match in re.finditer(r"(?m)^(#{1,6})\s+(.+?)\s*$", text):
        headings.append({
            "level": len(match.group(1)),
            "title": match.group(2).strip(),
            "start": match.end(),
            "heading_start": match.start(),
        })
    for idx, heading in enumerate(headings):
        heading["end"] = headings[idx + 1]["heading_start"] if idx + 1 < len(headings) else len(text)
    return headings


def section_body(text, headings, title):
    for heading in headings:
        if heading["title"] == title:
            return text[heading["start"]:heading["end"]].strip()
    return ""


def count_anchors(text):
    return {
        "原型": len(re.findall(r"\[原型\]", text)),
        "评审会议录音": len(re.findall(r"\[评审会议录音\]", text)),
        "推断": len(re.findall(r"\[推断\]", text)),
        "待确认": len(re.findall(r"\[待确认\]", text)),
    }


def ordered_sequence(actual, expected):
    return actual == expected


def check(text):
    results = []
    headings = parse_headings(text)
    by_title = {heading["title"]: heading for heading in headings}

    # 1. 固定一级章节
    h1 = [h["title"] for h in headings if h["level"] == 1]
    if h1 and h1[0] != "前言":
        prefix_h1 = h1[:h1.index("前言")] if "前言" in h1 else []
        h1 = h1[len(prefix_h1):]

    missing = [title for title in REQUIRED_H1 if title not in h1]
    if missing:
        results.append(("ERROR", "缺少固定一级章节：%s" % "、".join(missing)))
    elif not ordered_sequence(h1, REQUIRED_H1):
        results.append(("ERROR", "一级章节顺序不对：%s，应为 %s" % (" → ".join(h1), " → ".join(REQUIRED_H1))))
    else:
        results.append(("OK", "固定一级章节齐全且顺序正确"))

    # 2. 固定二级章节
    h2 = [h["title"] for h in headings if h["level"] == 2]
    missing_h2 = [title for title in REQUIRED_H2 if title not in h2]
    if missing_h2:
        results.append(("ERROR", "缺少固定二级章节：%s" % "、".join(missing_h2)))
    elif not ordered_sequence(h2, REQUIRED_H2):
        results.append(("ERROR", "二级章节顺序不对：%s，应为 %s" % (" → ".join(h2), " → ".join(REQUIRED_H2))))
    else:
        results.append(("OK", "固定二级章节齐全且顺序正确"))

    # 3. 固定三级章节
    h3 = [h["title"] for h in headings if h["level"] == 3]
    missing_h3 = [title for title in REQUIRED_H3 if title not in h3]
    if missing_h3:
        results.append(("ERROR", "缺少固定三级章节：%s" % "、".join(missing_h3)))
    elif not ordered_sequence(h3, REQUIRED_H3):
        results.append(("ERROR", "三级章节顺序不对：%s，应为 %s" % (" → ".join(h3), " → ".join(REQUIRED_H3))))
    else:
        results.append(("OK", "固定三级章节齐全且顺序正确"))

    # 4. 禁止额外章节、额外标题层级
    allowed = set(REQUIRED_H1) | set(REQUIRED_H2) | set(REQUIRED_H3)
    extras = []
    for heading in headings:
        if heading["level"] >= 4:
            extras.append("#" * heading["level"] + " " + heading["title"])
        elif heading["level"] in (1, 2, 3) and heading["title"] not in allowed:
            if heading["level"] == 1 and heading is headings[0]:
                continue
            extras.append("#" * heading["level"] + " " + heading["title"])
    if extras:
        results.append(("ERROR", "出现固定模版之外的标题：%s" % "、".join(extras[:8])))
    else:
        results.append(("OK", "未出现额外标题，结构只包含规定内容"))

    # 5. 必需内容与实质长度
    thin = []
    missing_labels = []
    for title, labels in REQUIRED_LABELS.items():
        body = section_body(text, headings, title)
        for label in labels:
            if label not in body:
                missing_labels.append("%s/%s" % (title, label))
    if missing_labels:
        results.append(("ERROR", "缺少规定内容：%s" % "、".join(missing_labels)))
    else:
        results.append(("OK", "固定小节的规定内容齐全"))

    for title, min_chars in MIN_SUBSECTION_CHARS.items():
        body = section_body(text, headings, title)
        meaningful = re.sub(r"[|\-\s]", "", body)
        if len(meaningful) < min_chars:
            thin.append("%s 有效字符 %d/%d" % (title, len(meaningful), min_chars))
    if thin:
        results.append(("WARN", "内容偏薄，确认不是只有标题：%s" % "；".join(thin)))
    else:
        results.append(("OK", "核心小节均有实质内容"))

    # 6. 来源锚点（可选：干净成稿版允许不标，只要求前言写清材料来源）
    anchors = count_anchors(text)
    total_source = anchors["原型"] + anchors["评审会议录音"]
    if total_source == 0:
        results.append(("OK", "正文未标来源锚点：允许的干净成稿版，确认前言已写清材料来源即可"))
    elif total_source > 20:
        results.append(("WARN", "来源锚点偏多（共 %d 处），锚点用于内部核对，确认没有逐句堆叠。" % total_source))
    else:
        results.append(
            ("OK", "来源锚点共 %d 处（原型 %d / 评审会议录音 %d），按小节稀疏标注即可"
             % (total_source, anchors["原型"], anchors["评审会议录音"]))
        )

    # 7. 锚点不得带定位信息
    detailed_anchors = re.findall(
        r"\[(?:原型\s+[^\]]+|录音\s+[^\]]+|评审会议录音\s+[^\]]+|历史拆解[^\]]*)\]",
        text,
    )
    if detailed_anchors:
        sample = "、".join(sorted(set(detailed_anchors))[:5])
        results.append(("ERROR", "出现带定位信息的来源锚点：%s。正文只允许 `[原型]` 或 `[评审会议录音]`。" % sample))
    else:
        results.append(("OK", "来源锚点格式统一"))

    # 8. 不能出现固定模版之外的独立章节名称
    forbidden_sections = [
        "效果定义", "测试与验收", "风险与待确认", "待确认清单",
        "证据附录", "研发实现建议", "研发方案",
    ]
    heading_titles = [h["title"] for h in headings if h["level"] in (1, 2, 3)]
    forbidden_hits = [name for name in forbidden_sections if name in heading_titles]
    if forbidden_hits:
        results.append(("ERROR", "出现模版外的独立章节：%s" % "、".join(forbidden_hits)))
    else:
        results.append(("OK", "未新增效果、测试、风险等待确认等独立章节"))

    # 9. 占位符与模板提醒
    placeholders = re.findall(r"<[^<>\n]{1,80}>", text)
    placeholders = [p for p in placeholders if not p.startswith("<http") and not p.startswith("<REQ")]
    if placeholders:
        sample = "、".join(sorted(set(placeholders))[:5])
        results.append(("ERROR", "存在未替换占位符：%s" % sample))
    else:
        results.append(("OK", "无未替换占位符"))

    if "成稿提醒" in text or "成稿时删除" in text:
        results.append(("ERROR", "残留模板提醒，成稿前必须清除。"))
    else:
        results.append(("OK", "无模板提醒残留"))

    # 10. 研发实现越界
    impl_kw = (
        "架构选型", "服务拆分", "表结构", "存储路径", "部署方案",
        "排期承诺", "人力投入", "前端视觉", "视觉稿",
        "接口协议", "错误码", "轮询间隔", "模型架构",
    )
    scope_allowed = (
        "由研发", "待研发", "研发补充", "研发设计", "留给研发", "研发在",
        "不定义", "不写", "不预设", "不含", "不涉及", "未出现",
        "没有自定义", "未自定义", "禁止", "不得",
    )
    hits = []
    for line in text.split("\n"):
        if not line.strip() or any(p in line for p in scope_allowed):
            continue
        for kw in impl_kw:
            if kw in line and kw not in hits:
                hits.append(kw)
    if hits:
        results.append(("WARN", "疑似超出产品视角的关键词：%s" % "、".join(hits)))
    else:
        results.append(("OK", "未见明显超出产品视角的内容"))

    # 11. 不无限嵌套小点（允许一层并列清单，禁止套到两层以上）
    nested_bullets = []
    for line in text.split("\n"):
        if re.match(r"^\s{4,}[-*+]\s+", line):
            nested_bullets.append(line.strip())
    if nested_bullets:
        results.append(("WARN", "出现 %d 处两层以上嵌套分点，建议收敛为一句结论、表格或流程树。" % len(nested_bullets)))
    else:
        results.append(("OK", "分点层级未超过一层"))

    # 11b. 长段落堆叠检测：可枚举内容不该挤成一整段
    long_sections = []
    for title in ("【新增功能】", "【算法功能】", "【后端需求】"):
        body = section_body(text, headings, title)
        limit = 420
        worst = 0
        for line in body.split("\n"):
            stripped = line.strip()
            if not stripped or stripped.startswith("|") or stripped.startswith("```"):
                continue
            worst = max(worst, len(stripped))
        if worst > limit:
            long_sections.append("%s 最长单行 %d 字" % (title, worst))
    if long_sections:
        results.append(
            ("WARN", "存在超长段落，并列或可枚举内容建议改用分点、表格或流程树：%s" % "；".join(long_sections))
        )
    else:
        results.append(("OK", "没有把可枚举内容挤进超长单行"))

    # 11c. 结构丰富度：内容量大时应有表格或流程树承接
    flat_sections = []
    for title in ("【新增功能】", "【算法功能】", "【后端需求】"):
        body = section_body(text, headings, title)
        meaningful = re.sub(r"[|\-\s]", "", body)
        has_table = "|" in body
        has_flow = "```" in body
        has_list = bool(re.search(r"(?m)^\s*(?:[-*+]|\d+\.)\s+", body))
        if len(meaningful) > 900 and not has_table and not has_flow and not has_list:
            flat_sections.append(title)
    if flat_sections:
        results.append(
            ("WARN", "内容量不小但没有用到表格或流程树，确认是否该把对比、取值或链路结构化：%s" % "、".join(flat_sections))
        )
    else:
        results.append(("OK", "内容量较大的小节都用了表格、清单或流程树承接"))

    # 12. [推断] 不应污染效果和实验
    algo_body = section_body(text, headings, "【算法功能】")
    inference_lines = [line.strip() for line in algo_body.split("\n") if "[推断]" in line]
    risky_inference = [
        line for line in inference_lines
        if any(key in line for key in ("目标算法效果", "算法实验", "通过标准", "目标值", "基线"))
    ]
    if risky_inference:
        results.append(("WARN", "算法效果或实验中出现 [推断]，确认它没有作为目标值和通过标准。"))
    else:
        results.append(("OK", "效果与实验未直接使用未验证推断"))

    # 13. 不应出现待确认标记
    if anchors["待确认"]:
        results.append(
            ("WARN", "出现 %d 处 `[待确认]`；材料没给的信息应留空，不在文档里列待确认清单。" % anchors["待确认"])
        )
    else:
        results.append(("OK", "未出现待确认标记，材料缺口按留空处理"))

    return results, anchors


def main():
    parser = argparse.ArgumentParser(description="需求拆解文档固定模版自检")
    parser.add_argument("doc", help="待检查的 Markdown 文档")
    args = parser.parse_args()

    if not os.path.isfile(args.doc):
        sys.stderr.write("找不到文件：%s\n" % args.doc)
        sys.exit(1)

    with open(args.doc, "r", encoding="utf-8") as fh:
        text = fh.read()

    results, anchors = check(text)

    print("== 需求拆解文档自检：%s ==" % os.path.basename(args.doc))
    errors = 0
    warns = 0
    for level, msg in results:
        print("%s %s" % (LEVELS[level], msg))
        if level == "ERROR":
            errors += 1
        elif level == "WARN":
            warns += 1
    print("-" * 48)
    print("来源标记：原型 %d ｜ 评审会议录音 %d ｜ [推断] %d ｜ [待确认] %d"
          % (anchors["原型"], anchors["评审会议录音"], anchors["推断"], anchors["待确认"]))
    print("结果：❌ %d ｜ ⚠️ %d" % (errors, warns))

    if errors:
        sys.exit(1)
    if warns:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
