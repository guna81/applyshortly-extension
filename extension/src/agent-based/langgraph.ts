// LangGraph JS (npm @langchain/langgraph, browser entry). In tests Node resolves it from node_modules. A Chrome extension loads
// plain files, so scripts/build_extension.py replaces this file in the package with one bundled copy (scripts/bundle_langgraph.mjs).
// interrupt() is not exported: it needs AsyncLocalStorage, which a browser lacks. The agent ends a run at a question and resumes it.
// @ts-ignore
export { StateGraph, Annotation, START, END } from "@langchain/langgraph/web";
