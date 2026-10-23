import type { Channel } from "@cdp/attribution";

/**
 * The one table of channel cases. test/channel-parity.test.ts runs every case through
 * definitions.ts and through the staging SQL, and each must give `expected`.
 * An event is one row of raw.web_event; events of a case share one session when `session`
 * is set and are listed in time order (the first is the entry event).
 */
export interface CaseEvent {
  source?: string | null;
  medium?: string | null;
  referrer?: string | null;
}

export interface ChannelCase {
  name: string;
  /** Without a session each event stands alone. */
  session: boolean;
  events: CaseEvent[];
  expected: Channel[];
}

const SITE = "https://www.northbeam-cdp.example";

function single(name: string, event: CaseEvent, expected: Channel): ChannelCase {
  return { name, session: false, events: [event], expected: [expected] };
}

export const CHANNEL_CASES: ChannelCase[] = [
  // Rule 1: a recognized medium decides.
  ...[
    ["cpc", "paid_search"],
    ["ppc", "paid_search"],
    ["paid_search", "paid_search"],
    ["sem", "paid_search"],
    ["paid_social", "paid_social"],
    ["paidsocial", "paid_social"],
    ["social_paid", "paid_social"],
    ["cpm", "paid_social"],
    ["email", "email"],
    ["e-mail", "email"],
    ["newsletter", "email"],
    ["organic", "organic"],
    ["social", "organic"],
    ["organic_social", "organic"],
    ["referral", "referral"],
  ].map(([medium, channel]) =>
    single(`medium ${medium}`, { source: "x", medium }, channel as Channel),
  ),
  single("medium alone, no source", { medium: "cpc" }, "paid_search"),
  single("medium is case-insensitive", { source: "G", medium: "CPC" }, "paid_search"),
  single("medium is trimmed (spaces)", { medium: "  Email  " }, "email"),
  single(
    "medium beats a search referrer",
    { medium: "email", referrer: "https://google.com/" },
    "email",
  ),
  single(
    "medium beats an internal referrer",
    { medium: "cpc", referrer: `${SITE}/pricing` },
    "paid_search",
  ),
  // Rule 2: tags present, not recognized.
  single("unknown medium", { source: "partner_x", medium: "banner" }, "unattributed"),
  single("source only", { source: "newsletter" }, "unattributed"),
  single(
    "unknown medium beats a search referrer",
    { medium: "banner", referrer: "https://google.com/" },
    "unattributed",
  ),
  single("tab is not trimmed", { medium: "\tcpc" }, "unattributed"),
  // Blank tags are no tags.
  single("blank tags, no referrer", { source: "  ", medium: "" }, "direct"),
  single("null everything", {}, "direct"),
  single("blank referrer", { referrer: "   " }, "direct"),
  // Rules 5 and 6: referrer.
  single("google", { referrer: "https://www.google.com/search?q=x" }, "organic"),
  single("bing without scheme", { referrer: "bing.com" }, "organic"),
  single("duckduckgo", { referrer: "https://duckduckgo.com/" }, "organic"),
  single("yahoo subdomain", { referrer: "http://search.yahoo.com/x" }, "organic"),
  single("ecosia", { referrer: "https://www.ecosia.org/" }, "organic"),
  single("search host is case-insensitive", { referrer: "HTTPS://WWW.GOOGLE.COM/" }, "organic"),
  single(
    "google as a path is not a search engine",
    { referrer: "https://evil.example/google.com" },
    "referral",
  ),
  single("google without a dot after it", { referrer: "https://google/" }, "referral"),
  single("other site", { referrer: "https://news.ycombinator.example/item" }, "referral"),
  // Rule 4 and ADR 0002 decision 2: our own site.
  single("internal referrer, no entry event", { referrer: `${SITE}/pricing` }, "direct"),
  single("internal referrer, bare host", { referrer: "northbeam-cdp.example" }, "direct"),
  single("internal referrer, port", { referrer: "http://northbeam-cdp.example:8080/x" }, "direct"),
  single(
    "internal referrer, query only",
    { referrer: "https://app.northbeam-cdp.example?x=1" },
    "direct",
  ),
  single(
    "internal referrer, upper case",
    { referrer: "HTTPS://WWW.NORTHBEAM-CDP.EXAMPLE/A" },
    "direct",
  ),
  single(
    "internal referrer with a medium",
    { source: "x", medium: "email", referrer: `${SITE}/` },
    "email",
  ),
  single(
    "internal referrer with unknown tags",
    { source: "x", referrer: `${SITE}/` },
    "unattributed",
  ),
  single(
    "look-alike host is a referral",
    { referrer: "https://northbeam-cdp.example.evil.example/" },
    "referral",
  ),
  single(
    "look-alike prefix is a referral",
    { referrer: "https://notnorthbeam-cdp.example/" },
    "referral",
  ),
  single(
    "our host in a query is a referral",
    { referrer: "https://evil.example/?u=northbeam-cdp.example" },
    "referral",
  ),
  // Sessions.
  {
    name: "session: paid entry, internal page views continue it",
    session: true,
    events: [
      { source: "google", medium: "cpc" },
      { referrer: `${SITE}/` },
      { referrer: `${SITE}/pricing` },
    ],
    expected: ["paid_search", "paid_search", "paid_search"],
  },
  {
    name: "session: organic entry",
    session: true,
    events: [{ referrer: "https://www.google.com/" }, { referrer: `${SITE}/` }],
    expected: ["organic", "organic"],
  },
  {
    name: "session: referral entry",
    session: true,
    events: [{ referrer: "https://news.ycombinator.example/item" }, { referrer: `${SITE}/` }],
    expected: ["referral", "referral"],
  },
  {
    name: "session: direct entry",
    session: true,
    events: [{}, { referrer: `${SITE}/` }],
    expected: ["direct", "direct"],
  },
  {
    name: "session: internal referrer on the entry event",
    session: true,
    events: [{ referrer: `${SITE}/` }, { referrer: `${SITE}/pricing` }],
    expected: ["direct", "direct"],
  },
  {
    name: "session: later event with its own tags keeps the entry channel",
    session: true,
    events: [{ referrer: "https://www.google.com/" }, { source: "x", medium: "email" }],
    expected: ["organic", "organic"],
  },
  {
    name: "session: later external referrer keeps the entry channel",
    session: true,
    events: [{ source: "newsletter", medium: "email" }, { referrer: "https://other.example/" }],
    expected: ["email", "email"],
  },
  {
    name: "session: unrecognized entry tags",
    session: true,
    events: [{ source: "qr", medium: "print" }, { referrer: `${SITE}/` }],
    expected: ["unattributed", "unattributed"],
  },
];

/** Ad clicks: staging.ad_click.channel. */
export interface AdClickCase {
  name: string;
  platform: string;
  source?: string | null;
  medium?: string | null;
  expected: Channel;
}

export const AD_CLICK_CASES: AdClickCase[] = [
  {
    name: "tagged search click",
    platform: "google_ads",
    source: "google",
    medium: "cpc",
    expected: "paid_search",
  },
  {
    name: "tagged social click",
    platform: "meta",
    source: "facebook",
    medium: "paid_social",
    expected: "paid_social",
  },
  {
    name: "tag wins over platform",
    platform: "google_ads",
    source: "x",
    medium: "paid_social",
    expected: "paid_social",
  },
  {
    name: "unknown tag on a click",
    platform: "meta",
    source: "x",
    medium: "banner",
    expected: "unattributed",
  },
  { name: "untagged google_ads", platform: "google_ads", expected: "paid_search" },
  { name: "untagged meta", platform: "meta", expected: "paid_social" },
  {
    name: "untagged linkedin",
    platform: "linkedin",
    source: " ",
    medium: "",
    expected: "paid_social",
  },
  { name: "untagged unknown platform", platform: "tiktok", expected: "unattributed" },
  {
    name: "platform named like a prototype key",
    platform: "constructor",
    expected: "unattributed",
  },
];
