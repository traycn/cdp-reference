"""Which build of project 01 is installed: the pinned tag and commit from uv.lock."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from importlib.metadata import distribution

ENGINE = "entity-resolution"

# Must equal the namespace in core.profile_uuid (db/migrations/001_init.sql); the
# CHECK on core.customer_profile rejects a profile_id computed with any other.
PROFILE_NAMESPACE = uuid.UUID("c7e7f593-bcaa-4087-a2df-d871d88ac373")


@dataclass(frozen=True)
class EngineInfo:
    name: str
    version: str  # the git tag, e.g. v1.0.0
    commit: str


def engine_info() -> EngineInfo:
    dist = distribution(ENGINE)
    direct = json.loads(dist.read_text("direct_url.json") or "{}")
    vcs = direct.get("vcs_info", {})
    return EngineInfo(
        name=ENGINE,
        version=str(vcs.get("requested_revision") or dist.version),
        commit=str(vcs.get("commit_id") or "unknown"),
    )


def profile_id(anchor_key: str) -> uuid.UUID:
    return uuid.uuid5(PROFILE_NAMESPACE, anchor_key)
