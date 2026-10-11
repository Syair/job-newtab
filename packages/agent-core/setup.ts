import type Anthropic from "@anthropic-ai/sdk";
import { AGENT_CONFIG_VERSION, JOB_SCOUT_SYSTEM_PROMPT } from "./prompt";
import { GET_JOB_SOURCES_SCHEMA } from "./schemas";
import type { KVStore } from "./types";

/** Models offered in Settings. The first is the default. */
export const MODEL_CHOICES = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
] as const;

export type ScoutModel = (typeof MODEL_CHOICES)[number]["id"];

export const DEFAULT_MODEL: ScoutModel = "claude-sonnet-5-5";

/**
 * An agent is pinned to its model, so each model gets its own cached agent.
 * Switching back and forth reuses them instead of provisioning a new one per switch.
 */
export function agentIdKey(model: ScoutModel): string {
  return `agentId-${model.replace(/^claude-/, "")}`;
}

function agentConfigKey(model: ScoutModel): string {
  return `${agentIdKey(model)}-config`;
}

export const STORAGE_KEYS = {
  apiKey: "apiKey",
  environmentId: "environmentId",
  activeSessionId: "activeSessionId",
  uploadedFileIds: "uploadedFileIds",
  /** Visa rules read from this run's postings, by job id, until the agent's list comes back. */
  visaSignals: "visaSignals",
} as const;

const ENVIRONMENT_NAME = "job-newtab-env";
const AGENT_NAME = "job-newtab-scout";

function agentConfig(model: ScoutModel) {
  return {
    name: AGENT_NAME,
    model,
    description: "Finds and ranks fresh job openings for one job seeker.",
    system: JOB_SCOUT_SYSTEM_PROMPT,
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        // `bash` stays off. We are reading job listings, not running code, and
        // scraped content is untrusted input — leaving bash enabled widens the
        // blast radius of a prompt injection from a listing.
        default_config: { enabled: false },
        configs: [
          { name: "read" as const, enabled: true },
          { name: "grep" as const, enabled: true },
          { name: "glob" as const, enabled: true },
          { name: "write" as const, enabled: true },
          // A small fix after writing jobs.json is an edit, not a 20k-token rewrite.
          { name: "edit" as const, enabled: true },
        ],
      },
      {
        type: "custom" as const,
        name: "getJobSources",
        description:
          "Collects today's openings for this job seeker and mounts them into your sandbox: " +
          "candidates.json (pre-filtered career-board listings from Greenhouse, Lever and Ashby) " +
          "and sanitized LinkedIn / Indeed search-result pages loaded in the user's logged-in " +
          "browser. Returns a mountPath and byte count per file, per-company stats, and failures. " +
          "Call it once, first.",
        input_schema: GET_JOB_SOURCES_SCHEMA,
      },
    ],
  };
}

/**
 * Agents and environments are persistent, versioned objects — not per-run
 * parameters. Create them once, cache the IDs, and reuse them; creating one per
 * build silently accumulates orphans and pays creation latency every run.
 */
export async function ensureEnvironment(client: Anthropic, store: KVStore): Promise<string> {
  const cached = await store.get<string>(STORAGE_KEYS.environmentId);
  if (cached) {
    // Verify it still exists — an archived/deleted env fails at session create,
    // which is a much more confusing place to discover it.
    try {
      const env = await client.beta.environments.retrieve(cached);
      if (!env.archived_at) return cached;
    } catch {
      await store.remove(STORAGE_KEYS.environmentId);
    }
  }

  // Environment names are unique per org: adopt an existing one before creating.
  for await (const env of client.beta.environments.list()) {
    if (env.name === ENVIRONMENT_NAME && !env.archived_at) {
      await store.set(STORAGE_KEYS.environmentId, env.id);
      return env.id;
    }
  }

  const env = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    description: "Sandbox for the job-newtab scout.",
    // The sandbox only reads mounted files; it never needs the network.
    config: { type: "cloud", networking: { type: "limited" } },
  });
  await store.set(STORAGE_KEYS.environmentId, env.id);
  return env.id;
}

/**
 * Returns the cached agent for this model, creating it on first use. When the
 * prompt or tools changed since it was cached (AGENT_CONFIG_VERSION bumped), the
 * agent is updated in place — a new immutable version of the same agent.
 */
export async function ensureAgent(
  client: Anthropic,
  store: KVStore,
  model: ScoutModel = DEFAULT_MODEL,
): Promise<string> {
  const key = agentIdKey(model);
  const cached = await store.get<string>(key);
  if (cached) {
    try {
      const agent = await client.beta.agents.retrieve(cached);
      if ((await store.get<number>(agentConfigKey(model))) !== AGENT_CONFIG_VERSION) {
        // `version` guards against a concurrent update clobbering this one.
        await client.beta.agents.update(cached, { ...agentConfig(model), version: agent.version });
        await store.set(agentConfigKey(model), AGENT_CONFIG_VERSION);
      }
      return cached;
    } catch {
      await store.remove(key);
    }
  }

  const agent = await client.beta.agents.create(agentConfig(model));
  await store.set(key, agent.id);
  await store.set(agentConfigKey(model), AGENT_CONFIG_VERSION);
  return agent.id;
}
