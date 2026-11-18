(() => {
  function latestExperience(profile) {
    const jobs = [...profile.experience ?? []];
    jobs.sort((a, b) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return String(b.end_date ?? "9999").localeCompare(String(a.end_date ?? "9999")) || String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""));
    });
    return jobs[0] ?? null;
  }
  function highestEducation(profile) {
    const edu = [...profile.education ?? []];
    edu.sort((a, b) => Number(b.end_year ?? 0) - Number(a.end_year ?? 0));
    return edu[0] ?? null;
  }
  function years(n) {
    if (n == null) return null;
    const rounded = Math.round(Number(n) * 10) / 10;
    return `${rounded} ${rounded === 1 ? "year" : "years"}`;
  }
  const DIAL_COUNTRIES = {
    "1": ["United States", "Canada"],
    "7": ["Russia", "Kazakhstan"],
    "20": ["Egypt"],
    "27": ["South Africa"],
    "30": ["Greece"],
    "31": ["Netherlands"],
    "32": ["Belgium"],
    "33": ["France"],
    "34": ["Spain"],
    "36": ["Hungary"],
    "39": ["Italy"],
    "40": ["Romania"],
    "41": ["Switzerland"],
    "43": ["Austria"],
    "44": ["United Kingdom"],
    "45": ["Denmark"],
    "46": ["Sweden"],
    "47": ["Norway"],
    "48": ["Poland"],
    "49": ["Germany"],
    "51": ["Peru"],
    "52": ["Mexico"],
    "54": ["Argentina"],
    "55": ["Brazil"],
    "56": ["Chile"],
    "57": ["Colombia"],
    "60": ["Malaysia"],
    "61": ["Australia"],
    "62": ["Indonesia"],
    "63": ["Philippines"],
    "64": ["New Zealand"],
    "65": ["Singapore"],
    "66": ["Thailand"],
    "81": ["Japan"],
    "82": ["South Korea"],
    "84": ["Vietnam"],
    "86": ["China"],
    "90": ["Turkey"],
    "91": ["India"],
    "92": ["Pakistan"],
    "93": ["Afghanistan"],
    "94": ["Sri Lanka"],
    "95": ["Myanmar"],
    "98": ["Iran"],
    "212": ["Morocco"],
    "213": ["Algeria"],
    "216": ["Tunisia"],
    "233": ["Ghana"],
    "234": ["Nigeria"],
    "254": ["Kenya"],
    "255": ["Tanzania"],
    "256": ["Uganda"],
    "260": ["Zambia"],
    "263": ["Zimbabwe"],
    "351": ["Portugal"],
    "352": ["Luxembourg"],
    "353": ["Ireland"],
    "355": ["Albania"],
    "358": ["Finland"],
    "359": ["Bulgaria"],
    "370": ["Lithuania"],
    "371": ["Latvia"],
    "372": ["Estonia"],
    "380": ["Ukraine"],
    "381": ["Serbia"],
    "385": ["Croatia"],
    "386": ["Slovenia"],
    "420": ["Czech Republic", "Czechia"],
    "421": ["Slovakia"],
    "591": ["Bolivia"],
    "852": ["Hong Kong"],
    "880": ["Bangladesh"],
    "886": ["Taiwan"],
    "961": ["Lebanon"],
    "962": ["Jordan"],
    "965": ["Kuwait"],
    "966": ["Saudi Arabia"],
    "968": ["Oman"],
    "971": ["United Arab Emirates", "UAE"],
    "972": ["Israel"],
    "973": ["Bahrain"],
    "974": ["Qatar"],
    "977": ["Nepal"]
  };
  function splitInternational(text) {
    const t = String(text ?? "").trim();
    if (!/^(?:\+|00)\s*\(?\d/.test(t)) return null;
    const digits = t.replace(/^(?:\+|00)/, "").replace(/\D/g, "");
    for (const n of [3, 2, 1]) {
      const code = digits.slice(0, n);
      if (DIAL_COUNTRIES[code]) return { code: `+${code}`, national: digits.slice(n) };
    }
    return null;
  }
  function dialCode(phone) {
    const known = splitInternational(phone)?.code;
    if (known) return known;
    const text = String(phone ?? "").trim();
    const spaced = /^\+(\d{1,3})[\s\-().]/.exec(text);
    if (spaced) return `+${spaced[1]}`;
    const joined = /^\+?(\d{11,13})$/.exec(text);
    return joined ? `+${joined[1].slice(0, -10)}` : null;
  }
  function profileAnswer(label, profile, app) {
    const l = label.toLowerCase();
    const sure = (value) => value ? { value: String(value), needsReview: false } : null;
    const check = (value) => value ? { value: String(value), needsReview: true } : null;
    const [first, ...rest] = (profile.full_name ?? "").trim().split(/\s+/);
    const link = (re) => profile.links?.find((x) => re.test(x.url) || re.test(x.label ?? ""))?.url;
    if (/(?:first(?: name)?|given(?: name)?|name)\s*(?:and|&|\/)\s*(?:last(?: name)?|family(?: name)?|surname)/.test(l)) return sure(profile.full_name);
    if (/first name|given name/.test(l)) return sure(first);
    if (/last name|surname|family name/.test(l)) return sure(rest.join(" "));
    if (/full name|^(your )?name\b|candidate name|applicant name/.test(l)) return sure(profile.full_name);
    if (/e-?mail/.test(l)) return sure(profile.email);
    const includeCode = /\b(?:include|including|with)\b.{0,20}\b(?:country|dial(?:l?ing)?|calling) ?code\b/.test(l);
    if (!includeCode && /country ?code|dial(?:l?ing)? code|calling code|phone code|\bisd\b/.test(l)) return sure(dialCode(profile.phone));
    if (/phone|mobile|contact (number|no)|whatsapp|telephone/.test(l)) return sure(profile.phone);
    if (/\b(?:lpa|(?:lakhs?|lacs?) per annum)\b/.test(l) && /\b(?:salary|ctc|compensation|pay)\b/.test(l)) {
      const prefs = profile.preferences;
      if (prefs?.currency !== "INR" || /\b(?:USD|EUR|GBP|SGD|AED|CAD|AUD|NPR|PKR|BDT|LKR)\b/i.test(label)) return null;
      const raw = /\b(?:expected|desired)\b/.test(l) ? prefs.expected_ctc : /\b(?:current|last drawn)\b/.test(l) ? prefs.current_ctc : null;
      const amount = Number(String(raw ?? "").replace(/,/g, ""));
      return amount > 0 && Number.isFinite(amount) ? sure(amount / 1e5) : null;
    }
    const annualExpected = /\b(?:annual|yearly) (?:salary |compensation |pay )?expectations?\b/.test(l);
    const annualDrawn = /\b(?:last drawn|current) (?:annual|yearly) (?:salary|compensation|pay)\b/.test(l);
    if (annualExpected || annualDrawn) {
      const currency = /\b(INR|USD|EUR|GBP|SGD|AED|CAD|AUD)\b/i.exec(label)?.[1].toUpperCase();
      const prefs = profile.preferences;
      return currency && currency === prefs?.currency ? sure(annualDrawn ? prefs.current_ctc : prefs.expected_ctc) : null;
    }
    if (/linkedin/.test(l)) return sure(link(/linkedin/i));
    if (/github/.test(l)) return sure(link(/github/i));
    if (/portfolio|personal (web)?site|^website/.test(l)) return sure(link(/portfolio|website|^https?:\/\/(?!.*(linkedin|github))/i));
    if (/^(current )?(location|city)\b|current (city|location)|where are you (currently )?(based|located)/.test(l)) {
      return sure(profile.location);
    }
    if (/\b(total|overall)\b.{0,40}\bexperience\b|^(how many )?years of (total |overall |professional |work |full[- ]time )?experience\W*$|^exp\.? in it industry\W*$/.test(l)) {
      return sure(years(profile.total_experience_years));
    }
    const job = latestExperience(profile);
    if (/current (company|employer|organi[sz]ation)|present (company|employer)/.test(l)) {
      return job?.is_current ? sure(job.company) : check(job?.company);
    }
    if (/current (job )?(title|designation|role|position)/.test(l)) {
      return job?.is_current ? sure(job.title) : check(job?.title);
    }
    const edu = highestEducation(profile);
    if (/highest (educational |education )?(qualification|degree|education)|^(educational )?qualification\W*$/.test(l)) {
      return sure(edu && [edu.degree, edu.field_of_study].filter(Boolean).join(" "));
    }
    if (/college|university|institut(e|ion)|alma mater/.test(l)) {
      if (!edu?.institution) return null;
      const withBranch = /branch|major|stream|speciali[sz]ation|discipline/.test(l) && edu.field_of_study;
      return sure(withBranch ? `${edu.institution} \u2013 ${edu.field_of_study}` : edu.institution);
    }
    if (/cover letter/.test(l)) return check(app?.cover_letter);
    if (/(professional )?summary|about yourself|tell us about you|introduce yourself/.test(l)) {
      return check(app?.tailored_summary || profile.summary);
    }
    return null;
  }
  globalThis.JobHuntProfile = { profileAnswer, dialCode, splitInternational, DIAL_COUNTRIES };
})();
