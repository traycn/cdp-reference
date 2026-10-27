/**
 * Profile snapshots as of a time T: the leakage guard of docs/acceptance.md
 * (Lead scoring) and docs/plans/m5-lead-scoring.md (Visibility as of a time).
 *
 * A snapshot holds only:
 *  - the profile's most recently updated CRM contact with updated_at ≤ T;
 *  - form fills linked to the profile with occurred_at < T;
 *  - web events and ad clicks with occurred_at < T that reach the profile through
 *    a form fill before T: their session holds a pre-T form fill linked to the
 *    profile, or their device has pre-T form fills and all of them are in the profile.
 * Profiles themselves come from the full stitch (accepted in acceptance.md).
 * Opportunities are never read.
 *
 * An ad click has no session of its own. It takes the session of the next web
 * event on its device within 30 minutes (as services/stitch does), looking only
 * at events before T.
 */
import { INTENT_PAGES, type ScoreSnapshot } from "@cdp/marketing-logic";
import type { Dataset, WebEvent } from "./dataset.ts";

const CLICK_SESSION_GAP_MS = 30 * 60_000;

interface Visible {
  formFills: number[];
  sessionStart: Map<string, number>;
  intentPageViews: number[];
  adClicks: number[];
  lastEventAt: number | null;
}

/** Snapshots as of `asOf` for each of `profiles` (default: every profile). */
export function buildSnapshots(
  d: Dataset,
  asOf: number,
  profiles: readonly string[] = d.profiles,
): Map<string, ScoreSnapshot> {
  const crmProfile = new Map<string, string>();
  const formProfile = new Map<string, string>();
  for (const l of d.links)
    (l.idType === "crm_id" ? crmProfile : formProfile).set(l.idValue, l.profileId);

  const visible = new Map<string, Visible>();
  const of = (p: string): Visible => {
    let v = visible.get(p);
    if (!v) {
      v = {
        formFills: [],
        sessionStart: new Map(),
        intentPageViews: [],
        adClicks: [],
        lastEventAt: null,
      };
      visible.set(p, v);
    }
    return v;
  };
  const touch = (v: Visible, at: number): void => {
    if (v.lastEventAt === null || at > v.lastEventAt) v.lastEventAt = at;
  };

  // Pre-T form fills decide which sessions and devices reach which profile.
  const pre = d.webEvents.filter((e) => e.at < asOf);
  const sessionProfiles = new Map<string, Set<string>>();
  const deviceFills = new Map<string, Set<string | null>>();
  for (const e of pre) {
    if (e.kind !== "form_submit") continue;
    const p = formProfile.get(e.id) ?? null;
    deviceFills.set(e.device, (deviceFills.get(e.device) ?? new Set()).add(p));
    if (p === null) continue;
    const v = of(p);
    v.formFills.push(e.at);
    touch(v, e.at);
    if (e.session !== null)
      sessionProfiles.set(e.session, (sessionProfiles.get(e.session) ?? new Set()).add(p));
  }
  const deviceProfile = new Map<string, string>();
  for (const [device, ps] of deviceFills) {
    const [only] = ps;
    if (ps.size === 1 && only !== null && only !== undefined) deviceProfile.set(device, only);
  }
  const reach = (session: string | null, device: string): Set<string> => {
    const out = new Set(session === null ? [] : (sessionProfiles.get(session) ?? []));
    const p = deviceProfile.get(device);
    if (p !== undefined) out.add(p);
    return out;
  };

  for (const e of pre) {
    if (e.kind !== "page_view") continue;
    for (const p of reach(e.session, e.device)) {
      const v = of(p);
      touch(v, e.at);
      if (e.session !== null) {
        const start = v.sessionStart.get(e.session);
        if (start === undefined || e.at < start) v.sessionStart.set(e.session, e.at);
      }
      if (e.path !== null && INTENT_PAGES.includes(e.path)) v.intentPageViews.push(e.at);
    }
  }

  // Ad clicks: session of the next pre-T sessioned web event on the device within 30 minutes.
  const byDevice = new Map<string, WebEvent[]>();
  for (const e of pre) {
    if (e.session === null) continue;
    const es = byDevice.get(e.device);
    if (es) es.push(e);
    else byDevice.set(e.device, [e]);
  }
  for (const es of byDevice.values()) es.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  for (const c of d.adClicks) {
    if (c.at >= asOf) continue;
    const es = byDevice.get(c.device) ?? [];
    let lo = 0;
    let hi = es.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (es[mid]!.at < c.at) lo = mid + 1;
      else hi = mid;
    }
    const next = es[lo];
    const session = next && next.at - c.at <= CLICK_SESSION_GAP_MS ? next.session : null;
    for (const p of reach(session, c.device)) {
      const v = of(p);
      v.adClicks.push(c.at);
      touch(v, c.at);
    }
  }

  // The most recently updated contact visible at T (ties: the larger crm_id).
  const contact = new Map<string, Dataset["contacts"][number]>();
  for (const c of d.contacts) {
    if (c.updatedAt > asOf) continue;
    const p = crmProfile.get(c.crmId);
    if (p === undefined) continue;
    const seen = contact.get(p);
    if (
      !seen ||
      c.updatedAt > seen.updatedAt ||
      (c.updatedAt === seen.updatedAt && c.crmId > seen.crmId)
    )
      contact.set(p, c);
  }

  const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
  const out = new Map<string, ScoreSnapshot>();
  for (const p of profiles) {
    const v = visible.get(p);
    const c = contact.get(p);
    out.set(p, {
      asOf,
      contact: c ? { title: c.title, email: c.email, emailVerified: c.emailVerified } : null,
      formFills: sorted(v?.formFills ?? []),
      sessionStarts: sorted([...(v?.sessionStart.values() ?? [])]),
      intentPageViews: sorted(v?.intentPageViews ?? []),
      adClicks: sorted(v?.adClicks ?? []),
      lastEventAt: v?.lastEventAt ?? null,
    });
  }
  return out;
}
