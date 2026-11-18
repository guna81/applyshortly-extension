// Generated from agent-rules.json. Shared tests verify this module and the Python copy.
export const AGENT_RULES = {
  "version": 1,
  "consent": {
    "allow": "privacy|terms|data (?:processing|protection)",
    "deny": "certify|declare|swear|true and (?:correct|accurate)|accurate|truthful|\\b(?:18|21)\\b|age of majority|not (?:been )?convicted|criminal|sponsor|visa|authori[sz]ed to work|right to work|eligible to work|gender|race|ethnic|veteran|disabilit|hispanic|latino|latinx|sexual orientation|pronouns?|transgender|captcha|verification code|security code|\\bage\\b|\\b(?:under|over|at least)\\s+\\d+|eligibil|citizenship|nationality|religio|\\bcaste\\b|\\bracial\\b|code (?:shown|in the image)|\\brobot\\b|\\bcorrect\\b"
  },
  "skip": {
    "normalize_whitespace": true,
    "case_sensitive": false,
    "remember_across_observations": true,
    "allow_fill": false,
    "allow_reask": false
  },
  "typed_links": {
    "pattern": "https?://[^\\s<>\"')\\]]+",
    "allowed_scheme": "https://",
    "max_links": 10,
    "trailing_punctuation": ".,;:!?",
    "match": "exact_normalized_url"
  }
};
