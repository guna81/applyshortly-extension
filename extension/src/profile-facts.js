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
