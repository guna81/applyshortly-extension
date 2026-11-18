// The body of one platform model call: the turn's messages plus what the planner asked for with it.
// The server owns every tool schema; a planner may only narrow the list by name.

/**
 * @param {Record<string, any>} turn session, request id, messages, token limit
 * @param {Record<string, any> | undefined} look screenshots, native tools and (for the message-history agent) history, results, js and tool names
 */
export function modelBody(turn, look) {
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
