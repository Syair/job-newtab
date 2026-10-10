import { useState } from "react";
import { downloadBackup, pickAndRestoreBackup } from "@/lib/backup-io";

/**
 * Download / restore a backup file. `compact` is the one-link form for the
 * API-key screen, where the only useful thing is restoring after a reinstall.
 */
export function BackupControls({ onRestored, compact = false }: { onRestored: () => void; compact?: boolean }) {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const restore = async () => {
    setMessage(null);
    try {
      const result = await pickAndRestoreBackup();
      if (!result) return;
      const when = result.exportedAt ? ` from ${new Date(result.exportedAt).toLocaleDateString("en-US")}` : "";
      setMessage({ text: `Restored${when}: ${result.jobs} jobs and ${result.tracked} tracked applications.` });
      onRestored();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  if (compact) {
    return (
      <p className="pf-hint backup-compact">
        Reinstalling?{" "}
        <button className="link-btn" onClick={restore}>
          Restore from a backup file
        </button>
        {message && <span className={message.error ? "pf-error" : "backup-ok"}> {message.text}</span>}
      </p>
    );
  }

  return (
    <section className="pf-section">
      <h3>Backup</h3>
      <p className="pf-hint">
        Removing the extension deletes its data. A backup file keeps your profile, settings, jobs and tracker so you
        can restore them later or on another computer. Your API key is not included.
      </p>
      <div className="backup-actions">
        <button className="btn btn-quiet" onClick={() => void downloadBackup()}>
          Download backup
        </button>
        <button className="btn btn-quiet" onClick={() => void restore()}>
          Restore from file…
        </button>
      </div>
      {message && <p className={message.error ? "pf-error" : "backup-ok"}>{message.text}</p>}
    </section>
  );
}
