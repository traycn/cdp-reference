"""cdp-stitch: stitching, the idempotency check and the M3 evaluation.

  cdp-stitch run [--work-dir DIR] [--summary FILE]
  cdp-stitch idempotency
  cdp-stitch evaluate --out FILE [--stitch-summary FILE] [--check]
  cdp-stitch device-rules [--out FILE]

DATABASE_URL defaults to the docker-compose database.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cdp_stitch.db import DATA_DIR, connect, loaded_seed
from cdp_stitch.device_eval import compare_rules
from cdp_stitch.evaluate import evaluate, failures, format_metrics
from cdp_stitch.idempotency import profile_hash, row_counts
from cdp_stitch.pipeline import StitchResult, run_stitch


def _print_result(r: StitchResult) -> None:
    print(f"engine   {r.engine} {r.engine_version} ({r.engine_commit[:7]}), run {r.run_id}")
    print(f"records  {r.person_records:,} person records → {r.profiles:,} profiles")
    print("links    " + ", ".join(f"{k}={v:,}" for k, v in r.links.items()))
    print("evidence " + ", ".join(f"{k}={v:,}" for k, v in r.evidence.items()))
    print(f"devices  {r.device_conflicts:,} without a device link (tie for most form fills)")
    print("seconds  " + ", ".join(f"{k} {v:.2f}" for k, v in r.seconds.items()))


def cmd_run(args: argparse.Namespace) -> int:
    with connect() as conn:
        result = run_stitch(conn, args.work_dir)
    _print_result(result)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(result.to_json(), encoding="utf-8")
    return 0


def cmd_idempotency(args: argparse.Namespace) -> int:
    snapshots = []
    with connect() as conn:
        for attempt in (1, 2):
            run_stitch(conn, args.work_dir)
            snap = (row_counts(conn), profile_hash(conn))
            snapshots.append(snap)
            counts = ", ".join(f"{t}={n:,}" for t, n in snap[0].items())
            print(f"stitch {attempt}: {counts}; profile hash {snap[1]}")
    if snapshots[0] != snapshots[1]:
        print("FAIL  re-stitching changed row counts or the profile hash")
        return 1
    print("ok    re-stitching changed nothing")
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    with connect() as conn:
        metrics = evaluate(conn, loaded_seed(conn))
    if args.stitch_summary:
        metrics["stitch"] = json.loads(args.stitch_summary.read_text(encoding="utf-8"))
    print(format_metrics(metrics))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    failed = failures(metrics)
    for f in failed:
        print(f"FAIL  {f}")
    return 1 if args.check and failed else 0


def cmd_device_rules(args: argparse.Namespace) -> int:
    with connect() as conn:
        seed = loaded_seed(conn)
        results = compare_rules(conn)
    fl = results.pop("floor")
    print(f"seed {seed}: device rules (the pipeline uses session_majority, ADR 0004)")
    print(
        f"  floor: {fl['rate']:.4f} ({fl['unidentifiable']:,}/{fl['events']:,}) borrowed events "
        "in sessions with no form fill"
    )
    for name, r in results.items():
        print(
            f"  {name:16} attachment {r['rate']:.4f} ({r['attached']:,}/{r['events']:,})  "
            f"wrong {r['wrong_rate']:.4f} ({r['wrong']:,})  "
            f"fragment {r['fragment_rate']:.4f} ({r['fragment']:,})"
        )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        payload = {"seed": seed, "floor": fl, "rules": results}
        args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cdp-stitch")
    sub = parser.add_subparsers(required=True)
    work = {"type": Path, "default": DATA_DIR / "stitch", "help": "export and 01 output"}

    p = sub.add_parser("run", help="stitch the loaded seed into core")
    p.add_argument("--work-dir", **work)  # type: ignore[arg-type]
    p.add_argument("--summary", type=Path, help="write the run summary (JSON) here")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("idempotency", help="stitch twice; fail if counts or profile hash change")
    p.add_argument("--work-dir", **work)  # type: ignore[arg-type]
    p.set_defaults(func=cmd_idempotency)

    p = sub.add_parser("evaluate", help="M3 identity metrics against eval.truth_*")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--stitch-summary", type=Path, help="run summary to embed (timings)")
    p.add_argument("--check", action="store_true", help="exit 1 below a per-seed bar")
    p.set_defaults(func=cmd_evaluate)

    p = sub.add_parser("device-rules", help="compare device rules on the loaded seed")
    p.add_argument("--out", type=Path, help="write the comparison (JSON) here")
    p.set_defaults(func=cmd_device_rules)

    args = parser.parse_args(argv)
    code: int = args.func(args)
    return code


if __name__ == "__main__":
    sys.exit(main())
