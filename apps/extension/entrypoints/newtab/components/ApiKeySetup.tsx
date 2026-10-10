import { useState } from "react";
import { BackupControls } from "./BackupControls";

export function ApiKeySetup({ onSave, onRestored }: { onSave: (key: string) => void; onRestored: () => void }) {
  const [value, setValue] = useState("");
  const valid = value.trim().startsWith("sk-ant-");

  return (
    <div className="page page-narrow">
      <h1>Connect your Anthropic API key</h1>
      <p className="intro">
        The agent runs inside this extension and talks to the Anthropic API directly — there is no server in
        between. Your key is stored in <code>chrome.storage.local</code> on this machine and is only sent to
        api.anthropic.com.
      </p>
      <input
        className="pf-input mono"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && valid && onSave(value.trim())}
        placeholder="sk-ant-..."
        autoFocus
      />
      <button className="btn btn-big" style={{ marginTop: 16 }} disabled={!valid} onClick={() => onSave(value.trim())}>
        Save key
      </button>
      <BackupControls compact onRestored={onRestored} />
    </div>
  );
}
