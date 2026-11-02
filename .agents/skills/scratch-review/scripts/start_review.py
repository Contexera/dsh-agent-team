#!/usr/bin/env python3
"""Allocate a new review report for a .scratch work item or ticket."""

import argparse
import re
import sys
from pathlib import Path

TICKET_RE = re.compile(r"\d+-[a-z0-9-]+\.md$")


def resolve_target(value):
    target = Path(value).expanduser().resolve(strict=True)
    if target.is_file():
        if target.parent.name != "issues" or not TICKET_RE.fullmatch(target.name):
            raise ValueError("a file target must be an issues/NN-<slug>.md ticket")
        work_item = target.parent.parent
        scope = target.stem
    elif target.is_dir():
        work_item = target
        scope = target.name
    else:
        raise ValueError("target must be a work-item directory or ticket file")

    if work_item.parent.name == "active":
        scratch = work_item.parent.parent
    elif (
        work_item.parent.parent.name == "archive"
        and re.fullmatch(r"\d{4}-\d{2}", work_item.parent.name)
    ):
        scratch = work_item.parent.parent.parent
    else:
        scratch = None
    if scratch is None or scratch.name != ".scratch":
        raise ValueError("target must be under .scratch/active/ or .scratch/archive/YYYY-MM/")
    if not (work_item / "README.md").is_file():
        raise ValueError("work item must contain README.md")
    return work_item, scope


def allocate_report(work_item, scope):
    reviews = work_item / "reviews"
    reviews.mkdir(exist_ok=True)
    numbers = [
        int(match.group(1))
        for path in reviews.iterdir()
        if (match := re.match(r"(\d+)-.+\.md$", path.name))
    ]
    number = max(numbers, default=0) + 1
    suffix = "" if number == 1 else "-recheck"
    report = reviews / f"{number:02d}-{scope}{suffix}.md"
    report.touch(exist_ok=False)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="work-item directory or issues/NN-<slug>.md")
    args = parser.parse_args()
    try:
        work_item, scope = resolve_target(args.target)
        report = allocate_report(work_item, scope)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"work item: {work_item}")
    print(f"report: {report}")


if __name__ == "__main__":
    sys.exit(main())
