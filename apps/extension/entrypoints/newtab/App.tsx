import { useCallback, useEffect, useState } from "react";
import { DEFAULT_MODEL, type JobProfile, type JobStatus, type ScoutModel, type StoredJob } from "@job-newtab/agent-core";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { BUILD_STEPS } from "@/lib/protocol";
import {
  KEYS,
  extensionStore,
  loadJobs,
  loadLastBuild,
  loadProfile,
  loadSettings,
  loadStatuses,
  saveProfile,
  saveSetting,
  setJobNote,
  setJobStatus,
  type LastBuild,
  type StatusEntry,
} from "@/lib/storage";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { longDate, updatedLabel } from "./components/format";
import { Onboarding } from "./components/Onboarding";
import { SettingsModal } from "./components/SettingsModal";
import { Today } from "./components/Today";
import { Tracker } from "./components/Tracker";
import { useJobBuild } from "./useJobBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<JobProfile | null>(null);
  const [model, setModel] = useState<ScoutModel>(DEFAULT_MODEL);
  const [autoRebuild, setAutoRebuild] = useState(true);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_REBUILD_INTERVAL_HOURS);
  const [jobs, setJobs] = useState<Record<string, StoredJob>>({});
  const [statuses, setStatuses] = useState<Record<string, StatusEntry>>({});
  const [lastBuild, setLastBuild] = useState<LastBuild | undefined>();
  /** A session left mid-flight, offered as "Resume interrupted search". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over the job board. */
  const [viewProgress, setViewProgress] = useState(false);
  /** Today or tracker; kept in the URL hash so a reload stays put. */
  const [view, setView] = useState<"front" | "tracker">(() => (location.hash === "#tracker" ? "tracker" : "front"));
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const reloadJobs = useCallback(async () => {
    const [j, s, b] = await Promise.all([loadJobs(), loadStatuses(), loadLastBuild()]);
    setJobs(j);
    setStatuses(s);
    setLastBuild(b);
  }, []);

  const { state, build, cancel } = useJobBuild(() => void reloadJobs());

  // Once a build finishes, drop back to the board.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  /** Everything from storage: on open, and after a backup is restored. */
  const loadAll = useCallback(async () => {
    const [settings, storedProfile, activeSession] = await Promise.all([
      loadSettings(),
      loadProfile(),
      extensionStore.get<string>(KEYS.activeSessionId),
      reloadJobs(),
    ]);
    setApiKey(settings.apiKey);
    setProfile(storedProfile);
    setModel(settings.model);
    setAutoRebuild(settings.autoRebuild);
    setIntervalHours(settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS);
    setResumable(activeSession ?? null);
  }, [reloadJobs]);

  useEffect(() => {
    loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  // Keep every open tab in sync: a headless build or another tab may write jobs or statuses.
  useEffect(() => {
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area !== "local") return;
      if (KEYS.jobs in changes || KEYS.statuses in changes || KEYS.lastBuild in changes) void reloadJobs();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [reloadJobs]);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
  }, []);

  const forgetKey = useCallback(async () => {
    await saveSetting("apiKey", null);
    setApiKey(null);
    setShowSettings(false);
  }, []);

  const finishOnboarding = useCallback(
    async (next: JobProfile) => {
      await saveProfile(next);
      setProfile(next);
      build();
    },
    [build],
  );

  const saveSettings = useCallback(
    async (next: JobProfile, rebuild: boolean) => {
      await saveProfile(next);
      setProfile(next);
      setShowSettings(false);
      if (rebuild) build();
    },
    [build],
  );

  const changeStatus = useCallback(async (id: string, status: JobStatus | null) => {
    setStatuses(await setJobStatus(id, status));
  }, []);
  const changeNote = useCallback(async (id: string, note: string) => {
    setStatuses(await setJobNote(id, note));
  }, []);

  useEffect(() => {
    const onHash = () => setView(location.hash === "#tracker" ? "tracker" : "front");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const openView = (next: "front" | "tracker") => {
    history.replaceState(null, "", next === "tracker" ? "#tracker" : location.pathname + location.search);
    setView(next);
    window.scrollTo(0, 0);
  };

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: ScoutModel) => {
    setModel(next);
    await saveSetting("model", next);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);
  const changeInterval = useCallback(async (next: number) => {
    setIntervalHours(next);
    await saveSetting("rebuildIntervalHours", next);
  }, []);

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!apiKey) return <ApiKeySetup onSave={saveKey} onRestored={loadAll} />;
  if (!profile) return <Onboarding onDone={finishOnboarding} />;

  // With nothing to show yet, a running build takes over the tab.
  if (state.running && (!lastBuild || viewProgress)) {
    return (
      <BuildProgress state={state} onCancel={cancel} onBack={lastBuild ? () => setViewProgress(false) : undefined} />
    );
  }

  const showError = state.error && dismissedError !== state.error;
  const newCount = (lastBuild?.added ?? []).filter((id) => jobs[id] && !statuses[id]).length;
  const places = [...profile.locations.map((l) => l.split(",")[0]), profile.remoteOk ? "Remote" : "", profile.anywhereInUS ? "Anywhere in the US" : ""]
    .filter(Boolean)
    .join(" · ");
  const sources = [
    profile.companies.length ? `${profile.companies.length} ${profile.companies.length === 1 ? "company" : "companies"}` : "",
    profile.boards.linkedin ? "LinkedIn" : "",
    profile.boards.indeed ? "Indeed" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="paper">
      <header className="mast">
        <div className="mast-side">
          {profile.roles.join(" · ")}
          <br />
          {places}
        </div>
        <div className="mast-title">Openings</div>
        <div className="mast-side mast-right">
          {lastBuild ? (newCount ? `${newCount} new since the last search` : "Nothing new since the last search") : "No search yet"}
          <div className="mast-actions">
            {state.running ? (
              // A build is running in the background (from here, another tab, or the
              // scheduled rebuild). Let the user watch it without losing this page.
              <button className="mast-btn running" onClick={() => setViewProgress(true)}>
                <span className="pulse-dot" /> Searching, step {Math.min(state.stepIndex + 1, BUILD_STEPS.length)} of{" "}
                {BUILD_STEPS.length}
              </button>
            ) : (
              <button className="mast-btn primary" onClick={() => build()}>
                Search now
              </button>
            )}
            <button className="mast-btn" onClick={() => setShowSettings(true)}>
              Settings
            </button>
          </div>
        </div>
      </header>
      <div className="dateline">
        <span>{longDate()}</span>
        <span>
          {sources}
          {lastBuild && ` · updated ${updatedLabel(lastBuild.timestamp)}`}
        </span>
      </div>

      <nav className="views" aria-label="Views">
        <button className={view === "front" ? "view-tab on" : "view-tab"} aria-current={view === "front"} onClick={() => openView("front")}>
          Today
        </button>
        <button className={view === "tracker" ? "view-tab on" : "view-tab"} aria-current={view === "tracker"} onClick={() => openView("tracker")}>
          Tracker <span>{Object.values(statuses).filter((s) => s.status !== "dismissed").length}</span>
        </button>
      </nav>

      {showError && (
        <div className="banner-error" role="alert">
          <span>
            <b>Search failed.</b> {state.error}
          </span>
          <button className="text-btn" onClick={() => build()}>
            Retry
          </button>
          <button className="icon-btn" onClick={() => setDismissedError(state.error)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {view === "tracker" ? (
        <Tracker jobs={jobs} statuses={statuses} onStatus={changeStatus} onNote={changeNote} />
      ) : !lastBuild && !state.running ? (
        <section className="first-run">
          <h2>Your first edition is one search away</h2>
          <p>The first search takes a few minutes. You can close this tab while it runs.</p>
          <div className="first-run-actions">
            <button className="btn btn-big" onClick={() => build()}>
              Find my jobs
            </button>
            {resumable && (
              <button className="btn btn-quiet" onClick={() => build({ resume: true })}>
                Resume interrupted search
              </button>
            )}
          </div>
        </section>
      ) : (
        <Today jobs={jobs} statuses={statuses} lastBuild={lastBuild} onStatus={changeStatus} />
      )}

      {showSettings && (
        <SettingsModal
          profile={profile}
          model={model}
          onChangeModel={changeModel}
          autoRebuild={autoRebuild}
          onToggleAutoRebuild={toggleAutoRebuild}
          intervalHours={intervalHours}
          onChangeInterval={changeInterval}
          onForgetKey={forgetKey}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          onRestored={async () => {
            setShowSettings(false);
            await loadAll();
          }}
        />
      )}
    </div>
  );
}
