function modelBody(turn, look) {
  if (!look) return turn;
  return {
    ...turn,
    ...look.images?.length ? { images: look.images.slice(0, 3) } : {},
    native_tools: look.native_tools === true,
    ...Array.isArray(look.history) && look.history.length ? { history: look.history } : {},
    ...Array.isArray(look.results) && look.results.length ? { results: look.results } : {},
    ...look.allow_js === true ? { allow_js: true } : {},
    ...Array.isArray(look.tool_names) ? { tool_names: look.tool_names } : {}
  };
}
export {
  modelBody
};
