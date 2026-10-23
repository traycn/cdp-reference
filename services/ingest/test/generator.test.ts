import { describe, expect, it } from "vitest";
import { checkCounts, countTables } from "../src/counts.ts";
import { buildManifest, csvField, serialize, toCsv } from "../src/dataset.ts";
import { classifyPerson, generate, type GenerateOptions } from "../src/generator.ts";
import { Rng } from "../src/rng.ts";
import { assertSeedAllowed } from "../src/seeds.ts";
import type { Tables } from "../src/tables.ts";

const small: GenerateOptions = { seed: 42, people: 2_000, dobRate: 0.3 };
const tables = generate(small);

const hashOf = (opts: GenerateOptions): string => {
  const t = generate(opts);
  return buildManifest(opts, t, serialize(t)).sha256;
};

const normEmail = (e: string | null): string | null => e?.trim().toLowerCase() ?? null;
const normPhone = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d === "" ? null : d.length === 11 ? d.slice(1) : d;
};

function unitsByPerson(t: Tables): Map<string, { type: string; key: string }[]> {
  const out = new Map<string, { type: string; key: string }[]>();
  for (const r of t.truth_record) {
    out.set(r.person_id, [...(out.get(r.person_id) ?? []), { type: r.unit_type, key: r.unit_key }]);
  }
  return out;
}

describe("Rng", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 100 }, () => a.u32())).toEqual(
      Array.from({ length: 100 }, () => b.u32()),
    );
  });

  it("gives different sequences for different seeds", () => {
    expect(new Rng(1).u32()).not.toBe(new Rng(2).u32());
  });

  it("keeps int() inside its bounds and shuffle() a permutation", () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1_000; i++) {
      const x = rng.int(-2, 5);
      expect(x).toBeGreaterThanOrEqual(-2);
      expect(x).toBeLessThanOrEqual(5);
    }
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect([...rng.shuffle([...items])].sort((x, y) => x - y)).toEqual(items);
  });

  it("rejects pick from an empty list", () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });
});

describe("determinism", () => {
  it("gives byte-identical files for the same options", () => {
    const again = serialize(generate(small));
    for (const [file, content] of serialize(tables)) expect(again.get(file)).toBe(content);
  });

  it("changes the output when the seed or dob-rate changes", () => {
    const base = hashOf(small);
    expect(hashOf({ ...small, seed: 7 })).not.toBe(base);
    expect(hashOf({ ...small, dobRate: 0.5 })).not.toBe(base);
  });

  it("rejects invalid options", () => {
    expect(() => generate({ ...small, seed: -1 })).toThrow();
    expect(() => generate({ ...small, people: 10 })).toThrow();
    expect(() => generate({ ...small, dobRate: 1.5 })).toThrow();
  });
});

describe("ground truth", () => {
  const units = unitsByPerson(tables);
  const contacts = new Map(tables.crm_contact.map((c) => [c.crm_id, c]));
  const forms = new Map(
    tables.web_event
      .filter((e) => e.event_name === "form_submit")
      .map((e) => [e.source_event_id, e]),
  );

  it("maps every CRM contact, form submission and device to exactly one person", () => {
    const devices = new Set(tables.web_event.map((e) => e.anonymous_id));
    const keys = tables.truth_record.map((r) => `${r.unit_type}:${r.unit_key}`);
    expect(new Set(keys).size).toBe(keys.length);
    const count = (type: string): number =>
      tables.truth_record.filter((r) => r.unit_type === type).length;
    expect(count("crm_contact")).toBe(contacts.size);
    expect(count("form_submission")).toBe(forms.size);
    expect(count("device")).toBe(devices.size);
    for (const r of tables.truth_record) {
      if (r.unit_type === "crm_contact") expect(contacts.has(r.unit_key)).toBe(true);
      if (r.unit_type === "form_submission") expect(forms.has(r.unit_key)).toBe(true);
      if (r.unit_type === "device") expect(devices.has(r.unit_key)).toBe(true);
    }
    expect(units.size).toBe(small.people);
  });

  it("gives each person one kind, consistent with the person's units", () => {
    const kinds = new Map<string, Set<string>>();
    for (const r of tables.truth_record) {
      kinds.set(r.person_id, (kinds.get(r.person_id) ?? new Set()).add(r.person_kind));
    }
    for (const [person, set] of kinds) {
      expect(set.size).toBe(1);
      const own = units.get(person)!;
      const kind = classifyPerson({
        formEmails: own
          .filter((u) => u.type === "form_submission")
          .map((u) => forms.get(u.key)!.email!),
        deviceCount: own.filter((u) => u.type === "device").length,
        contacts: own
          .filter((u) => u.type === "crm_contact")
          .map((u) => ({ email: contacts.get(u.key)!.email, phone: contacts.get(u.key)!.phone })),
      });
      expect(kind).toBe([...set][0]);
    }
  });

  it("gives email_changed people two contacts with different emails and the same phone", () => {
    const people = new Set(
      tables.truth_record.filter((r) => r.person_kind === "email_changed").map((r) => r.person_id),
    );
    expect(people.size).toBeGreaterThan(0);
    for (const person of people) {
      const own = units.get(person)!.filter((u) => u.type === "crm_contact");
      expect(own).toHaveLength(2);
      const [a, b] = own.map((u) => contacts.get(u.key)!);
      expect(normEmail(a!.email)).not.toBe(normEmail(b!.email));
      expect(normPhone(a!.phone)).not.toBeNull();
      expect(normPhone(a!.phone)).toBe(normPhone(b!.phone));
    }
  });

  it("builds hazard pairs from two different people who look alike", () => {
    const contactOf = (person: string) => {
      const own = units.get(person)!.filter((u) => u.type === "crm_contact");
      expect(own).toHaveLength(1);
      return contacts.get(own[0]!.key)!;
    };
    const identity = tables.truth_hazard_pair.filter((h) => h.kind !== "shared_device");
    expect(identity).toHaveLength(2 * Math.round(small.people * 0.015));
    for (const h of identity) {
      expect(h.person_a < h.person_b).toBe(true);
      const [a, b] = [contactOf(h.person_a), contactOf(h.person_b)];
      if (h.kind === "same_name_relative") {
        expect([a.first_name, a.last_name]).toEqual([b.first_name, b.last_name]);
        const sharesPhone = normPhone(a.phone) === normPhone(b.phone);
        const sharesEmail = normEmail(a.email) === normEmail(b.email);
        expect(sharesPhone || sharesEmail).toBe(true);
        if (a.dob && b.dob) expect(a.dob).not.toBe(b.dob);
      } else {
        expect(a.first_name).not.toBe(b.first_name);
        expect(normPhone(a.phone)).toBe(normPhone(b.phone));
        expect(normEmail(a.email)).not.toBe(normEmail(b.email));
      }
    }
  });

  it("lends one device per shared_device pair to a household member with their own identifiers", () => {
    const pairs = tables.truth_hazard_pair.filter((h) => h.kind === "shared_device");
    expect(pairs).toHaveLength(Math.round(small.people * 0.03));
    const deviceOwner = new Map(
      tables.truth_record
        .filter((r) => r.unit_type === "device")
        .map((r) => [r.unit_key, r.person_id]),
    );
    const eventDevice = new Map(tables.web_event.map((e) => [e.source_event_id, e.anonymous_id]));
    const usersOf = new Map<string, Set<string>>();
    for (const r of tables.truth_event) {
      if (r.source_table !== "web_event") continue;
      const d = eventDevice.get(r.source_event_id)!;
      usersOf.set(d, (usersOf.get(d) ?? new Set()).add(r.person_id));
    }
    const shared = [...usersOf].filter(([, users]) => users.size > 1);
    expect(shared).toHaveLength(pairs.length);
    const pairKeys = new Set(pairs.map((h) => `${h.person_a}|${h.person_b}`));
    for (const [device, users] of shared) {
      expect(users.size).toBe(2);
      expect(pairKeys.has([...users].sort().join("|"))).toBe(true);
      expect(users.has(deviceOwner.get(device)!)).toBe(true);
    }
    // The pair never shares an email or a phone on any contact or form.
    for (const h of pairs) {
      const ids = (person: string) => {
        const out = new Set<string>();
        for (const u of units.get(person)!) {
          const c = u.type === "crm_contact" ? contacts.get(u.key) : undefined;
          const f = u.type === "form_submission" ? forms.get(u.key) : undefined;
          for (const v of [
            normEmail(c?.email ?? f?.email ?? null),
            normPhone(c?.phone ?? f?.properties.phone),
          ])
            if (v) out.add(v);
        }
        return out;
      };
      const b = ids(h.person_b);
      for (const v of ids(h.person_a)) expect(b.has(v)).toBe(false);
    }
  });

  it("names the producer of every web event and tracked ad click", () => {
    const tracked =
      tables.web_event.length + tables.ad_click.filter((c) => c.anonymous_id !== null).length;
    expect(tables.truth_event).toHaveLength(tracked);
    const owner = new Map(
      tables.truth_record
        .filter((r) => r.unit_type === "device")
        .map((r) => [r.unit_key, r.person_id]),
    );
    const formPerson = new Map(
      tables.truth_record
        .filter((r) => r.unit_type === "form_submission")
        .map((r) => [r.unit_key, r.person_id]),
    );
    const events = new Map(tables.web_event.map((e) => [e.source_event_id, e]));
    let borrowed = 0;
    for (const r of tables.truth_event) {
      if (r.source_table !== "web_event") continue;
      const e = events.get(r.source_event_id)!;
      if (e.event_name === "form_submit")
        expect(r.person_id).toBe(formPerson.get(e.source_event_id));
      if (r.person_id !== owner.get(e.anonymous_id)) borrowed++;
    }
    expect(borrowed).toBeGreaterThan(0);
  });

  it("covers all three DOB groups for both identity hazard kinds", () => {
    const g = countTables(tables).hazard_dob_groups;
    for (const kind of ["same_name_relative", "shared_household_phone"] as const) {
      expect(g[kind].both).toBeGreaterThan(0);
      expect(g[kind].one).toBeGreaterThan(0);
      expect(g[kind].none).toBeGreaterThan(0);
    }
  });
});

describe("feeds", () => {
  it("puts names and company on every form fill, and a phone on some", () => {
    const forms = tables.web_event.filter((e) => e.event_name === "form_submit");
    expect(forms.length).toBeGreaterThan(0);
    for (const f of forms) {
      expect(f.email).toBeTruthy();
      expect(f.properties.first_name).toBeTruthy();
      expect(f.properties.last_name).toBeTruthy();
      expect(f.properties.company).toBeTruthy();
    }
    const withPhone = forms.filter((f) => f.properties.phone !== undefined).length / forms.length;
    expect(withPhone).toBeGreaterThan(0.3);
    expect(withPhone).toBeLessThan(0.5);
  });

  it("gives every opportunity an existing contact, and closed ones a won flag", () => {
    const ids = new Set(tables.crm_contact.map((c) => c.crm_id));
    for (const o of tables.crm_opportunity) {
      expect(ids.has(o.crm_id)).toBe(true);
      expect(o.won === null).toBe(o.closed_at === null);
      expect(o.won === true).toBe(o.stage === "closed_won");
    }
  });

  it("links every tracked ad click to a session on the same device", () => {
    const devices = new Set(tables.web_event.map((e) => e.anonymous_id));
    for (const c of tables.ad_click)
      if (c.anonymous_id) expect(devices.has(c.anonymous_id)).toBe(true);
  });

  it("keeps every timestamp inside the fixed window", () => {
    const all = [
      ...tables.web_event.map((e) => e.occurred_at),
      ...tables.ad_click.map((c) => c.occurred_at),
      ...tables.crm_contact.map((c) => c.updated_at),
      ...tables.crm_opportunity.flatMap((o) => [o.opened_at, o.closed_at ?? o.opened_at]),
    ];
    for (const ts of all) {
      expect(ts >= "2024-12-31").toBe(true);
      expect(ts < "2026-07-01").toBe(true);
    }
  });
});

describe("--dob-rate", () => {
  const rate = (t: Tables): number =>
    t.crm_contact.filter((c) => c.dob !== null).length / t.crm_contact.length;

  it("hits the configured share of contacts", () => {
    expect(rate(tables)).toBeCloseTo(0.3, 3);
    expect(rate(generate({ ...small, dobRate: 0.5 }))).toBeCloseTo(0.5, 3);
  });

  it("handles 0 and 1", () => {
    expect(rate(generate({ ...small, dobRate: 0 }))).toBe(0);
    expect(rate(generate({ ...small, dobRate: 1 }))).toBe(1);
  });
});

describe("classifyPerson", () => {
  const contact = (email: string, phone: string | null) => ({ email, phone });

  it("prefers multi_email, then multi_device, then email_changed", () => {
    const changed = [contact("a@x.com", "4155550100"), contact("b@x.com", "(415) 555-0100")];
    expect(
      classifyPerson({ formEmails: ["a@x.com", "B@x.com"], deviceCount: 2, contacts: changed }),
    ).toBe("multi_email");
    expect(classifyPerson({ formEmails: ["a@x.com"], deviceCount: 2, contacts: changed })).toBe(
      "multi_device",
    );
    expect(classifyPerson({ formEmails: [], deviceCount: 1, contacts: changed })).toBe(
      "email_changed",
    );
  });

  it("falls back to ordinary", () => {
    expect(
      classifyPerson({ formEmails: ["a@x.com", " A@X.com"], deviceCount: 1, contacts: [] }),
    ).toBe("ordinary");
    expect(classifyPerson({ formEmails: [], deviceCount: 0, contacts: [] })).toBe("ordinary");
  });

  it("needs different emails and the same phone for email_changed", () => {
    const sameEmail = [contact("a@x.com", "4155550100"), contact("A@x.com", "4155550100")];
    const noPhone = [contact("a@x.com", null), contact("b@x.com", null)];
    expect(classifyPerson({ formEmails: [], deviceCount: 1, contacts: sameEmail })).toBe(
      "ordinary",
    );
    expect(classifyPerson({ formEmails: [], deviceCount: 1, contacts: noPhone })).toBe("ordinary");
  });
});

describe("csv", () => {
  it("writes NULL unquoted and the empty string quoted", () => {
    expect(csvField(null)).toBe("");
    expect(csvField("")).toBe('""');
  });

  it("quotes commas, quotes, newlines and edge whitespace", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField(" a")).toBe('" a"');
    expect(csvField({ k: "v" })).toBe('"{""k"":""v""}"');
    expect(csvField(true)).toBe("true");
  });

  it("writes a header and one line per row", () => {
    expect(toCsv(["a", "b"], [{ a: 1, b: null }])).toBe("a,b\n1,\n");
  });
});

describe("checkCounts", () => {
  it("passes the small run once ranges are scaled to its size", () => {
    const failed = checkCounts(countTables(tables), small.people, small.dobRate).filter(
      (c) => !c.ok,
    );
    expect(failed).toEqual([]);
  });

  it("fails a count outside its range", () => {
    const counts = { ...countTables(tables), crm_contact: 1 };
    const failed = checkCounts(counts, small.people, small.dobRate).filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toContain("raw.crm_contact");
  });
});

describe("seeds", () => {
  it("refuses held-out seeds unless explicitly allowed", () => {
    expect(() => assertSeedAllowed(2026)).toThrow(/held out/);
    expect(() => assertSeedAllowed(42)).not.toThrow();
  });
});
