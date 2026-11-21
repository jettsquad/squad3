#!/usr/bin/env python3
"""Server-side squad-quota helper. Only normalized quota data is written to stdout."""
import json
import math
import sys
from pathlib import Path
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def windows(data):
    if data.get("base_resp", {}).get("status_code") != 0:
        raise ValueError("Quota service rejected the request.")
    for item in data.get("model_remains", []):
        results = []
        for prefix, label, reset_key in (
            ("current_interval", "MiniMax · 5 h", "end_time"),
            ("current_weekly", "MiniMax · 7 d", "weekly_end_time"),
        ):
            if item.get(prefix + "_status") == 3:
                continue
            remaining = item.get(prefix + "_remaining_percent")
            if not number(remaining):
                total = item.get(prefix + "_total_count")
                count = item.get(prefix + "_usage_count")
                if not number(total) or total <= 0 or not number(count):
                    continue
                remaining = count / total * 100
            if not 0 <= remaining <= 100:
                continue
            window = {"label": label, "remainingPercent": remaining}
            reset = item.get(reset_key)
            if number(reset) and 0 < reset <= 8.64e15:
                window["resetsAt"] = reset
            results.append(window)
        if results:
            return results
    raise ValueError("No subscription quota windows.")


def main():
    try:
        url = {
            "cn": "https://www.minimax.cn/v1/token_plan/remains",
            "global": "https://www.minimax.io/v1/token_plan/remains",
        }[sys.argv[1]]
        key = Path(sys.argv[2]).read_text(encoding="utf-8").strip()
        if not key:
            raise ValueError("Missing subscription key.")
        request = Request(url, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with build_opener(NoRedirect()).open(request, timeout=9) as response:
            data = response.read(131073)
        if len(data) > 131072:
            raise ValueError("Response too large.")
        print(json.dumps(windows(json.loads(data))))
    except Exception:
        print("MiniMax subscription quota unavailable.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
