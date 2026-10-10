import { DEALBREAKER_CAP, SCORE_MAX, type ScoreBreakdown } from "@job-newtab/agent-core";

const PARTS: { key: keyof typeof SCORE_MAX; label: string }[] = [
  { key: "role", label: "Role" },
  { key: "skills", label: "Skills" },
  { key: "location", label: "Location" },
  { key: "freshness", label: "Freshness" },
];

/** The fit score as a box score: one bar per part, then any cap or scaling note. */
export function ScoreParts({ breakdown }: { breakdown: ScoreBreakdown }) {
  return (
    <div className="score">
      {PARTS.map(({ key, label }) => {
        const value = breakdown[key];
        const max = SCORE_MAX[key];
        return (
          <div key={key} className="score-row">
            <span className="score-label">{label}</span>
            <span className="score-bar" aria-hidden="true">
              {value !== null && <i style={{ width: `${(value / max) * 100}%` }} />}
            </span>
            <span className="score-num">{value === null ? "no resume" : `${value}/${max}`}</span>
          </div>
        );
      })}
      {breakdown.skills === null && (
        <p className="score-note">Without a resume, the other three parts are scaled to 100.</p>
      )}
      {breakdown.dealbreaker && (
        <p className="score-note cap">
          Capped at {DEALBREAKER_CAP}: {breakdown.dealbreaker}
        </p>
      )}
    </div>
  );
}
