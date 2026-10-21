/**
 * Fixed vocabularies for the synthetic feeds. Every name, company and address is
 * invented or generic; emails use example.com/.net/.org only.
 */

/** Given name → nicknames. Every nickname here is in 01's NICKNAMES table. */
export const NICKNAMES: Readonly<Record<string, readonly string[]>> = {
  Robert: ["Bob", "Rob"],
  William: ["Bill", "Will"],
  Elizabeth: ["Liz", "Beth"],
  Anthony: ["Tony"],
  James: ["Jim"],
  John: ["Jack"],
  Richard: ["Rick"],
  Michael: ["Mike"],
  Katherine: ["Kate", "Katie"],
  Margaret: ["Maggie"],
  Jennifer: ["Jen", "Jenny"],
  Joseph: ["Joe"],
  Thomas: ["Tom"],
  Christopher: ["Chris"],
  Daniel: ["Dan"],
  Patricia: ["Pat"],
  Samuel: ["Sam"],
  Alexander: ["Alex"],
  Susan: ["Sue"],
  Charles: ["Charlie"],
  Edward: ["Ed"],
  Matthew: ["Matt"],
  Deborah: ["Deb"],
  Stephen: ["Steve"],
};

// prettier-ignore
export const FIRST_NAMES: readonly string[] = [
  ...Object.keys(NICKNAMES),
  "Aaliyah", "Aaron", "Abigail", "Adrian", "Aisha", "Alan", "Alicia", "Amara", "Amir", "Ana",
  "Andre", "Angela", "Arjun", "Ava", "Benjamin", "Brandon", "Brianna", "Caleb", "Camila", "Carlos",
  "Carmen", "Chloe", "Claire", "Connor", "Diana", "Diego", "Dmitri", "Elena", "Eli", "Emily",
  "Emma", "Ethan", "Fatima", "Felix", "Fiona", "Gabriel", "Grace", "Hana", "Hannah", "Hector",
  "Imani", "Isaac", "Isabel", "Ivan", "Jamal", "Jasmine", "Javier", "Julia", "Kai", "Kenji",
  "Laila", "Laura", "Leah", "Leo", "Lucas", "Lucia", "Maya", "Mei", "Mohammed", "Nadia",
  "Naomi", "Nathan", "Nina", "Noah", "Olivia", "Omar", "Owen", "Priya", "Rafael", "Rania",
  "Rebecca", "Rosa", "Ruth", "Sara", "Sofia", "Tariq", "Valeria", "Victor", "Wei", "Yusuf",
  "Zara", "Zoe",
];

// prettier-ignore
export const LAST_NAMES: readonly string[] = [
  "Abbott", "Acosta", "Adeyemi", "Alvarez", "Andersen", "Bakshi", "Barnes", "Becker", "Bennett", "Bishop",
  "Brennan", "Calloway", "Castillo", "Chandra", "Chen", "Cohen", "Coleman", "Cruz", "Dalton", "Delgado",
  "Dixon", "Donovan", "Dubois", "Ellis", "Espinoza", "Farouk", "Fischer", "Fleming", "Foster", "Garcia",
  "Gallagher", "Gonzalez", "Grant", "Gupta", "Hale", "Harper", "Hayes", "Hoffman", "Holloway", "Huang",
  "Ibrahim", "Ivanova", "Jackson", "Jensen", "Kapoor", "Keller", "Kim", "Kowalski", "Lambert", "Larsen",
  "Lee", "Lindqvist", "Lopez", "Maddox", "Mahmoud", "Marsh", "Medina", "Mendoza", "Morales", "Moreau",
  "Murphy", "Nakamura", "Novak", "Nwosu", "Okafor", "Olsen", "Ortega", "Osei", "Park", "Patel",
  "Pereira", "Petrov", "Quinn", "Ramirez", "Reyes", "Rossi", "Russo", "Saito", "Santos", "Schmidt",
  "Sharma", "Silva", "Sullivan", "Tanaka", "Torres", "Turner", "Vargas", "Vasquez", "Wagner", "Walsh",
  "Watanabe", "Weber", "Whitaker", "Wong", "Yamamoto", "Yilmaz", "Young", "Zhang", "Zimmerman", "Zubiri",
];

// prettier-ignore
export const COMPANIES: readonly string[] = [
  "Acme Analytics", "Bluefin Logistics", "Brightline Health", "Cedar Point Labs", "Copperleaf Retail",
  "Driftwood Media", "Evergreen Foods", "Fairway Finance", "Granite Systems", "Harborview Hotels",
  "Ironclad Security", "Juniper Robotics", "Keystone Insurance", "Lakeshore Energy", "Meridian Biotech",
  "Northwind Traders", "Oakridge Software", "Pinnacle Freight", "Quarry Street Studio", "Redwood Partners",
  "Silverline Telecom", "Summit Outdoor", "Tidewater Marine", "Umbra Design", "Vantage Learning",
  "Westbrook Legal", "Willow Creek Dental", "Yellowstone Apparel", "Zenith Aerospace", "Foundry Cloud",
];

// prettier-ignore
export const TITLES: readonly string[] = [
  "Marketing Manager", "VP Marketing", "Head of Growth", "Demand Gen Lead", "Data Analyst",
  "Operations Director", "CTO", "Software Engineer", "Sales Director", "Founder",
  "Product Manager", "IT Manager", "CFO", "Office Manager", "Consultant",
];

export const PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  "example.com",
  "example.net",
  "example.org",
];

/** Valid US area codes (same set as 01's generator), so `phonenumbers` accepts the numbers. */
// prettier-ignore
export const AREA_CODES: readonly string[] = [
  "201", "212", "213", "305", "310", "312", "404", "415", "425", "469",
  "503", "512", "602", "617", "646", "702", "713", "718", "786", "808",
  "818", "857", "919", "954", "973",
];

// prettier-ignore
export const STREETS: readonly string[] = [
  "Maple", "Oak", "Cedar", "Pine", "Elm", "Birch", "Willow", "Lake", "Hill", "River",
  "Park", "Sunset", "Highland", "Meadow", "Forest", "Washington", "Lincoln", "Jefferson", "Madison", "Franklin",
];

export const STREET_SUFFIXES: readonly string[] = [
  "St",
  "Ave",
  "Rd",
  "Dr",
  "Ln",
  "Blvd",
  "Ct",
  "Way",
];

/** City, state, ZIP prefix. */
// prettier-ignore
export const CITIES: readonly (readonly [string, string, string])[] = [
  ["Austin", "TX", "787"], ["Boston", "MA", "021"], ["Chicago", "IL", "606"], ["Denver", "CO", "802"],
  ["Miami", "FL", "331"], ["Seattle", "WA", "981"], ["Portland", "OR", "972"], ["Phoenix", "AZ", "850"],
  ["Atlanta", "GA", "303"], ["Raleigh", "NC", "276"], ["San Diego", "CA", "921"], ["Brooklyn", "NY", "112"],
  ["Newark", "NJ", "071"], ["Honolulu", "HI", "968"], ["Las Vegas", "NV", "891"], ["Dallas", "TX", "752"],
];

export const SITE = "https://www.northbeam-cdp.example";

// prettier-ignore
export const PAGES: readonly string[] = [
  "/", "/pricing", "/features", "/features/segments", "/features/attribution", "/integrations",
  "/customers", "/blog", "/blog/what-is-a-cdp", "/blog/attribution-models", "/blog/lead-scoring",
  "/docs", "/about", "/careers", "/security",
];

export const FORM_PAGES: readonly string[] = ["/demo", "/contact", "/whitepaper", "/webinar"];

// prettier-ignore
export const SEARCH_REFERRERS: readonly string[] = [
  "https://www.google.com/", "https://www.bing.com/", "https://duckduckgo.com/", "https://search.yahoo.com/",
];

// prettier-ignore
export const REFERRAL_SITES: readonly string[] = [
  "https://news.ycombinator.example/item", "https://www.g2.example/products/northbeam",
  "https://partner-blog.example.org/cdp-roundup", "https://www.reddit.example/r/marketing",
];

export interface Campaign {
  platform: "google_ads" | "meta" | "linkedin";
  name: string;
  utmSource: string;
  utmMedium: string;
}

export const CAMPAIGNS: readonly Campaign[] = [
  { platform: "google_ads", name: "brand_search", utmSource: "google", utmMedium: "cpc" },
  { platform: "google_ads", name: "generic_cdp", utmSource: "google", utmMedium: "cpc" },
  { platform: "google_ads", name: "competitor_terms", utmSource: "google", utmMedium: "cpc" },
  { platform: "meta", name: "retargeting_q", utmSource: "facebook", utmMedium: "paid_social" },
  { platform: "meta", name: "lookalike_smb", utmSource: "instagram", utmMedium: "paid_social" },
  { platform: "linkedin", name: "abm_enterprise", utmSource: "linkedin", utmMedium: "paid_social" },
  { platform: "linkedin", name: "webinar_promo", utmSource: "linkedin", utmMedium: "cpm" },
];

export const EMAIL_CAMPAIGNS: readonly string[] = [
  "newsletter_monthly",
  "nurture_step_2",
  "webinar_invite",
];

/** Tags that staging.channel_for doesn't recognize, so they map to 'unattributed'. */
// prettier-ignore
export const UNRECOGNIZED_UTM: readonly (readonly [string, string])[] = [
  ["partner_x", "banner"], ["podcast", "audio"], ["qr", "print"],
];
