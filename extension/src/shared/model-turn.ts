// The body of one platform model call: the turn's messages plus what the planner asked for with it.
// The server owns every tool schema; a planner may only narrow the list by name.

export interface LookOptions {
  images?: string[];
  native_tools?: boolean;
  history?: unknown[];
  results?: unknown[];
  allow_js?: boolean;
  tool_names?: string[];
  [key: string]: unknown;
}

export function modelBody(
  turn: Record<string, unknown>,
  look?: LookOptions,
): Record<string, unknown> {
  if (!look) return turn;
  return {
    ...turn,
    ...(look.images?.length ? { images: look.images.slice(0, 3) } : {}),
    native_tools: look.native_tools === true,
    ...(Array.isArray(look.history) && look.history.length ? { history: look.history } : {}),
    ...(Array.isArray(look.results) && look.results.length ? { results: look.results } : {}),
    ...(look.allow_js === true ? { allow_js: true } : {}),
    ...(Array.isArray(look.tool_names) ? { tool_names: look.tool_names } : {}),
  };
}
