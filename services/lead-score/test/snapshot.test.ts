import { describe, expect, it } from "vitest";
import type { Dataset, WebEvent } from "../src/dataset.ts";
import { buildSnapshots } from "../src/snapshot.ts";

const T = Date.UTC(2025, 9, 1);
const MIN = 60_000;
const DAY = 86_400_000;

const pv = (
  id: string,
  device: string,
  at: number,
  session: string | null,
  path = "/",
): WebEvent => ({
  id,
  device,
  at,
  kind: "page_view",
  path,
  session,
});
const fill = (id: string, device: string, at: number, session: string): WebEvent => ({
  id,
  device,
  at,
  kind: "form_submit",
  path: "/demo",
  session,
});

function dataset(over: Partial<Dataset>): Dataset {
  return {
    profiles: ["A", "B"],
    links: [],
    contacts: [],
    webEvents: [],
    adClicks: [],
    opportunities: [],
    ...over,
  };
}

describe("buildSnapshots", () => {
  it("lets a session with a pre-T fill reach its profile, and a device only if all its fills are in one profile", () => {
    const d = dataset({
      links: [
        { idType: "form_submission", idValue: "F1", profileId: "A" },
        { idType: "form_submission", idValue: "F2", profileId: "B" },
      ],
      webEvents: [
        // device d1: fills from A and B → no device link; each session reaches its own profile.
        pv("W1", "d1", T - 10 * DAY, "s1", "/pricing"),
        fill("F1", "d1", T - 10 * DAY + MIN, "s1"),
        pv("W2", "d1", T - 5 * DAY, "s2"),
        fill("F2", "d1", T - 5 * DAY + MIN, "s2"),
        pv("W3", "d1", T - 2 * DAY, "s3"), // no fill in s3 → nobody
      ],
    });
    const s = buildSnapshots(d, T);
    expect(s.get("A")!.sessionStarts).toEqual([T - 10 * DAY]);
    expect(s.get("A")!.intentPageViews).toEqual([T - 10 * DAY]);
    expect(s.get("B")!.sessionStarts).toEqual([T - 5 * DAY]);
    expect(s.get("A")!.lastEventAt).toBe(T - 10 * DAY + MIN);
  });

  it("attaches every pre-T session of a device whose pre-T fills are all in one profile", () => {
    const d = dataset({
      links: [{ idType: "form_submission", idValue: "F1", profileId: "A" }],
      webEvents: [
        pv("W1", "d1", T - 20 * DAY, "s1"),
        pv("W2", "d1", T - 10 * DAY, "s2"),
        fill("F1", "d1", T - 10 * DAY + MIN, "s2"),
        pv("W3", "d1", T - 3 * DAY, "s3"),
        pv("W4", "d1", T - 3 * DAY + MIN, "s3"),
      ],
      adClicks: [{ id: "A1", device: "d1", at: T - 3 * DAY - 10_000 }],
    });
    const a = buildSnapshots(d, T).get("A")!;
    expect(a.sessionStarts).toEqual([T - 20 * DAY, T - 10 * DAY, T - 3 * DAY]);
    expect(a.formFills).toEqual([T - 10 * DAY + MIN]);
    expect(a.adClicks).toEqual([T - 3 * DAY - 10_000]);
    expect(a.lastEventAt).toBe(T - 3 * DAY + MIN);
  });

  it("gives an ad click the next pre-T session on its device within 30 minutes, else none", () => {
    const d = dataset({
      links: [
        { idType: "form_submission", idValue: "F1", profileId: "A" },
        { idType: "form_submission", idValue: "F2", profileId: "B" },
      ],
      webEvents: [
        pv("W1", "d1", T - DAY, "s1"),
        fill("F1", "d1", T - DAY + MIN, "s1"),
        pv("W2", "d1", T - 2 * DAY, "s2"),
        fill("F2", "d1", T - 2 * DAY + MIN, "s2"),
      ],
      adClicks: [
        { id: "A1", device: "d1", at: T - DAY - 20 * MIN }, // → s1 → A
        { id: "A2", device: "d1", at: T - DAY - 40 * MIN }, // too early for s1 → nobody
      ],
    });
    const s = buildSnapshots(d, T);
    expect(s.get("A")!.adClicks).toEqual([T - DAY - 20 * MIN]);
    expect(s.get("B")!.adClicks).toEqual([]);
  });

  it("uses the most recently updated contact at or before T", () => {
    const d = dataset({
      links: [
        { idType: "crm_id", idValue: "C1", profileId: "A" },
        { idType: "crm_id", idValue: "C2", profileId: "A" },
        { idType: "crm_id", idValue: "C3", profileId: "A" },
      ],
      contacts: [
        {
          crmId: "C1",
          email: "a@x.com",
          emailVerified: false,
          title: "Analyst",
          updatedAt: T - 9 * DAY,
        },
        { crmId: "C2", email: "a@y.com", emailVerified: true, title: "CTO", updatedAt: T },
        { crmId: "C3", email: "a@z.com", emailVerified: true, title: "CEO", updatedAt: T + 1 },
      ],
    });
    const s = buildSnapshots(d, T);
    expect(s.get("A")!.contact).toEqual({ title: "CTO", email: "a@y.com", emailVerified: true });
    expect(s.get("B")!.contact).toBeNull();
    expect(s.get("B")!.lastEventAt).toBeNull();
  });

  it("ignores form fills with no profile, and does not link their device", () => {
    const d = dataset({
      links: [{ idType: "form_submission", idValue: "F1", profileId: "A" }],
      webEvents: [
        pv("W1", "d1", T - 5 * DAY, "s1"),
        fill("F1", "d1", T - 5 * DAY + MIN, "s1"),
        pv("W2", "d1", T - 4 * DAY, "s2"),
        fill("F9", "d1", T - 4 * DAY + MIN, "s2"),
      ],
    });
    expect(buildSnapshots(d, T).get("A")!.sessionStarts).toEqual([T - 5 * DAY]);
  });
});
