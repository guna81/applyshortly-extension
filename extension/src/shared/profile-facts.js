// Sensitive-looking questions the saved profile already answers (gender, visa sponsorship, work authorisation).
// The agent fills these straight from the profile instead of asking. A truth/eligibility *declaration*
// ("I certify…") and anything the profile does not hold still go to the user.
const DECLARATION = /\b(?:certify|declare|swear|attest|true and (?:correct|accurate)|captcha|robot|verification code)\b/i;
const SPONSORSHIP = /\b(?:sponsor(?:ship)?|visa)\b/i;
const NEGATED = /\b(?:without|not require|no longer|not need|do not need|don'?t need)\b/i;
const WORK_AUTH = /\b(?:authori[sz]ed|eligible|right|legally (?:able|entitled|permitted)|permitted)\b.{0,30}\bwork\b|\bwork (?:authori[sz]ation|permit)\b/i;
const GENDER = /\b(?:gender|sex)\b/i;

const regionName = (code) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase()) ?? ""; } catch { return ""; } };
const mentions = (text, code) => {
  const names = [String(code), regionName(code)].filter(Boolean);
  return names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, name.length === 2 ? "" : "i").test(text));
};
const UNSPECIFIED = /^\W*(?:(?:remote|worldwide|global|anywhere|hybrid|distributed|flexible)\W*)*$/i;
const hasRight = (status) => !/\b(?:no|not|needs?|requires?)\b/i.test(String(status));

/** The job's place (a city or country) when the job record states one. */
export const jobPlace = (job) => String(job?.location ?? job?.city ?? job?.country ?? "").trim();

/**
 * The answer the profile holds for a question: "yes", "no", a gender, or null when the profile has none.
 * Work authorization and visa sponsorship depend on the job's country: they are answered only from the
 * user's stated status for that country, never from a country-less yes/no.
 */
export function profileFact(question, profile, job) {
  const text = String(question ?? "");
  if (!text.trim() || DECLARATION.test(text)) return null;
  const prefs = profile?.preferences ?? {};
  const authorizations = Object.entries(prefs.work_authorization ?? {}).filter(([, status]) => String(status ?? "").trim());
  const place = jobPlace(job);
  if (SPONSORSHIP.test(text)) {
    if (NEGATED.test(text) || typeof prefs.requires_sponsorship !== "boolean") return null;
    const home = authorizations.filter(([, status]) => hasRight(status)).map(([country]) => country);
    if (!home.length) return prefs.requires_sponsorship ? "yes" : "no";
    if (!place) return null;
    if (home.some((country) => mentions(place, country))) return "no";
    return UNSPECIFIED.test(place) ? null : "yes";
  }
  if (WORK_AUTH.test(text)) {
    const named = authorizations.find(([country]) => mentions(text, country));
    const entry = named ?? (place && !UNSPECIFIED.test(place) ? authorizations.find(([country]) => mentions(place, country)) : null);
    return entry ? (hasRight(entry[1]) ? "yes" : "no") : null;
  }
  if (GENDER.test(text) && String(profile?.gender ?? "").trim()) return String(profile.gender).trim().toLowerCase();
  return null;
}

/** Whether an option (a button, radio or dropdown entry) is the one the profile fact names. */
export function factMatches(fact, option) {
  const want = String(fact ?? "").toLowerCase();
  const text = String(option ?? "").trim().toLowerCase();
  if (!want || !text) return false;
  if (want === "yes" || want === "no") return new RegExp(`^${want}\\b`).test(text);
  if (/^(?:male|man)$/.test(want)) return /^(?:male|man)$/.test(text);
  if (/^(?:female|woman)$/.test(want)) return /^(?:female|woman)$/.test(text);
  return text === want;
}

const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** @type {Array<[RegExp, number]>} */
const UNIT_DAYS = [[/^(?:d|days?)$/, 1], [/^(?:w|wks?|weeks?)$/, 7], [/^(?:mos?|months?)$/, 30], [/^(?:y|yrs?|years?)$/, 365]];
/** The days in a plain length of time ("30 days", "One month", "4 wks", "30d", "a week", "2 months notice"), or null for anything else. fill.js keeps the same rule for the page side. */
export function durationDays(text) {
  const m = /^\s*(?:about|around|approx\.?)?\s*(\d{1,3}|[a-z]+)\s*[- ]?\s*([a-z]+)\.?(?:\s+notice)?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const count = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1].toLowerCase()];
  const unit = UNIT_DAYS.find(([pattern]) => pattern.test(m[2].toLowerCase()));
  return count && unit ? count * unit[1] : null;
}

/** Whether an answer is one of a list's options, loosely: equal, one contains the other, yes/no, every comma part, or the same length of time. */
export function answerFitsOptions(answer, options) {
  const plain = (t) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const want = plain(answer);
  if (!want) return false;
  const days = durationDays(answer);
  const parts = String(answer).split(",").map(plain).filter(Boolean);
  return options.some((option) => {
    const have = plain(option);
    if (!have) return false;
    if (have === want || (Math.min(have.length, want.length) >= 3 && (have.includes(want) || want.includes(have)))) return true;
    if (/^(?:yes|no)\b/.test(want) && new RegExp(`^${want.split(" ")[0]}\\b`).test(have)) return true;
    if (days !== null && durationDays(option) === days) return true;
    return parts.length >= 2 && parts.every((part) => ` ${have} `.includes(` ${part} `));
  });
}
