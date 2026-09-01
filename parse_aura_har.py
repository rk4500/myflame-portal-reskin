#!/usr/bin/env python3
"""
Parse a HAR file for Salesforce Aura (Siteforce) traffic.
Extracts each ApexAction.execute request's actions[], matches them to the
matching response actions[] by id, and dumps a deduped descriptor -> samples map.

Usage:
    python3 parse_aura_har.py portal.har [output_prefix] [--fresh]

By default, merges into any existing <prefix>.json from a prior run instead
of overwriting it — samples are deduped by descriptor+params signature, with
this run's samples winning on conflict. Pass --fresh to discard prior output
and start clean.

Outputs:
    <prefix>.json  - full structured data (all samples, per descriptor)
    <prefix>.md    - human-readable summary (one section per descriptor)
"""

import os
import sys
import json
import base64
from urllib.parse import urlparse, parse_qs, unquote


def load_har(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def decode_response_text(content):
    text = content.get("text")
    if text is None:
        return None
    if content.get("encoding") == "base64":
        try:
            text = base64.b64decode(text).decode("utf-8", errors="replace")
        except Exception:
            return None
    return text


def try_json(text):
    if text is None:
        return None
    for candidate in (text, text.strip()):
        try:
            return json.loads(candidate)
        except Exception:
            continue
    # strip common anti-hijack prefixes just in case
    for prefix in ("while(1);", ")]}',", "for(;;);"):
        if text.startswith(prefix):
            try:
                return json.loads(text[len(prefix):])
            except Exception:
                pass
    return None


def get_message_actions(request):
    post_data = request.get("postData", {})
    text = post_data.get("text", "")
    params = post_data.get("params")

    message_raw = None
    if params:
        for p in params:
            if p.get("name") == "message":
                message_raw = p.get("value")
                break
    if message_raw is None and text:
        qs = parse_qs(text)
        if "message" in qs:
            message_raw = qs["message"][0]

    if message_raw is None:
        return []

    message_raw = unquote(message_raw)
    parsed = try_json(message_raw)
    if not parsed:
        return []
    return parsed.get("actions", [])


def get_response_actions(response):
    content = response.get("content", {})
    text = decode_response_text(content)
    parsed = try_json(text)
    if not parsed:
        return []
    return parsed.get("actions", [])


def build_page_lookup(har):
    pages = har.get("log", {}).get("pages", [])
    lookup = {}
    for p in pages:
        lookup[p.get("id")] = p.get("title") or p.get("id")
    return lookup


def load_existing_descriptors(json_path):
    if not os.path.exists(json_path):
        return {}
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    args = [a for a in sys.argv[1:] if a != "--fresh"]
    fresh = "--fresh" in sys.argv

    if len(args) < 1:
        print("usage: parse_aura_har.py <file.har> [output_prefix] [--fresh]")
        sys.exit(1)

    har_path = args[0]
    prefix = args[1] if len(args) > 1 else "aura_map"

    har = load_har(har_path)
    entries = har.get("log", {}).get("entries", [])
    page_lookup = build_page_lookup(har)

    descriptors = {}  # descriptor -> list of samples
    skipped = 0

    for entry in entries:
        request = entry.get("request", {})
        response = entry.get("response", {})
        url = request.get("url", "")

        if request.get("method") != "POST" or "aura" not in url or "ApexAction.execute" not in url:
            continue

        req_actions = get_message_actions(request)
        resp_actions = get_response_actions(response)
        resp_by_id = {a.get("id"): a for a in resp_actions}

        if not req_actions:
            skipped += 1
            continue

        page_id = entry.get("pageref")
        page_title = page_lookup.get(page_id, page_id or "unknown")

        for action in req_actions:
            descriptor = action.get("descriptor", "UNKNOWN")
            action_id = action.get("id")
            resp_action = resp_by_id.get(action_id, {})

            sample = {
                "page": page_title,
                "params": action.get("params", {}),
                "state": resp_action.get("state"),
                "returnValue": resp_action.get("returnValue"),
                "error": resp_action.get("error"),
                "startedDateTime": entry.get("startedDateTime"),
            }

            descriptors.setdefault(descriptor, []).append(sample)

    json_path = f"{prefix}.json"

    # merge with prior run's output instead of overwriting it, unless --fresh
    merged_in = 0
    if not fresh:
        existing = load_existing_descriptors(json_path)
        for descriptor, samples in existing.items():
            merged_in += len(samples)
            descriptors.setdefault(descriptor, [])
            descriptors[descriptor] = samples + descriptors[descriptor]

    # dedupe identical (params) samples per descriptor, keep first N distinct.
    # Existing samples are listed first (above) and this run's second, so
    # iterating and overwriting on collision means THIS run's sample wins —
    # a re-capture of the same call supersedes the stale one, while calls
    # not touched by this run are carried forward untouched.
    def signature(sample):
        return json.dumps(sample.get("params", {}), sort_keys=True, default=str)

    deduped = {}
    for descriptor, samples in descriptors.items():
        seen = {}
        for s in samples:
            sig = signature(s)
            seen[sig] = s
        deduped[descriptor] = list(seen.values())

    # write JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(deduped, f, indent=2, default=str)

    # write markdown summary
    md_path = f"{prefix}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Aura descriptor map\n\n")
        merge_note = f", merged with {merged_in} sample(s) from prior {json_path}" if merged_in else ""
        f.write(f"Parsed {len(entries)} HAR entries, {len(deduped)} unique descriptors, {skipped} skipped (no message){merge_note}.\n\n")
        for descriptor in sorted(deduped.keys()):
            samples = deduped[descriptor]
            f.write(f"## `{descriptor}`\n\n")
            f.write(f"seen {len(samples)} distinct call(s)\n\n")
            for i, s in enumerate(samples):
                f.write(f"**call {i+1}** — page: `{s['page']}`, state: `{s['state']}`\n\n")
                f.write("params:\n```json\n")
                f.write(json.dumps(s["params"], indent=2, default=str))
                f.write("\n```\n\n")
                rv = s.get("returnValue")
                rv_str = json.dumps(rv, indent=2, default=str) if rv is not None else "null"
                if len(rv_str) > 3000:
                    rv_str = rv_str[:3000] + "\n... (truncated, see .json for full)"
                f.write("returnValue:\n```json\n")
                f.write(rv_str)
                f.write("\n```\n\n")
                if s.get("error"):
                    f.write(f"error: `{s['error']}`\n\n")
            f.write("\n---\n\n")

    print(f"parsed {len(entries)} entries, skipped {skipped}, {len(deduped)} unique descriptors" + (f" (merged {merged_in} prior samples)" if merged_in else ""))
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
