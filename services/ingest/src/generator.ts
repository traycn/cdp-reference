/**
 * Synthetic feed generator: people → CRM contacts and opportunities, devices →
 * web sessions, ad clicks and form fills, plus ground truth (docs/acceptance.md).
 * In a shared_device pair, the second person also borrows the first person's
 * device for some sessions; eval.truth_event records who produced each event.
 *
 * Pure: the output depends only on the options. All randomness comes from one
 * seeded Rng and every timestamp lies in a fixed window, so the same options
 * always give the same tables.
 */
import { Rng } from "./rng.ts";
import type {
  AdClickRow,
  CrmContactRow,
  CrmOpportunityRow,
  HazardKind,
  PersonKind,
  Tables,
  TruthHazardPairRow,
  TruthEventRow,
  TruthRecordRow,
  WebEventRow,
} from "./tables.ts";
import {
  AREA_CODES,
  CAMPAIGNS,
  CITIES,
  COMPANIES,
  EMAIL_CAMPAIGNS,
  FIRST_NAMES,
  FORM_PAGES,
  LAST_NAMES,
  NICKNAMES,
  PAGES,
  PERSONAL_EMAIL_DOMAINS,
  REFERRAL_SITES,
  SEARCH_REFERRERS,
  SITE,
  STREETS,
  STREET_SUFFIXES,
  TITLES,
  UNRECOGNIZED_UTM,
  type Campaign,
} from "./vocab.ts";

export interface GenerateOptions {
  seed: number;
  people: number;
  /** Share of CRM contacts that get a date of birth. */
  dobRate: number;
}

/** Bump when a change to the generator is meant to change its output. */
export const GENERATOR_VERSION = 2;

const DAY = 86_400_000;
const WINDOW_START = Date.UTC(2025, 0, 1);
const WINDOW_END = Date.UTC(2026, 6, 1);

/** Shares of people per kind; hazard pairs are counted in pairs per person. */
const MIX = {
  sameNamePairs: 0.015,
  householdPairs: 0.015,
  sharedDevicePairs: 0.03,
  emailChanged: 0.03,
  multiEmail: 0.06,
  multiDevice: 0.15,
} as const;

/** P(person has a CRM contact) by kind. Hazard and email_changed people always do. */
const P_IN_CRM: Record<PersonKind, number> = {
  ordinary: 0.62,
  multi_email: 0.8,
  multi_device: 0.65,
  email_changed: 1,
};

const P_CRM_NO_DEVICE = 0.1; // ordinary CRM people who never visited the site
const P_CRM_NO_PHONE = 0.04;
const P_EMAIL_VERIFIED = 0.7;
const P_FORM_IF_CRM = 0.75;
const P_FORM_IF_NOT_CRM = 0.3;
const P_FORM_PHONE = 0.4;
const P_NICKNAME = 0.12;
const P_LOWERCASE_NAME = 0.04;
const P_EMAIL_CASE_NOISE = 0.06;
const P_SAME_NAME_SHARES_PHONE = 0.6;
const P_HOUSEHOLD_SAME_LAST = 0.8;
const P_SESSION_STOP = 0.178; // sessions per device: 1 + geometric, mean ≈ 5.6
const P_PAGE_STOP = 0.3125; // page views per session: 1 + geometric, mean 3.2
const P_BORROWED_SESSION_STOP = 0.35; // borrowed sessions on a shared device: 1 + geometric, mean ≈ 2.9
const P_UNTAGGED_CLICK = 0.05;
const P_UNTRACKED_CLICK = 0.25; // extra click with no anonymous_id per tracked click
const P_OPPORTUNITY = 0.25;
const P_SECOND_OPPORTUNITY = 0.15;

const ENTRY_CHANNEL = {
  paid_search: 0.33,
  paid_social: 0.22,
  organic: 0.15,
  email: 0.08,
  referral: 0.07,
  direct: 0.13,
  unrecognized: 0.02,
} as const;

const OPP_STAGE = {
  closed_won: 0.3,
  closed_lost: 0.35,
  prospecting: 0.1,
  qualification: 0.1,
  proposal: 0.08,
  negotiation: 0.07,
} as const;

interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
}

interface Hazard {
  kind: HazardKind;
  pair: number;
  role: "a" | "b";
}

interface Person {
  id: string;
  /** The kind the person was generated as; checked against the units at the end. */
  intended: PersonKind;
  hazard: Hazard | null;
  first: string;
  last: string;
  /** Distinct lowercase emails; [0] is the primary one. */
  emails: string[];
  /** 10 NANP digits. */
  phone: string;
  company: string;
  title: string;
  address: Address;
  birth: string;
  inCrm: boolean;
  deviceCount: number;
  formCount: number;
  firstSeen: number;
}

interface Session {
  start: number;
  events: WebEventRow[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Hazards that make two people look alike on identity fields; each has one CRM contact. */
const isIdentityHazard = (h: Hazard | null): h is Hazard =>
  h !== null && h.kind !== "shared_device";

export function generate(opts: GenerateOptions): Tables {
  if (!Number.isInteger(opts.seed) || opts.seed < 0)
    throw new Error("seed must be a non-negative integer");
  if (!Number.isInteger(opts.people) || opts.people < 100)
    throw new Error("people must be an integer ≥ 100");
  if (!(opts.dobRate >= 0 && opts.dobRate <= 1)) throw new Error("dob-rate must be in [0, 1]");
  return new Generator(opts).run();
}

class Generator {
  private readonly rng: Rng;
  private readonly usedEmails = new Set<string>();
  private readonly usedPhones = new Set<string>();
  private readonly people: Person[] = [];

  private contacts: { row: CrmContactRow; person: Person; created: number }[] = [];
  private opportunities: { row: CrmOpportunityRow; created: number; owner: CrmContactRow }[] = [];
  private events: WebEventRow[] = [];
  private clicks: AdClickRow[] = [];
  /** Units per person, filled as rows are created; keys are row objects until IDs are assigned. */
  private readonly forms = new Map<Person, WebEventRow[]>();
  private readonly devices = new Map<Person, string[]>();
  private readonly personContacts = new Map<Person, CrmContactRow[]>();
  /** shared_device role b → role a, whose device b borrows. */
  private readonly lender = new Map<Person, Person>();
  /** The person who produced each web event and ad click. */
  private readonly producer = new Map<WebEventRow | AdClickRow, Person>();

  private readonly opts: GenerateOptions;

  constructor(opts: GenerateOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);
  }

  run(): Tables {
    this.createPeople();
    // Lenders first, so a borrower's sessions can use the lender's device.
    for (const p of this.people) if (!this.lender.has(p)) this.createActivity(p);
    for (const p of this.people) if (this.lender.has(p)) this.createActivity(p);
    this.assignDob();
    this.assignIds();
    return {
      crm_contact: this.contacts.map((c) => c.row),
      crm_opportunity: this.opportunities.map((o) => o.row),
      web_event: this.events,
      ad_click: this.clicks,
      ...this.groundTruth(),
    };
  }

  // -- people ---------------------------------------------------------------

  private createPeople(): void {
    const n = this.opts.people;
    const sameNamePairs = Math.round(n * MIX.sameNamePairs);
    const householdPairs = Math.round(n * MIX.householdPairs);
    type Slot = { intended: PersonKind; hazard: Hazard | null };
    const slots: Slot[] = [];
    for (let i = 0; i < sameNamePairs; i++) {
      slots.push({
        intended: "ordinary",
        hazard: { kind: "same_name_relative", pair: i, role: "a" },
      });
      slots.push({
        intended: "ordinary",
        hazard: { kind: "same_name_relative", pair: i, role: "b" },
      });
    }
    for (let i = 0; i < householdPairs; i++) {
      slots.push({
        intended: "ordinary",
        hazard: { kind: "shared_household_phone", pair: i, role: "a" },
      });
      slots.push({
        intended: "ordinary",
        hazard: { kind: "shared_household_phone", pair: i, role: "b" },
      });
    }
    for (let i = 0; i < Math.round(n * MIX.sharedDevicePairs); i++) {
      slots.push({ intended: "ordinary", hazard: { kind: "shared_device", pair: i, role: "a" } });
      slots.push({ intended: "ordinary", hazard: { kind: "shared_device", pair: i, role: "b" } });
    }
    const add = (kind: PersonKind, count: number): void => {
      for (let i = 0; i < count; i++) slots.push({ intended: kind, hazard: null });
    };
    add("email_changed", Math.round(n * MIX.emailChanged));
    add("multi_email", Math.round(n * MIX.multiEmail));
    add("multi_device", Math.round(n * MIX.multiDevice));
    add("ordinary", n - slots.length);
    this.rng.shuffle(slots);

    const width = Math.max(5, String(n).length);
    const partner = new Map<string, Person>(); // hazard pair → role a
    const deferred: Person[] = [];
    for (const [i, slot] of slots.entries()) {
      const p = this.basePerson(
        `P${String(i + 1).padStart(width, "0")}`,
        slot.intended,
        slot.hazard,
      );
      this.people.push(p);
      if (slot.hazard?.role === "b") deferred.push(p);
      else if (slot.hazard) partner.set(`${slot.hazard.kind}:${slot.hazard.pair}`, p);
    }
    for (const b of deferred) {
      const h = b.hazard!;
      this.makeRelative(partner.get(`${h.kind}:${h.pair}`)!, b);
    }
  }

  private basePerson(id: string, intended: PersonKind, hazard: Hazard | null): Person {
    const rng = this.rng;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const company = rng.pick(COMPANIES);
    const workFirst = rng.bool(0.5);
    const p: Person = {
      id,
      intended,
      hazard,
      first,
      last,
      emails: [],
      phone: "",
      company,
      title: rng.pick(TITLES),
      address: this.address(),
      birth: this.birthDate(1955, 2003),
      inCrm: isIdentityHazard(hazard) || rng.bool(P_IN_CRM[intended]),
      deviceCount: 0,
      formCount: 0,
      firstSeen: WINDOW_START + rng.int(0, (WINDOW_END - WINDOW_START - 90 * DAY) / DAY) * DAY,
    };
    // Role b of a hazard pair gets its identifiers from role a in makeRelative.
    if (hazard?.role === "b") return p;
    p.phone = this.uniquePhone();
    p.emails.push(this.uniqueEmail(first, last, workFirst ? company : null));
    if (intended === "multi_email")
      p.emails.push(this.uniqueEmail(first, last, workFirst ? null : company));
    if (intended === "email_changed") p.emails.push(this.uniqueEmail(first, last, null));
    this.setActivityCounts(p);
    return p;
  }

  /** Fills role b of a hazard pair from role a: two different people who look alike. */
  private makeRelative(a: Person, b: Person): void {
    const rng = this.rng;
    b.last = a.last;
    b.address = a.address;
    if (b.hazard!.kind === "same_name_relative") {
      // Jr./Sr.: same first and last name, 22–35 years apart, sharing a phone or an email.
      b.first = a.first;
      const year = Number(a.birth.slice(0, 4));
      const monthDay = a.birth.slice(4) === "-02-29" ? "-02-28" : a.birth.slice(4);
      const junior = year + rng.int(22, 35);
      b.birth = `${junior <= 2005 ? junior : year - rng.int(22, 35)}${monthDay}`;
      if (rng.bool(P_SAME_NAME_SHARES_PHONE)) {
        b.phone = a.phone;
        b.emails = [this.uniqueEmail(b.first, b.last, rng.bool(0.5) ? b.company : null)];
      } else {
        b.phone = this.uniquePhone();
        b.emails = [a.emails[0]!];
      }
    } else {
      // Household: different first name, own email. shared_household_phone shares
      // the phone; shared_device has its own phone and shares a's device instead.
      while (canonicalFirst(b.first) === canonicalFirst(a.first)) b.first = rng.pick(FIRST_NAMES);
      if (!rng.bool(P_HOUSEHOLD_SAME_LAST)) {
        do b.last = rng.pick(LAST_NAMES);
        while (b.last === a.last);
      }
      if (b.hazard!.kind === "shared_device") {
        b.phone = this.uniquePhone();
        this.lender.set(b, a);
      } else {
        b.phone = a.phone;
      }
      b.emails = [this.uniqueEmail(b.first, b.last, rng.bool(0.5) ? b.company : null)];
    }
    this.setActivityCounts(b);
  }

  private setActivityCounts(p: Person): void {
    const rng = this.rng;
    switch (p.intended) {
      case "multi_device":
        p.deviceCount = 2 + (rng.bool(0.4) ? 1 : 0);
        break;
      case "multi_email":
        p.deviceCount = 1 + (rng.bool(0.3) ? 1 : 0);
        break;
      case "email_changed":
        p.deviceCount = 1;
        break;
      case "ordinary":
        p.deviceCount = p.hazard === null && p.inCrm && rng.bool(P_CRM_NO_DEVICE) ? 0 : 1;
        break;
    }
    if (p.deviceCount === 0) p.formCount = 0;
    else if (p.intended === "multi_email") p.formCount = 2 + (rng.bool(0.5) ? 1 : 0);
    else if (p.inCrm) p.formCount = rng.bool(P_FORM_IF_CRM) ? 1 + rng.geometric(0.7) : 0;
    else p.formCount = rng.bool(P_FORM_IF_NOT_CRM) ? 1 + rng.geometric(0.83) : 0;
  }

  // -- activity -------------------------------------------------------------

  private createActivity(p: Person): void {
    const rng = this.rng;
    const sessions: Session[] = [];
    const deviceIds: string[] = [];
    for (let d = 0; d < p.deviceCount; d++) {
      const anonymousId = rng.uuid();
      deviceIds.push(anonymousId);
      const count = 1 + rng.geometric(P_SESSION_STOP);
      for (const start of this.sessionStarts(p, count))
        sessions.push(this.session(p, anonymousId, start));
    }
    this.devices.set(p, deviceIds);
    const lender = this.lender.get(p);
    if (lender) {
      const borrowed = this.devices.get(lender)![0]!;
      const count = 1 + rng.geometric(P_BORROWED_SESSION_STOP);
      for (const start of this.sessionStarts(p, count))
        sessions.push(this.session(p, borrowed, start));
    }

    // Form fills go at the end of a random session, after its last page view.
    const forms: WebEventRow[] = [];
    for (let f = 0; f < p.formCount; f++) {
      const session = rng.pick(sessions);
      const last = session.events[session.events.length - 1]!;
      const at = Date.parse(last.occurred_at) + rng.int(30, 300) * 1000;
      const email = this.formEmail(p, f);
      const form = this.formSubmit(p, last.anonymous_id, at, email, last.properties.session_id!);
      session.events.push(form);
      this.producer.set(form, p);
      forms.push(form);
    }
    this.forms.set(p, forms);
    for (const s of sessions) for (const e of s.events) this.events.push(e);

    if (p.inCrm) this.createCrm(p, forms);
  }

  private sessionStarts(p: Person, count: number): number[] {
    const starts: number[] = [];
    for (let s = 0; s < count; s++)
      starts.push(
        p.firstSeen + this.rng.int(0, Math.floor((WINDOW_END - DAY - p.firstSeen) / 1000)) * 1000,
      );
    return starts.sort((x, y) => x - y);
  }

  private session(p: Person, anonymousId: string, start: number): Session {
    const rng = this.rng;
    const sessionId = `s_${rng.hex(16)}`;
    const channel = rng.weighted(ENTRY_CHANNEL);
    let utm: [string | null, string | null, string | null] = [null, null, null];
    let referrer: string | null = null;
    let landing = rng.pick(PAGES);

    if (channel === "paid_search" || channel === "paid_social") {
      const pool = CAMPAIGNS.filter(
        (c) => (channel === "paid_search") === (c.platform === "google_ads"),
      );
      const campaign = rng.pick(pool);
      const tagged = !rng.bool(P_UNTAGGED_CLICK);
      const click = this.click(campaign, start - rng.int(1, 20) * 1000, anonymousId, tagged);
      this.clicks.push(click);
      this.producer.set(click, p);
      if (tagged) utm = [campaign.utmSource, campaign.utmMedium, campaign.name];
      landing = rng.pick(["/", "/features", "/pricing", "/demo"]);
      if (rng.bool(P_UNTRACKED_CLICK)) {
        const at =
          WINDOW_START + rng.int(0, Math.floor((WINDOW_END - WINDOW_START) / 1000) - 1) * 1000;
        this.clicks.push(this.click(campaign, at, null, true));
      }
    } else if (channel === "email") {
      utm = ["newsletter", "email", rng.pick(EMAIL_CAMPAIGNS)];
    } else if (channel === "organic") {
      referrer = rng.pick(SEARCH_REFERRERS);
    } else if (channel === "referral") {
      referrer = rng.pick(REFERRAL_SITES);
    } else if (channel === "unrecognized") {
      const [source, medium] = rng.pick(UNRECOGNIZED_UTM);
      utm = [source, medium, "misc"];
    }

    const events: WebEventRow[] = [];
    const pages = 1 + rng.geometric(P_PAGE_STOP);
    let at = start;
    let path = landing;
    for (let i = 0; i < pages; i++) {
      events.push({
        source_event_id: "",
        occurred_at: iso(at),
        anonymous_id: anonymousId,
        event_name: "page_view",
        page_path: path,
        referrer: i === 0 ? referrer : `${SITE}${events[i - 1]!.page_path}`,
        utm_source: i === 0 ? utm[0] : null,
        utm_medium: i === 0 ? utm[1] : null,
        utm_campaign: i === 0 ? utm[2] : null,
        email: null,
        properties: { session_id: sessionId },
      });
      at += rng.int(10, 180) * 1000;
      path = rng.pick(PAGES);
    }
    for (const e of events) this.producer.set(e, p);
    return { start, events };
  }

  private click(
    campaign: Campaign,
    at: number,
    anonymousId: string | null,
    tagged: boolean,
  ): AdClickRow {
    const prefix = { google_ads: "gclid", meta: "fbclid", linkedin: "li_fat_id" }[
      campaign.platform
    ];
    return {
      source_event_id: "",
      occurred_at: iso(at),
      platform: campaign.platform,
      campaign: campaign.name,
      utm_source: tagged ? campaign.utmSource : null,
      utm_medium: tagged ? campaign.utmMedium : null,
      utm_campaign: tagged ? campaign.name : null,
      click_id: `${prefix}_${this.rng.hex(24)}`,
      anonymous_id: anonymousId,
    };
  }

  /** multi_email people alternate their emails; email_changed people use the new one. */
  private formEmail(p: Person, index: number): string {
    if (p.intended === "multi_email")
      return p.emails[index < 2 ? index : this.rng.int(0, p.emails.length - 1)]!;
    if (p.intended === "email_changed") return p.emails[1]!;
    return p.emails[0]!;
  }

  private formSubmit(
    p: Person,
    anonymousId: string,
    at: number,
    email: string,
    sessionId: string,
  ): WebEventRow {
    const rng = this.rng;
    const nicknames = NICKNAMES[p.first];
    let first = nicknames && rng.bool(P_NICKNAME) ? rng.pick(nicknames) : p.first;
    let last = p.last;
    if (rng.bool(P_LOWERCASE_NAME)) [first, last] = [first.toLowerCase(), last.toLowerCase()];
    const properties: Record<string, string> = {
      session_id: sessionId,
      form_id: rng.pick(["demo_request", "contact_sales", "whitepaper", "webinar"]),
      first_name: first,
      last_name: last,
      company: p.company,
    };
    if (rng.bool(P_FORM_PHONE)) properties.phone = this.formatPhone(p.phone);
    return {
      source_event_id: "",
      occurred_at: iso(at),
      anonymous_id: anonymousId,
      event_name: "form_submit",
      page_path: rng.pick(FORM_PAGES),
      referrer: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      email: this.emailNoise(email),
      properties,
    };
  }

  // -- CRM ------------------------------------------------------------------

  private createCrm(p: Person, forms: WebEventRow[]): void {
    const rng = this.rng;
    // A contact is created after the person's first form fill, if any.
    const firstForm =
      forms.length > 0 ? Math.min(...forms.map((f) => Date.parse(f.occurred_at))) : null;
    const latest = WINDOW_END - 2 * DAY;
    let created =
      firstForm !== null
        ? Math.min(firstForm + rng.int(3600, 3 * 86_400) * 1000, latest)
        : p.firstSeen + rng.int(0, Math.floor((latest - p.firstSeen) / 1000)) * 1000;
    const rows: CrmContactRow[] = [];

    // email_changed: an older contact under the old email, then a newer one under the new email, same phone.
    const emails = p.intended === "email_changed" ? [p.emails[0]!, p.emails[1]!] : [p.emails[0]!];
    for (const [i, email] of emails.entries()) {
      if (i > 0) created = Math.min(created + rng.int(60, 300) * DAY, latest);
      const mustHavePhone = isIdentityHazard(p.hazard) || p.intended === "email_changed";
      const row: CrmContactRow = {
        crm_id: "",
        email: this.emailNoise(email),
        email_verified: rng.bool(P_EMAIL_VERIFIED),
        phone: mustHavePhone || !rng.bool(P_CRM_NO_PHONE) ? this.formatPhone(p.phone) : null,
        first_name: p.first,
        last_name: p.last,
        dob: null,
        address: p.address.street,
        city: p.address.city,
        state: p.address.state,
        zip: p.address.zip,
        company: p.company,
        title: p.title,
        updated_at: iso(created),
      };
      this.contacts.push({ row, person: p, created });
      rows.push(row);
    }
    this.personContacts.set(p, rows);

    if (rng.bool(P_OPPORTUNITY)) {
      const owner = rows[rows.length - 1]!;
      const count = rng.bool(P_SECOND_OPPORTUNITY) ? 2 : 1;
      let opened = created;
      for (let i = 0; i < count; i++) {
        opened = Math.min(opened + rng.int(1, 60) * DAY + rng.int(0, 86_399) * 1000, latest);
        this.opportunities.push({ row: this.opportunity(opened), created: opened, owner });
      }
    }
  }

  private opportunity(opened: number): CrmOpportunityRow {
    const rng = this.rng;
    let stage: string = rng.weighted(OPP_STAGE);
    const closed = opened + rng.int(7, 120) * DAY;
    const isClosed = stage.startsWith("closed_") && closed < WINDOW_END;
    if (stage.startsWith("closed_") && !isClosed) {
      stage = rng.pick(["prospecting", "qualification", "proposal", "negotiation"]);
    }
    return {
      opp_id: "",
      crm_id: "", // the owner's crm_id, set in assignIds
      stage,
      amount: `${rng.int(20, 1200) * 100}.00`,
      opened_at: iso(opened),
      closed_at: isClosed ? iso(closed) : null,
      won: isClosed ? stage === "closed_won" : null,
    };
  }

  /**
   * DOB for round(dobRate × contacts) contacts. Hazard pairs are spread evenly
   * over the three DOB groups (both present, one missing, both missing) so the
   * hard-case report has every group; the remaining DOBs go to other contacts
   * at random.
   */
  private assignDob(): void {
    const rng = this.rng;
    const rate = this.opts.dobRate;
    let remaining = Math.round(rate * this.contacts.length);
    const hazardContacts = new Map<Person, CrmContactRow>();
    for (const c of this.contacts)
      if (isIdentityHazard(c.person.hazard)) hazardContacts.set(c.person, c.row);

    const pairs = new Map<string, Person[]>();
    for (const p of this.people) {
      if (!isIdentityHazard(p.hazard)) continue;
      const key = `${p.hazard.kind}:${String(p.hazard.pair).padStart(6, "0")}`;
      pairs.set(key, [...(pairs.get(key) ?? []), p]);
    }
    const byKind = new Map<HazardKind, Person[][]>();
    for (const [key, members] of [...pairs.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const kind = key.split(":")[0] as HazardKind;
      byKind.set(kind, [...(byKind.get(kind) ?? []), members]);
    }
    for (const kindPairs of byKind.values()) {
      for (const [i, pair] of kindPairs.entries()) {
        const group = rate <= 0 ? 2 : rate >= 1 ? 0 : i % 3; // 0 both, 1 one, 2 none
        const withDob = group === 0 ? pair : group === 1 ? [rng.pick(pair)] : [];
        for (const p of withDob) {
          hazardContacts.get(p)!.dob = p.birth;
          remaining--;
        }
      }
    }
    const others = this.contacts.filter((c) => !isIdentityHazard(c.person.hazard));
    rng.shuffle(others);
    for (const c of others.slice(0, Math.max(0, remaining))) c.row.dob = c.person.birth;
  }

  // -- IDs and ground truth -------------------------------------------------

  /** IDs follow time order, so they say nothing about which person a row belongs to. */
  private assignIds(): void {
    const byTime = <T>(items: T[], at: (x: T) => number): T[] =>
      items
        .map((x, i) => ({ x, i, t: at(x) }))
        .sort((a, b) => a.t - b.t || a.i - b.i)
        .map((e) => e.x);

    this.contacts = byTime(this.contacts, (c) => c.created);
    this.contacts.forEach((c, i) => (c.row.crm_id = `C${String(i + 1).padStart(6, "0")}`));

    this.opportunities = byTime(this.opportunities, (o) => o.created);
    this.opportunities.forEach((o, i) => {
      o.row.opp_id = `O${String(i + 1).padStart(6, "0")}`;
      o.row.crm_id = o.owner.crm_id;
    });

    this.events = byTime(this.events, (e) => Date.parse(e.occurred_at));
    this.events.forEach((e, i) => (e.source_event_id = `W${String(i + 1).padStart(7, "0")}`));

    this.clicks = byTime(this.clicks, (c) => Date.parse(c.occurred_at));
    this.clicks.forEach((c, i) => (c.source_event_id = `A${String(i + 1).padStart(7, "0")}`));
  }

  private groundTruth(): Pick<Tables, "truth_record" | "truth_hazard_pair" | "truth_event"> {
    const records: TruthRecordRow[] = [];
    const pairs = new Map<string, string[]>();
    for (const p of this.people) {
      const contacts = this.personContacts.get(p) ?? [];
      const forms = this.forms.get(p) ?? [];
      const devices = this.devices.get(p) ?? [];
      const kind = classifyPerson({
        formEmails: forms.map((f) => f.email!),
        deviceCount: devices.length,
        contacts: contacts.map((c) => ({ email: c.email, phone: c.phone })),
      });
      if (kind !== p.intended)
        throw new Error(`${p.id}: generated as ${p.intended} but its units say ${kind}`);
      if (contacts.length + forms.length + devices.length === 0)
        throw new Error(`${p.id} has no units`);
      for (const c of contacts)
        records.push({
          unit_type: "crm_contact",
          unit_key: c.crm_id,
          person_id: p.id,
          person_kind: kind,
        });
      for (const f of forms)
        records.push({
          unit_type: "form_submission",
          unit_key: f.source_event_id,
          person_id: p.id,
          person_kind: kind,
        });
      for (const d of devices)
        records.push({ unit_type: "device", unit_key: d, person_id: p.id, person_kind: kind });
      if (p.hazard) {
        if (isIdentityHazard(p.hazard) && contacts.length !== 1)
          throw new Error(`${p.id}: hazard person must have exactly one CRM contact`);
        const key = `${p.hazard.kind}:${p.hazard.pair}`;
        pairs.set(key, [...(pairs.get(key) ?? []), p.id]);
      }
    }
    const order: Record<TruthRecordRow["unit_type"], number> = {
      crm_contact: 0,
      form_submission: 1,
      device: 2,
    };
    records.sort((a, b) => order[a.unit_type] - order[b.unit_type] || cmp(a.unit_key, b.unit_key));

    const hazards: TruthHazardPairRow[] = [...pairs.entries()].map(([key, ids]) => {
      const [x, y] = [...ids].sort(cmp) as [string, string];
      return { person_a: x, person_b: y, kind: key.split(":")[0] as HazardKind };
    });
    hazards.sort((a, b) => cmp(a.person_a, b.person_a));

    // IDs follow time order per table, so the rows are already sorted by source_event_id.
    const events: TruthEventRow[] = [];
    for (const [table, rows] of [
      ["ad_click", this.clicks],
      ["web_event", this.events],
    ] as const) {
      for (const row of rows) {
        if (row.anonymous_id === null) continue;
        const person = this.producer.get(row);
        if (!person) throw new Error(`${row.source_event_id} has no producer`);
        events.push({
          source_table: table,
          source_event_id: row.source_event_id,
          person_id: person.id,
        });
      }
    }
    return { truth_record: records, truth_hazard_pair: hazards, truth_event: events };
  }

  // -- identifiers ----------------------------------------------------------

  private uniquePhone(): string {
    for (;;) {
      // Exchange 2xx–9xx, never N11 or 555, so libphonenumber accepts it.
      const exchange = this.rng.int(200, 999);
      if (exchange % 100 === 11 || exchange === 555) continue;
      const phone = `${this.rng.pick(AREA_CODES)}${exchange}${String(this.rng.int(0, 9999)).padStart(4, "0")}`;
      if (!this.usedPhones.has(phone)) {
        this.usedPhones.add(phone);
        return phone;
      }
    }
  }

  private uniqueEmail(first: string, last: string, company: string | null): string {
    const f = first.toLowerCase();
    const l = last.toLowerCase();
    const domain = company
      ? `${company.toLowerCase().replace(/[^a-z]/g, "")}.example.com`
      : this.rng.pick(PERSONAL_EMAIL_DOMAINS);
    const locals = [`${f}.${l}`, `${f[0]}${l}`, `${f}_${l}`, `${f}${l[0]}`];
    for (let attempt = 0; ; attempt++) {
      const base = this.rng.pick(locals);
      const local = attempt < 2 ? base : `${base}${this.rng.int(1, 999)}`;
      const email = `${local}@${domain}`;
      if (!this.usedEmails.has(email)) {
        this.usedEmails.add(email);
        return email;
      }
    }
  }

  /** Case and whitespace noise that staging.normalize_email and 01 both undo. */
  private emailNoise(email: string): string {
    if (!this.rng.bool(P_EMAIL_CASE_NOISE)) return email;
    return this.rng.bool(0.5)
      ? email.replace(/^./, (c) => c.toUpperCase())
      : ` ${email.toUpperCase()}`;
  }

  /** Formats that staging.to_e164 and 01's phonenumbers both read as the same number. */
  private formatPhone(digits: string): string {
    const [a, b, c] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
    return this.rng.pick([
      `(${a}) ${b}-${c}`,
      `${a}-${b}-${c}`,
      `${a}.${b}.${c}`,
      `+1 ${a} ${b} ${c}`,
      `1${digits}`,
      digits,
    ]);
  }

  private address(): Address {
    const [city, state, zipPrefix] = this.rng.pick(CITIES);
    const unit = this.rng.bool(0.2) ? ` Apt ${this.rng.int(1, 40)}` : "";
    return {
      street: `${this.rng.int(10, 9999)} ${this.rng.pick(STREETS)} ${this.rng.pick(STREET_SUFFIXES)}${unit}`,
      city,
      state,
      zip: `${zipPrefix}${String(this.rng.int(0, 99)).padStart(2, "0")}`,
    };
  }

  private birthDate(fromYear: number, toYear: number): string {
    const from = Date.UTC(fromYear, 0, 1);
    const to = Date.UTC(toYear, 11, 31);
    return iso(from + this.rng.int(0, (to - from) / DAY) * DAY).slice(0, 10);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const canonicalFirst = (name: string): string => {
  for (const [given, nicks] of Object.entries(NICKNAMES))
    if (name === given || nicks.includes(name)) return given;
  return name;
};

export interface PersonUnits {
  /** Email on each of the person's form submissions. */
  formEmails: readonly string[];
  deviceCount: number;
  contacts: readonly { email: string | null; phone: string | null }[];
}

const normEmail = (e: string | null): string | null =>
  e === null ? null : e.trim().toLowerCase() || null;
const normPhone = (p: string | null): string | null => {
  if (p === null) return null;
  const d = p.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d || null;
};

/**
 * person_kind from a person's units (docs/acceptance.md): multi_email, then
 * multi_device, then email_changed; ordinary when none applies.
 */
export function classifyPerson(u: PersonUnits): PersonKind {
  const formEmails = new Set(u.formEmails.map(normEmail).filter((e) => e !== null));
  if (formEmails.size >= 2) return "multi_email";
  if (u.deviceCount >= 2) return "multi_device";
  for (const [i, x] of u.contacts.entries()) {
    for (const y of u.contacts.slice(i + 1)) {
      const [ex, ey, px, py] = [
        normEmail(x.email),
        normEmail(y.email),
        normPhone(x.phone),
        normPhone(y.phone),
      ];
      if (ex && ey && ex !== ey && px && px === py) return "email_changed";
    }
  }
  return "ordinary";
}
