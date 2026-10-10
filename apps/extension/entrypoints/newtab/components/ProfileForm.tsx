import { useState, type KeyboardEvent } from "react";
import {
  PRESET_COMPANIES,
  SENIORITY_CHOICES,
  companyKey,
  parseCompanyInput,
  type CompanySource,
  type JobProfile,
  type Seniority,
} from "@job-newtab/agent-core";

const ROLE_SUGGESTIONS = [
  "Software Engineer",
  "Frontend Engineer",
  "Backend Engineer",
  "ML Engineer",
  "Data Scientist",
  "Data Engineer",
  "Product Manager",
  "Product Designer",
];

const METRO_SUGGESTIONS = [
  "San Francisco, CA",
  "New York, NY",
  "Seattle, WA",
  "Austin, TX",
  "Boston, MA",
  "Los Angeles, CA",
  "Chicago, IL",
  "Denver, CO",
];

/** The whole profile as one form, used for onboarding and in Settings. */
export function ProfileForm({ value, onChange }: { value: JobProfile; onChange: (next: JobProfile) => void }) {
  const set = <K extends keyof JobProfile>(key: K, v: JobProfile[K]) => onChange({ ...value, [key]: v });

  return (
    <div className="pf">
      <section className="pf-section">
        <h3>What roles?</h3>
        <ChipInput
          values={value.roles}
          onChange={(roles) => set("roles", roles)}
          suggestions={ROLE_SUGGESTIONS}
          placeholder="Type a job title and press Enter"
        />
        <div className="pf-label">Levels</div>
        <div className="pf-checks">
          {SENIORITY_CHOICES.map((s) => (
            <label key={s.id} className="pf-check">
              <input
                type="checkbox"
                checked={value.seniority.includes(s.id)}
                onChange={(e) =>
                  set(
                    "seniority",
                    e.target.checked
                      ? [...value.seniority, s.id]
                      : value.seniority.filter((x): x is Seniority => x !== s.id),
                  )
                }
              />
              {s.label}
            </label>
          ))}
        </div>
      </section>

      <section className="pf-section">
        <h3>Where?</h3>
        <ChipInput
          values={value.locations}
          onChange={(locations) => set("locations", locations)}
          suggestions={METRO_SUGGESTIONS}
          placeholder='US metro, e.g. "Seattle, WA"'
        />
        <div className="pf-checks">
          <label className="pf-check">
            <input type="checkbox" checked={value.remoteOk} onChange={(e) => set("remoteOk", e.target.checked)} />
            Remote (US)
          </label>
          <label className="pf-check">
            <input
              type="checkbox"
              checked={value.anywhereInUS}
              onChange={(e) => set("anywhereInUS", e.target.checked)}
            />
            Anywhere in the US
          </label>
        </div>
      </section>

      <section className="pf-section">
        <h3>Where to look</h3>
        <div className="pf-checks">
          <label className="pf-check">
            <input
              type="checkbox"
              checked={value.boards.linkedin}
              onChange={(e) => set("boards", { ...value.boards, linkedin: e.target.checked })}
            />
            LinkedIn
          </label>
          <label className="pf-check">
            <input
              type="checkbox"
              checked={value.boards.indeed}
              onChange={(e) => set("boards", { ...value.boards, indeed: e.target.checked })}
            />
            Indeed
          </label>
        </div>
        <p className="pf-hint">
          Board searches open in a background window using your own sign-in. Stay signed in to LinkedIn for
          full results.
        </p>
        <CompanyPicker value={value.companies} onChange={(companies) => set("companies", companies)} />
      </section>

      <section className="pf-section">
        <h3>About you</h3>
        <div className="pf-label">Resume (paste the text — it makes match scores meaningful)</div>
        <textarea
          className="pf-textarea"
          rows={8}
          value={value.resume}
          onChange={(e) => set("resume", e.target.value)}
          placeholder="Paste your resume as plain text"
        />
        <div className="pf-label">Preferences and dealbreakers</div>
        <textarea
          className="pf-textarea"
          rows={3}
          value={value.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder={'e.g. "Needs H-1B sponsorship", "No crypto or gambling", "Prefer Series B+ startups"'}
        />
      </section>
    </div>
  );
}

function ChipInput({
  values,
  onChange,
  suggestions,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (text: string) => {
    const v = text.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const remaining = suggestions.filter((s) => !values.includes(s));

  return (
    <>
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="chips-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft && add(draft)}
          placeholder={values.length ? "" : placeholder}
        />
      </div>
      {remaining.length > 0 && (
        <div className="suggest">
          {remaining.map((s) => (
            <button key={s} className="suggest-item" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CompanyPicker({ value, onChange }: { value: CompanySource[]; onChange: (next: CompanySource[]) => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = new Set(value.map(companyKey));
  const custom = value.filter((c) => !PRESET_COMPANIES.some((p) => companyKey(p) === companyKey(c)));

  const toggle = (c: CompanySource) =>
    onChange(selected.has(companyKey(c)) ? value.filter((x) => companyKey(x) !== companyKey(c)) : [...value, c]);

  const addCustom = () => {
    const parsed = parseCompanyInput(draft);
    if (!parsed) {
      setError("Paste a Greenhouse, Lever or Ashby careers link, e.g. https://jobs.lever.co/acme");
      return;
    }
    const name = parsed.slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (!selected.has(companyKey(parsed))) onChange([...value, { ...parsed, name }]);
    setDraft("");
    setError(null);
  };

  return (
    <>
      <div className="pf-label">
        Company career boards · {value.length} selected
        <button className="link-btn" onClick={() => onChange(value.length ? [] : PRESET_COMPANIES)}>
          {value.length ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="company-grid">
        {[...PRESET_COMPANIES, ...custom].map((c) => (
          <label key={companyKey(c)} className={`company ${selected.has(companyKey(c)) ? "on" : ""}`}>
            <input type="checkbox" checked={selected.has(companyKey(c))} onChange={() => toggle(c)} />
            {c.name}
          </label>
        ))}
      </div>
      <div className="pf-row">
        <input
          className="pf-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="Add another: paste its careers link (Greenhouse, Lever or Ashby)"
        />
        <button className="btn btn-quiet" onClick={addCustom} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {error && <div className="pf-error">{error}</div>}
    </>
  );
}
