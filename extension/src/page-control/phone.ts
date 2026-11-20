(() => {
  const DIAL_COUNTRIES: Record<string, string[]> = {
    "1": ["United States", "Canada"], "7": ["Russia", "Kazakhstan"], "20": ["Egypt"], "27": ["South Africa"],
    "30": ["Greece"], "31": ["Netherlands"], "32": ["Belgium"], "33": ["France"], "34": ["Spain"],
    "36": ["Hungary"], "39": ["Italy"], "40": ["Romania"], "41": ["Switzerland"], "43": ["Austria"],
    "44": ["United Kingdom"], "45": ["Denmark"], "46": ["Sweden"], "47": ["Norway"], "48": ["Poland"],
    "49": ["Germany"], "51": ["Peru"], "52": ["Mexico"], "54": ["Argentina"], "55": ["Brazil"],
    "56": ["Chile"], "57": ["Colombia"], "60": ["Malaysia"], "61": ["Australia"], "62": ["Indonesia"],
    "63": ["Philippines"], "64": ["New Zealand"], "65": ["Singapore"], "66": ["Thailand"], "81": ["Japan"],
    "82": ["South Korea"], "84": ["Vietnam"], "86": ["China"], "90": ["Turkey"], "91": ["India"],
    "92": ["Pakistan"], "93": ["Afghanistan"], "94": ["Sri Lanka"], "95": ["Myanmar"], "98": ["Iran"],
    "212": ["Morocco"], "213": ["Algeria"], "216": ["Tunisia"], "233": ["Ghana"], "234": ["Nigeria"],
    "254": ["Kenya"], "255": ["Tanzania"], "256": ["Uganda"], "260": ["Zambia"], "263": ["Zimbabwe"],
    "351": ["Portugal"], "352": ["Luxembourg"], "353": ["Ireland"], "355": ["Albania"], "358": ["Finland"],
    "359": ["Bulgaria"], "370": ["Lithuania"], "371": ["Latvia"], "372": ["Estonia"], "380": ["Ukraine"],
    "381": ["Serbia"], "385": ["Croatia"], "386": ["Slovenia"], "420": ["Czech Republic", "Czechia"],
    "421": ["Slovakia"], "591": ["Bolivia"], "852": ["Hong Kong"], "880": ["Bangladesh"], "886": ["Taiwan"],
    "961": ["Lebanon"], "962": ["Jordan"], "965": ["Kuwait"], "966": ["Saudi Arabia"], "968": ["Oman"],
    "971": ["United Arab Emirates", "UAE"], "972": ["Israel"], "973": ["Bahrain"], "974": ["Qatar"], "977": ["Nepal"],
  };
  function splitInternational(text: any) {
    const t = String(text ?? "").trim();
    if (!/^(?:\+|00)\s*\(?\d/.test(t)) return null;
    const digits = t.replace(/^(?:\+|00)/, "").replace(/\D/g, "");
    for (const n of [3, 2, 1]) {
      const code = digits.slice(0, n);
      if (DIAL_COUNTRIES[code]) return { code: `+${code}`, national: digits.slice(n) };
    }
    return null;
  }

  function dialCode(phone: any) {
    const known = splitInternational(phone)?.code;
    if (known) return known;
    const text = String(phone ?? "").trim();
    const spaced = /^\+(\d{1,3})[\s\-().]/.exec(text);
    if (spaced) return `+${spaced[1]}`;
    const joined = /^\+?(\d{11,13})$/.exec(text);
    return joined ? `+${joined[1].slice(0, -10)}` : null;
  }

  /**
   * Answers that come straight from profile fields. Anything else goes to the platform's
   * /answers/suggest, which knows preferences (notice period, CTC, work authorisation) and the
   * answer bank. Returns {value, needsReview} or null.
   */
  globalThis.JobHuntPhone = { dialCode, splitInternational, DIAL_COUNTRIES };
})();
