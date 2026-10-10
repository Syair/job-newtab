/**
 * Input schema for the one custom tool. It takes no arguments on purpose: which
 * companies to query and which search pages to open are decided in code from the
 * user's profile, never by the model.
 */

/**
 * Structurally compatible with the SDK's `BetaManagedAgentsCustomToolInputSchema`,
 * which wants a mutable `required` and an open index signature.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

export const GET_JOB_SOURCES_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {},
  required: [],
};

export const DEFAULTS = {
  /** Extra wait after a board page loads, for its lazy-rendered result list. */
  loadDelayMs: 6000,
} as const;
