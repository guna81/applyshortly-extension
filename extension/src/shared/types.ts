// Shared TypeScript interfaces and types for ApplyShortly Chrome Extension.

import type {
  ExtensionAccount,
  ExtensionApplication,
  ExtensionEvent,
  ExtensionProfile,
  FieldReport,
} from "../../../extension-bridge/client";

export interface ExtensionEventResult {
  application_id: number;
  status: string;
}

export type {
  ExtensionAccount,
  ExtensionApplication,
  ExtensionEvent,
  ExtensionProfile,
  FieldReport,
};

export type ExtensionEngine = "ai_led" | "rules_led";

export interface ExtensionSettings {
  baseUrl: string;
  token: string;
  aiDrafts: boolean;
  autopilotWindows: boolean;
  extensionEngine: ExtensionEngine;
  agentVision: boolean;
  fillOptional: boolean;
  saveLearnedAnswers: boolean;
  autoApply?: boolean;
  connectionType?: string;
  [key: string]: unknown;
}

export interface LiveSwitches {
  fillOptional: boolean | null;
  aiDrafts: boolean | null;
  autoApply: boolean | null;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementSnapshot {
  ref: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  pressed?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string; selected?: boolean }>;
  bbox?: BoundingBox;
  frameId?: number;
  [key: string]: unknown;
}

export interface ChoiceOption {
  ref: string;
  label: string;
  checked: boolean;
}

export interface ChoiceGroup {
  label: string;
  options: ChoiceOption[];
  required?: boolean;
}

export interface PageDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

export interface Observation {
  url: string;
  title?: string;
  elements: ElementSnapshot[];
  dialog?: PageDialog | null;
  blockers?: string[];
  tabs?: Array<{ id: number; url: string; active: boolean; title?: string }>;
  text?: string;
  truncated?: boolean;
  screenshot?: string; // base64 JPEG
}

export interface Command {
  action:
    | "type"
    | "select"
    | "check"
    | "click"
    | "click_at"
    | "press"
    | "scroll"
    | "wait"
    | "wait_for"
    | "hover"
    | "drag"
    | "switch_tab"
    | "upload"
    | "fill_form"
    | "options"
    | "review"
    | "run_js";
  ref?: string;
  value?: string | number | boolean;
  key?: string;
  point?: { x: number; y: number };
  delta?: { x: number; y: number };
  duration?: number;
  selector?: string;
  target?: string;
  files?: Array<{ name: string; type: string; base64: string }>;
  code?: string;
  [key: string]: unknown;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
  retried?: boolean;
  ref?: string;
  action?: string;
  [key: string]: unknown;
}

export type UIActionButton = "draft" | "skip" | "on_page";

export interface AgentEnvelope {
  message: string;
  actions: UIActionButton[];
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  name?: string;
  result: unknown;
  error?: string;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentState {
  session: string;
  messages: AgentMessage[];
  pending: ToolCall[];
  carry: ToolResult[];
  gs: GuardState;
  asked: string[];
  answered: string[];
  doneRefusals: number;
  nudges: number;
  questions: number;
  tokens: number;
  refusedTurns: number;
  typedLinks: string[];
  pages: Record<string, unknown>;
  saved: Record<string, unknown>;
  filled: Record<string, unknown>;
  verified: Record<string, unknown>;
  instructions: string[];
}

export interface GuardState {
  answers: Record<string, string>;
  submitted: boolean;
  doneAttempts: number;
  [key: string]: unknown;
}

export interface AgentStepPlan {
  actions: Command[];
  question?: string | null;
  questionChoices?: string[];
  questionRef?: string | null;
  questionActions?: UIActionButton[];
  done?: boolean;
  message?: string;
  postingGone?: boolean;
}

export interface RuntimeMessage {
  type: string;
  [key: string]: unknown;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
  code?: string;
}

declare global {
  var JobHuntProfile: any;
  var JobHuntFill: any;
  var JobHuntPanel: any;
  var JobHuntPanelView: any;
  var __jobhuntContentLoaded: boolean | undefined;
}
