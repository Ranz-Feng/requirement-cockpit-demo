#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「算法需求拆解专家」注册到本机 WorkBuddy 的 my-experts 市场。

做两件事（幂等，可重复执行）：
  1. 复制本专家包到
     ~/.workbuddy/plugins/marketplaces/my-experts/plugins/algo-requirement-spec/
  2. 在 my-experts/.codebuddy-plugin/marketplace.json 里合并写入本专家条目，
     已存在的其它条目（如 product-agent-team）原样保留。

用法:
  python3 install_agent.py            # 安装/更新
  python3 install_agent.py --dry-run  # 只打印将要做的事，不落盘
  python3 install_agent.py --target /path/to/my-experts  # 指定市场目录

完成后重启 WorkBuddy，在【专家中心】→【我的专家】里选择「算法需求拆解专家」。
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime


PLUGIN_DIR_NAME = "algo-requirement-spec"
MARKETPLACE_NAME = "my-experts"


def die(msg):
    sys.stderr.write("[install_agent] %s\n" % msg)
    sys.exit(1)


def default_marketplace_dir():
    return os.path.join(
        os.path.expanduser("~"),
        ".workbuddy",
        "plugins",
        "marketplaces",
        MARKETPLACE_NAME,
    )


def package_root():
    """专家包根目录 = 本脚本所在 scripts/ 的上一级。"""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    if not os.path.isfile(os.path.join(root, ".codebuddy-plugin", "plugin.json")):
        die("未在 %s 找到 .codebuddy-plugin/plugin.json，请从包内运行本脚本。" % root)
    return root


def load_plugin_meta(root):
    with open(os.path.join(root, ".codebuddy-plugin", "plugin.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def marketplace_entry(meta):
    desc = meta.get("description", "")
    dd = meta.get("displayDescription") or {}
    zh = dd.get("zh") if isinstance(dd, dict) else None
    return {
        "name": meta.get("name", PLUGIN_DIR_NAME),
        "source": "./plugins/%s" % PLUGIN_DIR_NAME,
        "description": zh or desc,
    }


def merge_manifest(path, entry):
    """读入（或新建）marketplace.json，合并 entry，返回合并后的对象。"""
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    else:
        manifest = {
            "name": MARKETPLACE_NAME,
            "description": "%s marketplace (auto-generated)" % MARKETPLACE_NAME,
            "plugins": [],
        }
    manifest.setdefault("name", MARKETPLACE_NAME)
    manifest.setdefault("description", "%s marketplace (auto-generated)" % MARKETPLACE_NAME)
    plugins = manifest.setdefault("plugins", [])
    plugins = [p for p in plugins if p.get("name") != entry["name"]]
    plugins.append(entry)
    manifest["plugins"] = plugins
    return manifest


def copy_package(src, dest, dry_run):
    if os.path.exists(dest):
        if dry_run:
            print("  [dry-run] 将删除已存在的旧包：%s" % dest)
        else:
            shutil.rmtree(dest)
    if dry_run:
        print("  [dry-run] 将复制 %s -> %s" % (src, dest))
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copytree(
        src,
        dest,
        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", ".DS_Store"),
    )


def main():
    parser = argparse.ArgumentParser(description="把算法需求拆解专家注册到 WorkBuddy my-experts 市场")
    parser.add_argument("--target", default=None,
                        help="my-experts 市场目录（默认 ~/.workbuddy/plugins/marketplaces/my-experts）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    args = parser.parse_args()

    root = package_root()
    meta = load_plugin_meta(root)
    market_dir = args.target or default_marketplace_dir()

    dest = os.path.join(market_dir, "plugins", PLUGIN_DIR_NAME)
    manifest_path = os.path.join(market_dir, ".codebuddy-plugin", "marketplace.json")
    entry = marketplace_entry(meta)

    print("专家包源目录：%s" % root)
    print("目标市场目录：%s" % market_dir)
    print("目标插件目录：%s" % dest)
    print("清单文件：    %s" % manifest_path)
    print("")

    # 复制包体
    copy_package(root, dest, args.dry_run)

    # 合并清单
    manifest = merge_manifest(manifest_path, entry)
    if args.dry_run:
        print("  [dry-run] 将写入清单，合并后 entries：%s"
              % ", ".join(p.get("name", "?") for p in manifest["plugins"]))
    else:
        os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print("  已写入清单，含条目：%s"
              % ", ".join(p.get("name", "?") for p in manifest["plugins"]))

    print("")
    if args.dry_run:
        print("dry-run 完成，未改动任何文件。")
    else:
        print("安装完成（%s）。重启 WorkBuddy 后，在【专家中心】→【我的专家】选择「算法需求拆解专家」。"
              % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))


if __name__ == "__main__":
    main()
