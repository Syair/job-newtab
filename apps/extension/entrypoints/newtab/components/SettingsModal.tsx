import { useState } from "react";
import { MODEL_CHOICES, profileProblems, type JobProfile, type ScoutModel } from "@job-newtab/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { BackupControls } from "./BackupControls";
import { ProfileForm } from "./ProfileForm";

export function SettingsModal({
  profile,
  model,
  onChangeModel,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onForgetKey,
  onClose,
  onSave,
  onRestored,
}: {
  profile: JobProfile;
  model: ScoutModel;
  onChangeModel: (next: ScoutModel) => void;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onForgetKey: () => void;
  onClose: () => void;
  onSave: (profile: JobProfile, rebuild: boolean) => void;
  onRestored: () => void;
}) {
  const [draft, setDraft] = useState(profile);
  const problems = profileProblems(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(profile);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <ProfileForm value={draft} onChange={setDraft} />

          <section className="pf-section">
            <h3>Agent</h3>
            <label className="pf-inline">
              Model
              <select value={model} onChange={(e) => onChangeModel(e.target.value as ScoutModel)}>
                {MODEL_CHOICES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pf-check">
              <input type="checkbox" checked={autoRebuild} onChange={(e) => onToggleAutoRebuild(e.target.checked)} />
              Look for new jobs automatically, every
              <select
                value={intervalHours}
                disabled={!autoRebuild}
                onChange={(e) => onChangeInterval(Number(e.target.value))}
              >
                {REBUILD_INTERVAL_CHOICES.map((h) => (
                  <option key={h} value={h}>
                    {h === 24 ? "24 hours (daily)" : `${h} hours`}
                  </option>
                ))}
              </select>
            </label>
            <p className="pf-hint">Each search is one agent run billed to your API key.</p>
            <button className="link-btn" onClick={onForgetKey}>
              Remove API key from this browser
            </button>
          </section>

          <BackupControls onRestored={onRestored} />
        </div>

        <div className="modal-foot">
          {problems.length > 0 && <span className="pf-error">{problems[0]}</span>}
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-quiet" disabled={problems.length > 0 || !changed} onClick={() => onSave(draft, false)}>
            Save
          </button>
          <button className="btn" disabled={problems.length > 0} onClick={() => onSave(draft, true)}>
            Save &amp; search now
          </button>
        </div>
      </div>
    </div>
  );
}
