import { useState } from "react";
import { EMPTY_PROFILE, PRESET_COMPANIES, profileProblems, type JobProfile } from "@job-newtab/agent-core";
import { ProfileForm } from "./ProfileForm";

/** First run: one page that collects the profile, then starts the first search. */
export function Onboarding({ onDone }: { onDone: (profile: JobProfile) => void }) {
  const [profile, setProfile] = useState<JobProfile>({ ...EMPTY_PROFILE, companies: PRESET_COMPANIES });
  const problems = profileProblems(profile);

  return (
    <div className="page">
      <header className="onboard-head">
        <h1>Set up your job search</h1>
        <p>
          Tell it what you are looking for. Every day it checks company career boards and your LinkedIn / Indeed
          searches, scores each opening against your resume, and shows only the new ones here.
        </p>
      </header>
      <ProfileForm value={profile} onChange={setProfile} />
      <footer className="onboard-foot">
        {problems.length > 0 && <span className="pf-error">{problems[0]}</span>}
        <button className="btn btn-big" disabled={problems.length > 0} onClick={() => onDone(profile)}>
          Find my jobs
        </button>
      </footer>
    </div>
  );
}
