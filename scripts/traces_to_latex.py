#!/usr/bin/env python3
"""
Generate a LaTeX report summarising trace files under data/traces and embed
charts rendered via pgfplots directly in the LaTeX document.

Usage:
  python scripts/traces_to_latex.py \
    --traces-dir data/traces \
    --output data/traces_report.tex
"""

import argparse
import json
import math
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


def latex_escape(text: str) -> str:
    """Escape characters with special meaning in LaTeX."""
    replacements = {
        "\\": r"\textbackslash{}",
        "{": r"\{",
        "}": r"\}",
        "#": r"\#",
        "$": r"\$",
        "%": r"\%",
        "&": r"\&",
        "_": r"\_",
        "^": r"\^{}",
        "~": r"\textasciitilde{}",
        "°": r"\textdegree{}",
        " ": r"\,",
        "₀": r"$_0$",
        "₁": r"$_1$",
        "₂": r"$_2$",
        "₃": r"$_3$",
        "₄": r"$_4$",
        "₅": r"$_5$",
        "₆": r"$_6$",
        "₇": r"$_7$",
        "₈": r"$_8$",
        "₉": r"$_9$",
    }
    return "".join(replacements.get(ch, ch) for ch in text)


def to_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isfinite(num):
        return num
    return None


def to_datetime(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if abs(value) > 1e12 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        val = value.strip()
        if not val:
            return None
        try:
            if val.endswith("Z"):
                val = val[:-1] + "+00:00"
            return datetime.fromisoformat(val)
        except ValueError:
            return None
    return None


def resolve_matching_tool_entry(
    entries: Sequence[Dict], data_ref: Dict, series_def: Dict
) -> Dict:
    if len(entries) == 1:
        return entries[0]
    y_field = data_ref.get("yField")
    field = data_ref.get("field")
    series_name = series_def.get("name")
    for entry in reversed(entries):
        args = entry.get("args", {})
        fields = args.get("fields") or []
        if field and args.get("field") == field:
            return entry
        if y_field and y_field in fields:
            return entry
        if series_name and isinstance(args.get("series"), list):
            for item in args["series"]:
                if isinstance(item, dict) and item.get("name") == series_name:
                    return entry
    return entries[-1]


def resolve_series_data(result, data_ref: Dict, series_def: Dict):
    field_key = data_ref.get("field")
    series_name = series_def.get("name")
    y_field = data_ref.get("yField")

    if field_key and isinstance(result, dict) and field_key in result:
        result = result[field_key]

    if isinstance(result, dict):
        if series_name and series_name in result:
            result = result[series_name]
        elif y_field and y_field in result and isinstance(result[y_field], list):
            result = result[y_field]
        elif isinstance(result.get("series"), list):
            result = result["series"]

    return result if isinstance(result, list) else None


def collect_raw_entries(series_data, x_field: Optional[str], y_field: Optional[str]):
    raw_entries = []
    for item in series_data:
        x_value = None
        y_value = None
        if isinstance(item, dict):
            if x_field:
                x_value = item.get(x_field)
            else:
                for key in ("x", "ts", "category", "label"):
                    if key in item:
                        x_value = item.get(key)
                        if x_value is not None:
                            break
            if y_field:
                y_value = item.get(y_field)
            else:
                for key in ("y", "value"):
                    if key in item:
                        y_value = item.get(key)
                        if y_value is not None:
                            break
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            x_value, y_value = item[0], item[1]
        else:
            continue
        if y_value is None:
            continue
        val = to_float(y_value)
        if val is None:
            continue
        raw_entries.append((x_value, val))
    return raw_entries


def extract_series_points(
    trace_data: Dict, series_def: Dict
) -> Optional[Dict]:
    data_ref = series_def.get("dataRef")
    inline_data = series_def.get("data")
    if not data_ref and not inline_data:
        return None

    series_data = None
    x_field: Optional[str] = None
    y_field: Optional[str] = None

    if data_ref:
        tool = data_ref.get("tool")
        if not tool:
            return None

        entries = [entry for entry in trace_data.get("trace", []) if entry.get("tool") == tool]
        if not entries:
            return None

        entry = resolve_matching_tool_entry(entries, data_ref, series_def)
        result = entry.get("result")
        if result is None:
            return None

        series_data = resolve_series_data(result, data_ref, series_def)
        if not series_data:
            return None

        x_field = data_ref.get("xField") or "ts"
        y_field = data_ref.get("yField")
    elif isinstance(inline_data, list):
        series_data = inline_data
        x_field = series_def.get("xField")
        y_field = series_def.get("yField")

    if not series_data:
        return None

    raw_entries = collect_raw_entries(series_data, x_field, y_field)
    if not raw_entries:
        return None

    datetime_entries = []
    numeric_entries = []
    category_entries = []
    for x_value, val in raw_entries:
        dt = to_datetime(x_value)
        if dt is not None:
            datetime_entries.append((dt, val))
            continue
        num = to_float(x_value)
        if num is not None:
            numeric_entries.append((num, val))
            continue
        label = str(x_value) if x_value is not None else ""
        category_entries.append((label, val))

    total = len(raw_entries)
    mode = None
    if datetime_entries and len(datetime_entries) >= max(len(numeric_entries), len(category_entries)):
        mode = "datetime"
        xs = [dt for dt, _ in datetime_entries]
        ys = [val for _, val in datetime_entries]
    elif numeric_entries and len(numeric_entries) >= len(category_entries):
        mode = "numeric"
        xs = [num for num, _ in numeric_entries]
        ys = [val for _, val in numeric_entries]
    else:
        mode = "category"
        if not category_entries:
            category_entries = [(str(x) if x is not None else "", val) for x, val in raw_entries]
        xs = [label for label, _ in category_entries]
        ys = [val for _, val in category_entries]

    return {"mode": mode, "xs": xs, "ys": ys}


def format_timestamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def downsample_points(xs, ys, max_points=80):
    n = len(xs)
    if n <= max_points:
        return xs, ys
    step = (n - 1) / (max_points - 1)
    idxs = []
    for i in range(max_points):
        idx = int(round(i * step))
        if idx >= n:
            idx = n - 1
        if not idxs or idx != idxs[-1]:
            idxs.append(idx)
    xs_ds = [xs[i] for i in idxs]
    ys_ds = [ys[i] for i in idxs]
    return xs_ds, ys_ds


def build_coordinate_block(mode: str, xs, ys):
    xs, ys = downsample_points(xs, ys)
    coords = []
    labels = []
    if mode == "datetime":
        for idx, (dt, val) in enumerate(zip(xs, ys)):
            y_str = f"{val:.6f}".rstrip("0").rstrip(".")
            coords.append(f"({idx},{y_str})")
            labels.append(format_timestamp(dt))
    elif mode == "numeric":
        for x, val in zip(xs, ys):
            y_str = f"{val:.6f}".rstrip("0").rstrip(".")
            x_str = f"{x:.6f}".rstrip("0").rstrip(".")
            coords.append(f"({x_str},{y_str})")
    else:  # category
        for idx, (label, val) in enumerate(zip(xs, ys)):
            y_str = f"{val:.6f}".rstrip("0").rstrip(".")
            coords.append(f"({idx},{y_str})")
            labels.append(str(label) if label else f"Cat {idx+1}")
    return "\n".join(coords), labels


def choose_ticks(labels: List[str], max_ticks: int = 6) -> Tuple[List[int], List[str]]:
    if not labels:
        return [], []
    n = len(labels)
    if n <= 1:
        return [0], [labels[0]]
    slots = min(max_ticks, n)
    step = max(1, n // slots)
    positions = list(range(0, n, step))
    if positions[-1] != n - 1:
        if len(positions) >= max_ticks:
            positions[-1] = n - 1
        else:
            positions.append(n - 1)
    positions = sorted(set(positions))
    chosen_labels = [labels[i] for i in positions]
    return positions, chosen_labels


def build_pgfplot(
    trace_data: Dict,
    chart: Dict,
    trace_index: int,
) -> Tuple[Optional[str], Dict]:
    series_defs = chart.get("series") or []
    datasets: List[Dict] = []
    tick_labels_reference: Optional[List[str]] = None
    axis_mode: Optional[str] = None

    for series_def in series_defs:
        points = extract_series_points(trace_data, series_def)
        if not points:
            continue
        coords, labels = build_coordinate_block(points["mode"], points["xs"], points["ys"])
        if not coords:
            continue
        datasets.append(
            {
                "name": series_def.get("name") or "Series",
                "coords": coords,
                "mode": points["mode"],
                "labels": labels,
            }
        )
        if axis_mode is None:
            axis_mode = points["mode"]
        if tick_labels_reference is None or len(labels) > len(tick_labels_reference):
            tick_labels_reference = labels

    if not datasets:
        return None, {}

    chart_type = (chart.get("chart", {}) or {}).get("type", "line").lower()
    title = latex_escape(chart.get("title", {}).get("text", f"Trace {trace_index} chart"))

    def axis_obj(value):
        if isinstance(value, list):
            return value[0] if value else {}
        if isinstance(value, dict):
            return value
        return {}

    x_axis = axis_obj(chart.get("xAxis"))
    y_axis = axis_obj(chart.get("yAxis"))
    x_label = latex_escape((x_axis.get("title") or {}).get("text", "Time"))
    y_label = latex_escape((y_axis.get("title") or {}).get("text", "Value"))

    plot_lines = []
    for dataset in datasets:
        addplot_prefix = r"\addplot"
        if chart_type == "column":
            addplot_prefix += "+[ybar]"
        elif chart_type == "scatter":
            addplot_prefix += "+[only marks, mark=*, mark size=1.5pt]"
        plot_lines.append(
            textwrap.dedent(
                rf"""
                {addplot_prefix} coordinates {{
                {dataset["coords"]}
                }};
                \addlegendentry{{{latex_escape(dataset["name"])}}}
                """
            ).strip()
        )

    option_lines = [
        "width=0.95\\textwidth",
        "height=6cm",
        "xticklabel style={rotate=45, anchor=east}",
        f"xlabel={{{x_label}}}",
        f"ylabel={{{y_label}}}",
        f"title={{{title}}}",
        "legend style={draw=none}",
        "legend cell align=left",
    ]

    tick_positions: List[int] = []
    tick_texts: List[str] = []
    if tick_labels_reference:
        tick_positions, tick_texts = choose_ticks(tick_labels_reference)
    if tick_positions and tick_texts:
        tick_pos_str = ",".join(str(p) for p in tick_positions)
        tick_label_str = ",".join(f"{{{latex_escape(lbl)}}}" for lbl in tick_texts)
        option_lines.append(f"xtick={{ {tick_pos_str} }}")
        option_lines.append(f"xticklabels={{ {tick_label_str} }}")

    axis_options = ",\n".join(option_lines)

    plot_content = "\n".join(plot_lines)
    figure_tex = textwrap.dedent(
        rf"""
        \begin{{figure}}[h]
        \centering
        \begin{{tikzpicture}}
        \begin{{axis}}[
        {axis_options}
        ]
        {plot_content}
        \end{{axis}}
        \end{{tikzpicture}}
        \caption{{{title}}}
        \end{{figure}}
        """
    ).strip()

    return figure_tex, {"mode": axis_mode, "labels": tick_labels_reference or []}


def format_chart(trace_index: int, trace_data: Dict, chart: Optional[Dict]) -> str:
    if not chart:
        return r"\textit{No chart was produced.}"

    figure_tex, metadata = build_pgfplot(trace_data, chart, trace_index)
    if not figure_tex:
        return r"\textit{Chart rendering failed for this trace.}"

    chart_type = latex_escape(chart.get("chart", {}).get("type", "unknown"))
    title = latex_escape(chart.get("title", {}).get("text", ""))

    lines = [r"\begin{itemize}", rf"\item Chart type: \texttt{{{chart_type}}}"]
    if title:
        lines.append(rf"\item Title: {title}")
    series = chart.get("series", [])
    if series:
        lines.append(r"\item Series:")
        lines.append(r"\begin{itemize}")
        for s in series:
            name = latex_escape(s.get("name", ""))
            data_ref = s.get("dataRef")
            if data_ref:
                tool = latex_escape(str(data_ref.get("tool", "")))
                x_field = latex_escape(str(data_ref.get("xField", "")))
                y_field = latex_escape(str(data_ref.get("yField", "")))
                lines.append(
                    rf"\item {name} (dataRef: tool=\texttt{{{tool}}}, xField=\texttt{{{x_field}}}, yField=\texttt{{{y_field}}})"
                )
            else:
                lines.append(rf"\item {name} (raw data embedded)")
        lines.append(r"\end{itemize}")
    lines.append(r"\end{itemize}")

    extra_notes = ""
    labels = (metadata or {}).get("labels") or []
    mode = (metadata or {}).get("mode")
    if mode == "datetime" and len(labels) >= 2:
        start_label = latex_escape(labels[0])
        end_label = latex_escape(labels[-1])
        extra_notes = (
            r"\begin{itemize}"
            + rf"\item Samples plotted in chronological order from {start_label} to {end_label}."
            + r"\end{itemize}"
        )
    elif mode == "category" and labels:
        preview = ", ".join(latex_escape(lbl) for lbl in labels[:6])
        extra_notes = (
            r"\begin{itemize}"
            + rf"\item Categories (first few): {preview}."
            + r"\end{itemize}"
        )

    combined_parts = [figure_tex, "\n".join(lines)]
    if extra_notes:
        combined_parts.append(extra_notes)
    combined = "\n".join(combined_parts)
    return combined or r"\textit{Chart rendering failed for this trace.}"


def format_tool_entries(tools: Iterable[Dict]) -> str:
    tool_lines: List[str] = []
    for entry in tools:
        tool_name = latex_escape(str(entry.get("tool", "")))
        try:
            args_json = json.dumps(entry.get("args", {}), ensure_ascii=False, sort_keys=True)
        except TypeError:
            args_json = str(entry.get("args", {}))
        result = entry.get("result")
        try:
            result_json = json.dumps(result, ensure_ascii=False)
        except TypeError:
            result_json = str(result)
        truncated = result_json[:200]
        if len(result_json) > 200:
            truncated += "..."
        tool_lines.append(
            textwrap.dedent(
                rf"""
                \item \textbf{{Tool}} \texttt{{{tool_name}}}\\
                \textbf{{Args}}: \texttt{{{latex_escape(args_json)}}}\\
                \textbf{{Result (truncated)}}: \texttt{{{latex_escape(truncated)}}}
                """.strip()
            )
        )

    if tool_lines:
        return "\n".join(["\\begin{itemize}", *tool_lines, "\\end{itemize}"])
    return r"\textit{No tool calls were recorded.}"


def format_trace(index: int, trace_path: Path, trace_data: Dict) -> str:
    question = latex_escape(trace_data.get("question", "").strip() or "(missing question)")
    answer = latex_escape(trace_data.get("answer", "").strip() or "(no answer provided)")
    chart_section = format_chart(index, trace_data, trace_data.get("chart"))

    selection = trace_data.get("selection", {})
    rooms = selection.get("zones") or []
    devices = selection.get("devices") or []
    rooms_text = ", ".join(latex_escape(str(r)) for r in rooms) if rooms else r"\textit{(none)}"
    devices_text = ", ".join(latex_escape(str(d)) for d in devices) if devices else r"\textit{(none)}"

    metadata_items = [
        rf"\item Trace file: {latex_escape(trace_path.name)}",
        rf"\item Tenant: {latex_escape(str(selection.get('tenant', '')))}",
        rf"\item Building: {latex_escape(str(selection.get('building', '')))}",
        rf"\item Rooms: {rooms_text}",
        rf"\item Devices: {devices_text}",
    ]
    metadata_lines = ["\\begin{itemize}", *metadata_items, "\\end{itemize}"]

    lines = [
        rf"\section{{Trace {index}}}",
        r"\subsection*{Metadata}",
        *metadata_lines,
        r"\subsection*{Question}",
        r"\begin{quote}",
        question,
        r"\end{quote}",
        r"\subsection*{Answer}",
        r"\begin{quote}",
        answer,
        r"\end{quote}",
        r"\subsection*{Chart}",
        chart_section,
        r"\subsection*{Tool Calls}",
        format_tool_entries(trace_data.get("trace") or []),
    ]
    return "\n".join(lines)


def build_document(traces_dir: Path) -> str:
    sections: List[str] = []
    for idx, trace_path in enumerate(sorted(traces_dir.glob("*.json")), start=1):
        data = json.loads(trace_path.read_text())
        sections.append(format_trace(idx, trace_path, data))
    body = "\n\n".join(sections)
    author_text = latex_escape("Generated by scripts/traces_to_latex.py")
    doc_lines = [
        r"\documentclass[11pt]{article}",
        r"\usepackage[margin=1in]{geometry}",
        r"\usepackage{longtable}",
        r"\usepackage{hyperref}",
        r"\usepackage{tikz}",
        r"\usepackage{pgfplots}",
        r"\pgfplotsset{compat=1.18}",
        r"\title{AVM Trace Report}",
        rf"\author{{{author_text}}}",
        r"\date{\today}",
        r"\begin{document}",
        r"\maketitle",
        body,
        r"\end{document}",
    ]
    return "\n".join(doc_lines)


def main():
    parser = argparse.ArgumentParser(description="Convert trace JSON files into a LaTeX report with embedded charts.")
    parser.add_argument("--traces-dir", default="data/traces", type=Path, help="Directory containing trace JSON files.")
    parser.add_argument("--output", default="data/traces_report.tex", type=Path, help="Output LaTeX file path.")
    args = parser.parse_args()

    if not args.traces_dir.exists():
        raise SystemExit(f"Trace directory not found: {args.traces_dir}")

    document = build_document(args.traces_dir)
    if args.output.parent:
        args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(document)
    print(f"Wrote LaTeX report to {args.output}")


if __name__ == "__main__":
    main()
