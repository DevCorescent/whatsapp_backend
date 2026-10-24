import type {
  ApiNodeData,
  ConditionNodeData,
  ConditionRoute,
  DelayNodeData,
  FlowDocument,
  FlowNode,
  HandoffNodeData,
  MenuNodeData,
  MessageNodeData,
  QuestionNodeData,
  TemplateNodeData,
  SetVariableNodeData,
} from "./types";
import {
  matchMenuReply,
  menuOptions,
  MENU_ATTEMPTS_VAR,
  MENU_STACK_VAR,
  readMenuAttempts,
  readMenuStack,
  renderMenu,
} from "./menu";

// ─────────────────────────────────────────────────────────────────────────────
// Flow execution engine.
//
// A single traversal step: starting from a node (the flow's Start on the first
// turn, or the node after the last unanswered Question on later turns), walk the
// graph executing Message / Condition / Delay / API / AI / Handoff nodes until it
// reaches a Question (which must wait for the user's reply), an End node, or a dead
// end. Side-effecting nodes (API, AI) are delegated to injected executors so the
// engine stays pure and is reused by both the server pipeline and the client
// preview simulator.
//
// State (current node + collected variables) is returned to the caller to persist
// however it likes — the engine itself holds none, so it works with the existing
// ChatbotFlow model without any schema change.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flow variables. Values stay strings — that is what a customer types and what
 * {{placeholder}} substitution puts back, and widening the map would make every
 * existing render site handle a shape it never receives.
 *
 * The menu engine's own bookkeeping lives under `__`-prefixed keys and is
 * serialised into that same string space (the navigation stack as JSON), so
 * nothing here has to know it exists. See readMenuStack in menu.ts.
 */
export type FlowVariables = Record<string, string>;

/** Reserved output handle a menu leaves by when the customer keeps missing. */
export const MENU_NO_MATCH_HANDLE = "no_match";

export interface EngineExecutors {
  /** Perform an API-call node. Returns the value stored under its `saveAs`. */
  callApi?: (node: ApiNodeData, vars: FlowVariables) => Promise<string>;
  /** Generate an AI reply for an AI node. Returns the reply text. */
  callAi?: (node: AiPrompt, vars: FlowVariables) => Promise<string>;
}

interface AiPrompt {
  prompt?: string;
  model?: string;
  temperature?: number;
  saveAs?: string;
}

export type EngineActionType =
  | "message"
  | "typing"
  | "delay"
  | "api"
  | "ai"
  | "handoff"
  | "template"
  | "menu";

export interface EngineAction {
  type: EngineActionType;
  nodeId: string;
  /** Rendered outbound text for message/ai actions. */
  text?: string;
  /** Seconds for delay/typing actions. */
  seconds?: number;
  /** Handoff details. */
  handoff?: { team?: string; queue?: string; department?: string; note?: string };
  /** API details (for preview/telemetry). */
  api?: { method?: string; url?: string; saveAs?: string };
  /** Template details. */
  template?: { templateName?: string; language?: string; headerVar?: string; bodyVars?: string[] };
  /** The interactive payload and its plain-text fallback, for a menu action. */
  menu?: { interactive: Record<string, unknown>; text: string; mode: "buttons" | "list" };
}

export type EngineStatus = "awaiting_input" | "ended" | "dead_end" | "error";

/** What the customer picked, when this step resolved a menu. */
export interface MenuChoice {
  nodeId: string;
  nodeLabel: string;
  optionId: string;
  label: string;
  intent: "none" | "interest" | "buying";
}

export interface EngineStepResult {
  actions: EngineAction[];
  variables: FlowVariables;
  /**
   * Set when this step began by resolving a menu answer. Surfaced rather than
   * inferred by the caller: only the engine knows which of tap, number, label or
   * keyword matched, and re-deriving it outside would be a second matcher to
   * keep in step with this one.
   */
  menuChoice?: MenuChoice;
  /** Node the run stopped on (the Question awaiting input, or the End/dead-end node). */
  stoppedAtNodeId: string | null;
  /** When awaiting input, the question node whose answer feeds the next step. */
  awaitingQuestionId: string | null;
  status: EngineStatus;
  handoff: boolean;
}

export interface RunOptions {
  /** Node to start from. Defaults to the flow's Start node. */
  fromNodeId?: string;
  /** The user's latest reply — stored under the awaiting question's variable. */
  input?: string;
  /**
   * The id of a tapped button or list row, when the reply was a tap.
   *
   * Kept separate from `input`: the title Meta echoes alongside it is truncated
   * to 24 characters, so on a menu of similarly-worded options the text alone
   * cannot identify what was chosen. The id can.
   */
  replyId?: string | null;
  variables?: FlowVariables;
  executors?: EngineExecutors;
  /** Guard against pathological graphs. */
  maxSteps?: number;
}

/** Substitute {{variable}} tokens in a template using the collected variables. */
export function renderTemplate(template: string | undefined, vars: FlowVariables): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

function findStart(doc: FlowDocument): FlowNode | undefined {
  return doc.nodes.find((n) => n.type === "start");
}

function nodeById(doc: FlowDocument, id: string): FlowNode | undefined {
  return doc.nodes.find((n) => n.id === id);
}

/** Follow the first outgoing edge (optionally from a specific source handle). */
function nextNodeId(doc: FlowDocument, nodeId: string, sourceHandle?: string): string | null {
  const edges = doc.edges.filter(
    (e) => e.source === nodeId && (sourceHandle === undefined || (e.sourceHandle ?? null) === sourceHandle),
  );
  return edges[0]?.target ?? null;
}

function evalRoute(route: ConditionRoute, vars: FlowVariables): boolean {
  const left = (route.variable ? vars[route.variable] : "") ?? "";
  const right = route.value ?? "";
  const lc = left.toLowerCase();
  const rc = right.toLowerCase();
  switch (route.operator) {
    case "eq":         return left === right;
    case "neq":        return left !== right;
    case "contains":   return lc.includes(rc);
    case "notContains": return !lc.includes(rc);
    case "startsWith": return lc.startsWith(rc);
    case "endsWith":   return lc.endsWith(rc);
    case "gt":         return Number(left) > Number(right);
    case "lt":         return Number(left) < Number(right);
    case "exists":     return left.trim().length > 0;
    case "notExists":  return left.trim().length === 0;
    case "regex": {
      try { return new RegExp(right, "i").test(left); } catch { return false; }
    }
    default:           return false;
  }
}

/**
 * Run one traversal step. Async because API/AI nodes may perform real work via the
 * injected executors; with no executors those nodes are recorded as actions and
 * skipped (used by the lightweight preview).
 */
export async function runFlowStep(doc: FlowDocument, opts: RunOptions = {}): Promise<EngineStepResult> {
  const variables: FlowVariables = { ...(opts.variables ?? {}) };
  const actions: EngineAction[] = [];
  const maxSteps = opts.maxSteps ?? 200;

  const start = opts.fromNodeId ? nodeById(doc, opts.fromNodeId) : findStart(doc);
  if (!start) {
    return { actions, variables, stoppedAtNodeId: null, awaitingQuestionId: null, status: "error", handoff: false };
  }

  // If we're resuming after a question, the caller passes fromNodeId = that question
  // and the user's input; store it, then continue from the question's output.
  let currentId: string | null = start.id;
  let menuChoice: MenuChoice | undefined;
  if (opts.fromNodeId && start.type === "menu" && opts.input !== undefined) {
    // A menu resume can go five ways — down a branch, back, home, to a human, or
    // round again — so it is resolved before the walk rather than inside it.
    const resumed = resumeMenu(doc, start, variables, { input: opts.input, replyId: opts.replyId });
    menuChoice = resumed.choice;
    if (resumed.result) return { ...resumed.result, menuChoice };
    currentId = resumed.nextId;
  } else if (opts.fromNodeId && start.type === "question" && opts.input !== undefined) {
    const q = start.data as QuestionNodeData;
    if (q.variable) variables[q.variable] = opts.input;
    currentId = nextNodeId(doc, start.id);
  } else if (start.type === "start") {
    currentId = nextNodeId(doc, start.id);
  }

  let steps = 0;
  const visited = new Set<string>();

  while (currentId && steps < maxSteps) {
    steps += 1;
    const node = nodeById(doc, currentId);
    if (!node) break;

    // Loop guard: if we revisit a node in the same step run, stop.
    if (visited.has(node.id)) break;
    visited.add(node.id);

    switch (node.type) {
      case "message": {
        const d = node.data as MessageNodeData;
        if (d.typingDelay && d.typingDelay > 0) {
          actions.push({ type: "typing", nodeId: node.id, seconds: d.typingDelay });
        }
        actions.push({ type: "message", nodeId: node.id, text: renderTemplate(d.text, variables) });
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "template": {
        const d = node.data as TemplateNodeData;
        actions.push({
          type: "template",
          nodeId: node.id,
          template: {
            templateName: d.templateName,
            language: d.language ?? "en",
            headerVar: d.headerVar ? renderTemplate(d.headerVar, variables) : undefined,
            bodyVars: (d.bodyVars ?? []).map((v) => renderTemplate(v, variables)),
          },
        });
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "set_variable": {
        const d = node.data as SetVariableNodeData;
        if (d.variable) variables[d.variable] = renderTemplate(d.value, variables);
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "delay": {
        const d = node.data as DelayNodeData;
        actions.push({ type: "delay", nodeId: node.id, seconds: d.seconds ?? 0 });
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "condition": {
        const d = node.data as ConditionNodeData;
        const match = (d.routes ?? []).find((r) => evalRoute(r, variables));
        // Route handle id is the route id; fallback handle is "else".
        currentId = nextNodeId(doc, node.id, match ? match.id : "else") ?? nextNodeId(doc, node.id);
        break;
      }
      case "api": {
        const d = node.data as ApiNodeData;
        actions.push({ type: "api", nodeId: node.id, api: { method: d.method, url: renderTemplate(d.url, variables), saveAs: d.saveAs } });
        if (opts.executors?.callApi) {
          try {
            const result = await opts.executors.callApi(d, variables);
            if (d.saveAs) variables[d.saveAs] = result;
          } catch {
            // Non-fatal: continue the flow even if the call fails.
          }
        }
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "ai": {
        const d = node.data as AiPrompt;
        let text = "";
        if (opts.executors?.callAi) {
          try {
            text = await opts.executors.callAi(d, variables);
            if (d.saveAs) variables[d.saveAs] = text;
          } catch {
            text = "";
          }
        }
        actions.push({ type: "ai", nodeId: node.id, text });
        currentId = nextNodeId(doc, node.id);
        break;
      }
      case "handoff": {
        const d = node.data as HandoffNodeData;
        actions.push({ type: "handoff", nodeId: node.id, handoff: { team: d.team, queue: d.queue, department: d.department, note: d.note } });
        return { actions, variables, menuChoice, stoppedAtNodeId: node.id, awaitingQuestionId: null, status: "ended", handoff: true };
      }
      case "question": {
        const d = node.data as QuestionNodeData;
        actions.push({ type: "message", nodeId: node.id, text: renderTemplate(d.question, variables) });
        return { actions, variables, menuChoice, stoppedAtNodeId: node.id, awaitingQuestionId: node.id, status: "awaiting_input", handoff: false };
      }
      case "menu": {
        // Arriving at a menu is a fresh ask: the attempt counter belongs to the
        // last menu, not this one, and carrying it over would fail a customer on
        // their first look at a screen they have never seen.
        variables[MENU_ATTEMPTS_VAR] = "0";
        pushMenuStack(variables, node.id);
        actions.push(menuAction(node, variables));
        return {
          actions,
          variables,
          // A choice made earlier in this same step still belongs on the result:
          // picking "Track my order" and landing on the order menu is one turn.
          menuChoice,
          stoppedAtNodeId: node.id,
          awaitingQuestionId: node.id,
          status: "awaiting_input",
          handoff: false,
        };
      }
      case "end":
        return { actions, variables, menuChoice, stoppedAtNodeId: node.id, awaitingQuestionId: null, status: "ended", handoff: false };
      case "start":
        currentId = nextNodeId(doc, node.id);
        break;
      default:
        currentId = nextNodeId(doc, node.id);
        break;
    }
  }

  return {
    actions,
    variables,
    menuChoice,
    stoppedAtNodeId: currentId,
    awaitingQuestionId: null,
    status: currentId ? "dead_end" : "ended",
    handoff: false,
  };
}

// ─── Menu helpers ─────────────────────────────────────────────────────────────

/** Record that the customer is now standing on this menu, for Back to pop. */
function pushMenuStack(variables: FlowVariables, nodeId: string): void {
  const stack = readMenuStack(variables);
  // Re-showing the same menu — a retry after an unrecognised reply — must not
  // stack it twice, or Back would return to the screen you are already on.
  if (stack[stack.length - 1] === nodeId) return;
  variables[MENU_STACK_VAR] = JSON.stringify([...stack, nodeId].slice(-20));
}

/** Build the outbound action for a menu node, prompt and footer rendered. */
function menuAction(node: FlowNode, variables: FlowVariables): EngineAction {
  const d = node.data as MenuNodeData;
  const stack = readMenuStack(variables);
  const options = menuOptions(d, { hasHistory: stack.length > 1 });

  const rendered = renderMenu({
    nodeId: node.id,
    data: d,
    options,
    prompt: renderTemplate(d.prompt, variables),
    footer: d.footer ? renderTemplate(d.footer, variables) : undefined,
  });

  return {
    type: "menu",
    nodeId: node.id,
    text: rendered.text,
    menu: { interactive: rendered.interactive, text: rendered.text, mode: rendered.mode },
  };
}

/**
 * Resolve a reply to a menu.
 *
 * Returns either the node to continue from, or a finished result when the menu
 * itself answers the reply — re-asking after an unrecognised answer, or handing
 * over to a person.
 */
function resumeMenu(
  doc: FlowDocument,
  node: FlowNode,
  variables: FlowVariables,
  opts: { input?: string; replyId?: string | null },
): { nextId: string | null; result?: EngineStepResult; choice?: MenuChoice } {
  const d = node.data as MenuNodeData;
  const stack = readMenuStack(variables);
  const options = menuOptions(d, { hasHistory: stack.length > 1 });

  const match = matchMenuReply({
    nodeId: node.id,
    options,
    replyId: opts.replyId,
    text: opts.input ?? "",
  });

  if (match.kind === "option" && match.option) {
    variables[MENU_ATTEMPTS_VAR] = "0";
    if (d.saveAs) variables[d.saveAs] = match.option.label;
    // The option id IS the edge handle — see MenuOption. An option wired to
    // nothing falls through to the node's default output rather than dead-ending.
    return {
      nextId: nextNodeId(doc, node.id, match.option.id) ?? nextNodeId(doc, node.id),
      choice: {
        nodeId: node.id,
        nodeLabel: d.label || "Menu",
        optionId: match.option.id,
        label: match.option.label,
        intent: match.option.intent ?? "none",
      },
    };
  }

  if (match.kind === "back") {
    // Pop twice: the top of the stack is this menu, the one below is where Back
    // goes. Re-entering that node pushes it again on the way in.
    const previous = stack[stack.length - 2];
    variables[MENU_STACK_VAR] = JSON.stringify(stack.slice(0, -2));
    variables[MENU_ATTEMPTS_VAR] = "0";
    return { nextId: previous ?? node.id };
  }

  if (match.kind === "home") {
    const firstMenu = stack[0] ?? doc.nodes.find((n) => n.type === "menu")?.id ?? null;
    variables[MENU_STACK_VAR] = "[]";
    variables[MENU_ATTEMPTS_VAR] = "0";
    return { nextId: firstMenu };
  }

  if (match.kind === "agent") {
    return {
      nextId: null,
      result: {
        actions: [{ type: "handoff", nodeId: node.id, handoff: { note: "Customer asked for a person from a menu" } }],
        variables,
        stoppedAtNodeId: node.id,
        awaitingQuestionId: null,
        status: "ended",
        handoff: true,
      },
    };
  }

  // Nothing matched.
  const attempts = readMenuAttempts(variables) + 1;
  variables[MENU_ATTEMPTS_VAR] = String(attempts);
  const limit = Math.max(1, d.maxAttempts ?? 2);
  const fallback = d.fallback ?? "repeat";

  if (attempts > limit && fallback !== "repeat") {
    if (fallback === "handoff") {
      return {
        nextId: null,
        result: {
          actions: [{ type: "handoff", nodeId: node.id, handoff: { note: "Customer could not pick a menu option" } }],
          variables,
          stoppedAtNodeId: node.id,
          awaitingQuestionId: null,
          status: "ended",
          handoff: true,
        },
      };
    }
    // branch — leave via the reserved "No match" handle, if one is wired.
    const out = nextNodeId(doc, node.id, MENU_NO_MATCH_HANDLE);
    if (out) {
      variables[MENU_ATTEMPTS_VAR] = "0";
      return { nextId: out };
    }
  }

  // Ask again, saying what went wrong first. Repeating the menu with no
  // explanation reads as the bot ignoring them.
  const actions: EngineAction[] = [];
  const invalid = renderTemplate(d.invalidMessage, variables).trim();
  if (invalid) actions.push({ type: "message", nodeId: node.id, text: invalid });
  actions.push(menuAction(node, variables));

  return {
    nextId: null,
    result: {
      actions,
      variables,
      stoppedAtNodeId: node.id,
      awaitingQuestionId: node.id,
      status: "awaiting_input",
      handoff: false,
    },
  };
}
