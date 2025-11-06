#!/usr/bin/env python3
"""
Build a question→answer graph from trace JSON files.

The script emits a Graphviz DOT representation and can optionally render a PNG
if the `dot` binary is available.

Example:
  python scripts/traces_to_graph.py \
    --traces-dir data/traces \
    --output-dot data/traces_graph.dot \
    --output-png data/traces_graph.png
"""

import argparse
import json
import shutil
import subprocess
import textwrap
from pathlib import Path


def shorten(text: str, width: int = 110) -> str:
    """Collapse whitespace and truncate text for node labels."""
    collapsed = " ".join(text.strip().split())
    if not collapsed:
        return "(empty)"
    if len(collapsed) <= width:
        return collapsed
    return textwrap.shorten(collapsed, width=width, placeholder="…")


def escape_label(text: str) -> str:
    """Escape double quotes and backslashes for DOT labels."""
    return shorten(text).replace("\\", r"\\").replace('"', r"\"")


def load_traces(traces_dir: Path):
    for path in sorted(traces_dir.glob("*.json")):
        try:
            yield path, json.loads(path.read_text())
        except json.JSONDecodeError:
            continue


def build_dot(traces_dir: Path) -> str:
    lines = [
        "digraph Traces {",
        "  rankdir=LR;",
        '  node [shape=box, style="rounded,filled", color="#3f51b5", fillcolor="#eef1fb"];',
        '  edge [color="#5c6bc0"];',
    ]
    for idx, (path, trace) in enumerate(load_traces(traces_dir), start=1):
        q_label = escape_label(trace.get("question", f"Trace {idx} question"))
        a_label = escape_label(trace.get("answer", "No answer recorded"))
        trace_id = escape_label(path.name)
        q_node = f"Q{idx}"
        a_node = f"A{idx}"
        lines.append(f'  {q_node} [label="Q{idx}: {q_label}\\n({trace_id})"];')
        lines.append(f'  {a_node} [label="A{idx}: {a_label}"];')
        lines.append(f"  {q_node} -> {a_node} [label=\"answer\"];")

        chart = trace.get("chart")
        if chart:
            chart_type = chart.get("chart", {}).get("type", "chart")
            chart_node = f"C{idx}"
            lines.append(
                f'  {chart_node} [label="Chart {idx}: {escape_label(chart_type)}", shape=ellipse, fillcolor="#e8f5e9", color="#388e3c"];'
            )
            lines.append(f"  {a_node} -> {chart_node} [label=\"chart\"];")

        tools = trace.get("trace") or []
        for t_idx, entry in enumerate(tools, start=1):
            tool_name = escape_label(entry.get("tool", "tool"))
            tool_node = f"T{idx}_{t_idx}"
            lines.append(
                f'  {tool_node} [label="Tool {t_idx}: {tool_name}", shape=record, fillcolor="#fff3e0", color="#fb8c00"];'
            )
            lines.append(f"  {q_node} -> {tool_node} [style=dashed, label=\"uses\"];")
            lines.append(f"  {tool_node} -> {a_node} [style=dotted, label=\"feeds\"];")

    lines.append("}")
    return "\n".join(lines)


def render_png(dot_path: Path, png_path: Path) -> bool:
    dot_binary = shutil.which("dot")
    if not dot_binary:
        print("Graphviz `dot` executable not found. Skipping PNG render.")
        return False
    subprocess.run([dot_binary, "-Tpng", str(dot_path), "-o", str(png_path)], check=True)
    return True


def main():
    parser = argparse.ArgumentParser(description="Convert trace JSON into a question→answer graph (Graphviz DOT).")
    parser.add_argument("--traces-dir", default="data/traces", type=Path, help="Directory containing trace JSON files.")
    parser.add_argument("--output-dot", default="data/traces_graph.dot", type=Path, help="DOT file to write.")
    parser.add_argument("--output-png", type=Path, help="Optional PNG output (requires graphviz dot).")
    args = parser.parse_args()

    if not args.traces_dir.exists():
        raise SystemExit(f"Trace directory not found: {args.traces_dir}")

    dot_text = build_dot(args.traces_dir)
    if args.output_dot.parent:
        args.output_dot.parent.mkdir(parents=True, exist_ok=True)
    args.output_dot.write_text(dot_text)
    print(f"Wrote DOT graph to {args.output_dot}")

    if args.output_png:
        if args.output_png.parent:
            args.output_png.parent.mkdir(parents=True, exist_ok=True)
        if render_png(args.output_dot, args.output_png):
            print(f"Wrote PNG graph to {args.output_png}")


if __name__ == "__main__":
    main()
