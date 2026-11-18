"""Run a student Python file and report local-variable snapshots before each line."""

import ast
import json
import itertools
import linecache
import math
import os
import runpy
import sys
import tokenize


TRACE_PREFIX = "@@VULIVELAB_TRACE@@"
MAX_EVENTS = 120
MAX_TEXT_LENGTH = 240


def normalize(value, depth=0):
    """Convert simple values to JSON-safe data without calling arbitrary repr methods."""
    if depth >= 4:
        return "<nested value omitted>"
    value_type = type(value)
    if value_type is str:
        return value if len(value) <= MAX_TEXT_LENGTH else value[: MAX_TEXT_LENGTH - 3] + "..."
    if value_type in (int, bool, type(None)):
        return value
    if value_type is float:
        return value if math.isfinite(value) else repr(value)
    if value_type in (list, tuple, set):
        values = value[:8] if value_type in (list, tuple) else itertools.islice(value, 8)
        normalized = [normalize(item, depth + 1) for item in values]
        if value_type is set:
            normalized.sort(key=repr)
        if len(value) > 8:
            normalized.append("<additional values omitted>")
        return normalized
    elif value_type is dict:
        entries = itertools.islice(value.items(), 8)
        normalized = {
            str(key): normalize(item, depth + 1)
            for key, item in entries
        }
        if len(value) > 8:
            normalized["<additional keys omitted>"] = True
        return normalized
    return f"<{value_type.__name__}>"


def main():
    if len(sys.argv) < 2:
        print("Usage: trace_runner.py <student-file.py>", file=sys.stderr)
        return 2

    target = os.path.realpath(sys.argv[1])
    try:
        requirements = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    except json.JSONDecodeError:
        requirements = {}
    requested_variables = requirements.get("variables", [])
    required_calls = requirements.get("requiredCalls", [])
    sys.argv = [target]
    event_count = 0
    truncated = False

    syntax_tree = None
    try:
        with tokenize.open(target) as source_file:
            source_text = source_file.read()
        syntax_tree = ast.parse(source_text, filename=target)
        call_nodes = [node for node in ast.walk(syntax_tree) if isinstance(node, ast.Call)]
    except (OSError, SyntaxError):
        call_nodes = []

    declaration_lines = {}
    if syntax_tree is not None:
        for node in ast.walk(syntax_tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                if node.id in requested_variables:
                    previous_line = declaration_lines.get(node.id)
                    if previous_line is None or node.lineno < previous_line:
                        declaration_lines[node.id] = node.lineno

    for name in requested_variables:
        line = declaration_lines.get(name)
        record = {
            "event": "variable-declaration",
            "name": name,
            "line": line,
            "source": linecache.getline(target, line).strip() if line else "",
        }
        sys.__stderr__.write(TRACE_PREFIX + json.dumps(record, ensure_ascii=False) + "\n")
        sys.__stderr__.flush()

    for required in required_calls:
        match = None
        for node in call_nodes:
            function = node.func
            if isinstance(function, ast.Attribute):
                name = function.attr
                receiver = function.value.id if isinstance(function.value, ast.Name) else None
            elif isinstance(function, ast.Name):
                name = function.id
                receiver = None
            else:
                continue
            if name == required.get("name") and receiver == required.get("receiver"):
                match = node
                break

        record = {
            "event": "required-call",
            "name": required.get("name"),
            "receiver": required.get("receiver"),
            "found": match is not None,
            "line": match.lineno if match else None,
            "source": linecache.getline(target, match.lineno).strip() if match else "",
        }
        sys.__stderr__.write(TRACE_PREFIX + json.dumps(record, ensure_ascii=False) + "\n")
        sys.__stderr__.flush()

    def emit(event, frame):
        record = {
            "event": event,
            "line": frame.f_lineno,
            "scope": frame.f_code.co_name if frame.f_code.co_name != "<module>" else "ไฟล์หลัก",
            "source": linecache.getline(target, frame.f_lineno).strip(),
            "variables": {
                name: normalize(frame.f_locals[name])
                for name in requested_variables
                if name in frame.f_locals
            },
        }
        sys.__stderr__.write(TRACE_PREFIX + json.dumps(record, ensure_ascii=False) + "\n")
        sys.__stderr__.flush()

    def trace(frame, event, arg):
        nonlocal event_count, truncated
        if os.path.realpath(frame.f_code.co_filename) != target:
            return None
        if event in ("line", "return"):
            if event_count < MAX_EVENTS:
                emit(event, frame)
                event_count += 1
            elif not truncated:
                sys.__stderr__.write(
                    TRACE_PREFIX
                    + json.dumps({"event": "truncated", "message": "แสดง trace ถึงขีดจำกัดแล้ว"}, ensure_ascii=False)
                    + "\n"
                )
                sys.__stderr__.flush()
                truncated = True
        return trace

    sys.settrace(trace)
    try:
        runpy.run_path(target, run_name="__main__")
    finally:
        sys.settrace(None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
