#!/usr/bin/env python3
"""Print the `target_features` custom section of a wasm binary as JSON.

Usage: check-target-features.py FILE.wasm [--require FEATURE]...

Prints a JSON array such as ["+bulk-memory", "+tail-call"] to stdout. Exits 1
when the section is missing or a --require'd feature is not marked "+".
"""

import argparse
import json
import sys

MAGIC = b"\0asm"
VERSION = b"\x01\x00\x00\x00"
CUSTOM_SECTION_ID = 0
PREFIXES = {0x2B: "+", 0x2D: "-", 0x3D: "="}


class WasmFormatError(Exception):
    pass


def read_leb128_u32(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise WasmFormatError("truncated LEB128 integer")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return result, pos
        shift += 7
        if shift > 35:
            raise WasmFormatError("LEB128 integer exceeds 32 bits")


def read_name(buf: bytes, pos: int, end: int) -> tuple[str, int]:
    length, pos = read_leb128_u32(buf, pos)
    if pos + length > end:
        raise WasmFormatError("name extends beyond its section")
    return buf[pos : pos + length].decode("utf-8"), pos + length


def find_target_features(buf: bytes) -> list[str] | None:
    if buf[:4] != MAGIC:
        raise WasmFormatError("not a wasm binary (bad magic)")
    if buf[4:8] != VERSION:
        raise WasmFormatError("unsupported wasm binary version %r" % buf[4:8])
    pos = 8
    while pos < len(buf):
        section_id = buf[pos]
        pos += 1
        size, pos = read_leb128_u32(buf, pos)
        end = pos + size
        if end > len(buf):
            raise WasmFormatError("section %d extends beyond end of file" % section_id)
        if section_id == CUSTOM_SECTION_ID:
            name, payload = read_name(buf, pos, end)
            if name == "target_features":
                return parse_target_features(buf, payload, end)
        pos = end
    return None


def parse_target_features(buf: bytes, pos: int, end: int) -> list[str]:
    count, pos = read_leb128_u32(buf, pos)
    features = []
    for _ in range(count):
        if pos >= end:
            raise WasmFormatError("target_features entry extends beyond section")
        prefix = PREFIXES.get(buf[pos])
        if prefix is None:
            raise WasmFormatError("unknown target_features prefix 0x%02x" % buf[pos])
        name, pos = read_name(buf, pos + 1, end)
        features.append(prefix + name)
    return features


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("wasm")
    parser.add_argument(
        "--require",
        action="append",
        default=[],
        metavar="FEATURE",
        help="fail unless the section marks FEATURE as used (+); repeatable",
    )
    args = parser.parse_args()

    with open(args.wasm, "rb") as f:
        buf = f.read()

    try:
        features = find_target_features(buf)
    except WasmFormatError as e:
        print("%s: %s" % (args.wasm, e), file=sys.stderr)
        return 1

    if features is None:
        print("%s: no target_features custom section" % args.wasm, file=sys.stderr)
        return 1

    print(json.dumps(features))

    missing = [name for name in args.require if "+" + name not in features]
    if missing:
        print(
            "%s: target_features lacks required feature(s): %s (present: %s)"
            % (args.wasm, ", ".join(missing), ", ".join(features) or "none"),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
