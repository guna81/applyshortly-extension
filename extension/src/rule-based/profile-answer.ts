// Pure profile resolution shared by classic content scripts and module workers.
(() => {
  function latestExperience(profile: any) {
    const jobs = [...(profile.experience ?? [])];
    jobs.sort((a, b) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return String(b.end_date ?? "9999").localeCompare(String(a.end_date ?? "9999")) ||
        String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""));
    });
    return jobs[0] ?? null;
  }

  function highestEducation(profile: any) {
    const edu = [...(profile.education ?? [])];
    edu.sort((a, b) => Number(b.end_year ?? 0) - Number(a.end_year ?? 0));
    return edu[0] ?? null;
  }

  function years(n: any) {
    if (n == null) return null;
    const rounded = Math.round(Number(n) * 10) / 10;
    return `${rounded} ${rounded === 1 ? "year" : "years"}`;
  }

  const { dialCode, splitInternational, DIAL_COUNTRIES } = globalThis.JobHuntPhone;
  function profileAnswer(label: string, profile: any, app?: any) {
    const l = label.toLowerCase();
    const sure = (value: any) => (value ? { value: String(value), needsReview: false } : null);
    const check = (value: any) => (value ? { value: String(value), needsReview: true } : null);
    const [first, ...rest] = (profile.full_name ?? "").trim().split(/\s+/);
    const link = (re: RegExp) => profile.links?.find((x: any) => re.test(x.url) || re.test(x.label ?? ""))?.url;

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
      const raw = /\b(?:expected|desired)\b/.test(l) ? prefs.expected_ctc
        : /\b(?:current|last drawn)\b/.test(l) ? prefs.current_ctc : null;
      const amount = Number(String(raw ?? "").replace(/,/g, ""));
      return amount > 0 && Number.isFinite(amount) ? sure(amount / 100000) : null;
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
      return sure(withBranch ? `${edu.institution} – ${edu.field_of_study}` : edu.institution);
    }
    if (/cover letter/.test(l)) return check(app?.cover_letter);
    if (/(professional )?summary|about yourself|tell us about you|introduce yourself/.test(l)) {
      return check(app?.tailored_summary || profile.summary);
    }
    return null;
  }

  (globalThis as any).JobHuntProfile = { profileAnswer, dialCode, splitInternational, DIAL_COUNTRIES };
})();
