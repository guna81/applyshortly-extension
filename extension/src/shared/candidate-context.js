// One profile projection for custom planning, panel chat and answer drafting.
// Resume bytes and storage locations never go to the model.
/** @param {any} profile */
export function candidateContext(profile) {
  return {
    full_name: profile.full_name, email: profile.email, phone: profile.phone,
    location: profile.location, gender: profile.gender, date_of_birth: profile.date_of_birth,
    links: profile.links, summary: profile.summary, skills: profile.skills,
    experience: profile.experience, education: profile.education,
    total_experience_years: profile.total_experience_years,
    preferences: profile.preferences, answers: profile.answers,
    has_resume_file: Boolean(profile.resume_url),
  };
}
