#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""包根目录入口：转发到 scripts/install_agent.py。

用法:
  python3 install_agent.py
  python3 install_agent.py --dry-run
"""

import os
import runpy
import sys


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, "scripts", "install_agent.py")
    sys.argv[0] = target
    runpy.run_path(target, run_name="__main__")


if __name__ == "__main__":
    main()
