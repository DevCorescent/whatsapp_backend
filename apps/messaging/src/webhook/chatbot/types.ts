// ─────────────────────────────────────────────────────────────────────────────
// Chatbot flow document — the shape persisted into the EXISTING
// ChatbotFlow.nodes / ChatbotFlow.edges JSON columns.
//
// These types are intentionally framework-free (no @xyflow/react, no React) so the
// validation + execution engine can run inside API routes and the WhatsApp pipeline
// as well as in the browser. The structure is a superset-compatible subset of React
// Flow's Node/Edge, so it round-trips through the canvas without transformation.
// ─────────────────────────────────────────────────────────────────────────────

export type NodeKind =
  | "start"
  | "message"
  | "template"
  | "question"
  | "menu"
  | "condition"
  | "api"
  | "delay"
  | "set_variable"
  | "handoff"
  | "ai"
  | "end";

export type TriggerType = "KEYWORD" | "INBOUND" | "FIRST_MESSAGE";

export interface StartNodeData {
  label?: string;
  triggerType?: TriggerType;
}

export interface MessageNodeData {
  label?: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "document" | "audio";
  /** Simulated "typing…" delay in seconds before the message is sent. */
  typingDelay?: number;
}

export type QuestionValidation = "none" | "text" | "number" | "email" | "phone";

export interface QuestionNodeData {
  label?: string;
  question?: string;
  /** Variable the answer is stored under, referenced later as {{variable}}. */
  variable?: string;
  validation?: QuestionValidation;
}

// ─── Menu (IVR) ───────────────────────────────────────────────────────────────

/**
 * One choice in a menu.
 *
 * `id` does three jobs at once, which is why it must be stable: it is the edge
 * handle in the builder, the row id sent to WhatsApp, and what comes back when
 * the customer taps. Renaming a label must never move a branch.
 */
export interface MenuOption {
  id: string;
  label: string;
  /** Sub-line under the label. List rendering only — buttons have no room. */
  description?: string;
  /** Extra words that also select this option when the customer types instead of taps. */
  keywords?: string[];
  /**
   * What choosing this option says about the person choosing it.
   *
   * Same scale as a FAQ question's — see lib/leadSignal.ts — because they are
   * the same event: the customer picked a commercial question off a list.
   * Absent means "none", the right default for an option nobody has classified.
   */
  intent?: "none" | "interest" | "buying";
}

/** How a menu is put on the wire. */
export type MenuRender = "auto" | "buttons" | "list";

/** What happens when the customer keeps replying with something unrecognised. */
export type MenuFallback = "repeat" | "branch" | "handoff";

export interface MenuNodeData {
  label?: string;
  /** The question above the options. */
  prompt?: string;
  /** Small print under the options. WhatsApp shows it greyed. */
  footer?: string;
  options?: MenuOption[];

  /**
   * auto sends buttons at three options or fewer and a list above that, which is
   * exactly where WhatsApp's own limit falls. Forcing one or the other is for
   * when the shape matters more than the count — three options that must look
   * like a list because the next menu is one.
   */
  render?: MenuRender;
  /** Label on the button that opens a list. WhatsApp caps this at 20 characters. */
  listButtonText?: string;
  /** Heading above the rows inside the list sheet. */
  listSectionTitle?: string;

  /** Variable the chosen option's label is stored under, for later {{...}} use. */
  saveAs?: string;

  /** Sent when the reply matches no option. */
  invalidMessage?: string;
  /** How many unrecognised replies to tolerate before taking the fallback. */
  maxAttempts?: number;
  /**
   * repeat  — ask again forever, never giving up on the customer.
   * branch  — leave via the "No match" handle after maxAttempts.
   * handoff — hand to a human after maxAttempts.
   */
  fallback?: MenuFallback;

  /** Offer a row that returns to the previous menu. */
  showBack?: boolean;
  backLabel?: string;
  /** Offer a row that returns to the first menu in the flow. */
  showHome?: boolean;
  homeLabel?: string;
  /** Offer a row that ends the flow and fetches a person. */
  showAgent?: boolean;
  agentLabel?: string;
}

export type ConditionOperator =
  | "eq" | "neq"
  | "contains" | "notContains"
  | "startsWith" | "endsWith"
  | "gt" | "lt"
  | "exists" | "notExists"
  | "regex";

export interface ConditionRoute {
  id: string;
  label?: string;
  variable?: string;
  operator?: ConditionOperator;
  value?: string;
}

export interface ConditionNodeData {
  label?: string;
  /** Ordered branches — each is its own labelled output handle. First match wins;
   *  the implicit "else" output handle (id "else") catches everything else. */
  routes?: ConditionRoute[];
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiHeader {
  key: string;
  value: string;
}

export interface ApiNodeData {
  label?: string;
  method?: ApiMethod;
  url?: string;
  headers?: ApiHeader[];
  body?: string;
  /** Request timeout in seconds. */
  timeout?: number;
  /** Variable the JSON response is stored under. */
  saveAs?: string;
}

export interface DelayNodeData {
  label?: string;
  seconds?: number;
}

export interface TemplateNodeData {
  label?: string;
  /** Must match the approved template name in Meta Business Manager. */
  templateName?: string;
  /** BCP-47 language code, e.g. "en", "hi", "ar". */
  language?: string;
  /** Optional variable for the header component's {{1}} placeholder. */
  headerVar?: string;
  /** Ordered body component variables: index 0 → {{1}}, index 1 → {{2}}, … */
  bodyVars?: string[];
}

export interface SetVariableNodeData {
  label?: string;
  variable?: string;
  /** Literal text or {{otherVar}} reference. */
  value?: string;
}

export interface HandoffNodeData {
  label?: string;
  team?: string;
  queue?: string;
  /** Kept for existing saved flows created before team/queue fields existed. */
  department?: string;
  note?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  urgency?: boolean;
}

export interface AiNodeData {
  label?: string;
  prompt?: string;
  temperature?: number;
  model?: string;
  /** Variable the AI reply is stored under. */
  saveAs?: string;
}

export interface EndNodeData {
  label?: string;
}

export interface NodeDataMap {
  start: StartNodeData;
  message: MessageNodeData;
  template: TemplateNodeData;
  question: QuestionNodeData;
  menu: MenuNodeData;
  condition: ConditionNodeData;
  api: ApiNodeData;
  delay: DelayNodeData;
  set_variable: SetVariableNodeData;
  handoff: HandoffNodeData;
  ai: AiNodeData;
  end: EndNodeData;
}

export type AnyNodeData = NodeDataMap[NodeKind];

export interface FlowNode<K extends NodeKind = NodeKind> {
  id: string;
  type: K;
  position: { x: number; y: number };
  data: NodeDataMap[K];
  selected?: boolean;
  width?: number | null;
  height?: number | null;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  animated?: boolean;
}

export interface FlowDocument {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ─── Static metadata (framework-free) ─────────────────────────────────────────
// Colours are Tailwind class fragments so both the palette and the canvas nodes
// stay inside the existing design system. Icons are mapped on the client side.

export interface NodeKindMeta {
  kind: NodeKind;
  label: string;
  hint: string;
  /** Header/background tint classes reused by palette + node header. */
  accent: string;
  /** Small icon-chip classes. */
  chip: string;
  /** Whether the palette can create this kind (start is auto-created, unique). */
  creatable: boolean;
  /** Handle counts. Start/end constrain flow direction. */
  hasInput: boolean;
  hasOutput: boolean;
}

export const NODE_KINDS: NodeKindMeta[] = [
  { kind: "start", label: "Start Trigger", hint: "Where the flow begins", accent: "bg-slate-900 text-white", chip: "bg-slate-900 text-white", creatable: false, hasInput: false, hasOutput: true },
  { kind: "message", label: "Message", hint: "Send text or media", accent: "bg-emerald-50 text-emerald-700", chip: "bg-emerald-100 text-emerald-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "template", label: "Send Template", hint: "Send a WhatsApp approved template", accent: "bg-cyan-50 text-cyan-700", chip: "bg-cyan-100 text-cyan-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "question", label: "Question", hint: "Ask and store the reply", accent: "bg-sky-50 text-sky-700", chip: "bg-sky-100 text-sky-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "menu", label: "Menu", hint: "Offer tappable options and branch on the choice", accent: "bg-fuchsia-50 text-fuchsia-700", chip: "bg-fuchsia-100 text-fuchsia-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "condition", label: "Condition", hint: "Branch on a variable", accent: "bg-amber-50 text-amber-800", chip: "bg-amber-100 text-amber-800", creatable: true, hasInput: true, hasOutput: true },
  { kind: "api", label: "API Call", hint: "Call an external URL", accent: "bg-violet-50 text-violet-700", chip: "bg-violet-100 text-violet-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "delay", label: "Delay", hint: "Wait before continuing", accent: "bg-orange-50 text-orange-700", chip: "bg-orange-100 text-orange-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "set_variable", label: "Set Variable", hint: "Assign a value to a variable", accent: "bg-teal-50 text-teal-700", chip: "bg-teal-100 text-teal-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "handoff", label: "Handoff", hint: "Assign to a human agent", accent: "bg-rose-50 text-rose-700", chip: "bg-rose-100 text-rose-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "ai", label: "AI Response", hint: "Generate a reply with AI", accent: "bg-indigo-50 text-indigo-700", chip: "bg-indigo-100 text-indigo-700", creatable: true, hasInput: true, hasOutput: true },
  { kind: "end", label: "End", hint: "Terminates the flow", accent: "bg-slate-100 text-slate-600", chip: "bg-slate-200 text-slate-600", creatable: true, hasInput: true, hasOutput: false },
];

export const NODE_META: Record<NodeKind, NodeKindMeta> = Object.fromEntries(
  NODE_KINDS.map((m) => [m.kind, m]),
) as Record<NodeKind, NodeKindMeta>;

/** Default data for a freshly created node of a given kind. */
export function defaultNodeData<K extends NodeKind>(kind: K): NodeDataMap[K] {
  switch (kind) {
    case "message":
      return { text: "", typingDelay: 0 } as NodeDataMap[K];
    case "question":
      return { question: "", variable: "", validation: "none" } as NodeDataMap[K];
    case "menu":
      // Two options rather than none: an empty menu is not a thing anyone wants,
      // and the first edit is always renaming a placeholder rather than working
      // out that options exist at all.
      return {
        prompt: "",
        options: [
          { id: "o1", label: "Option 1" },
          { id: "o2", label: "Option 2" },
        ],
        render: "auto",
        listButtonText: "Choose",
        maxAttempts: 2,
        fallback: "repeat",
        invalidMessage: "Sorry, I did not catch that. Please pick one of the options.",
        showBack: false,
        showHome: false,
        showAgent: false,
      } as NodeDataMap[K];
    case "condition":
      return {
        routes: [{ id: "r1", label: "Route 1", operator: "eq", value: "" }],
      } as NodeDataMap[K];
    case "api":
      return { method: "GET", url: "", headers: [], body: "", timeout: 15, saveAs: "" } as NodeDataMap[K];
    case "delay":
      return { seconds: 3 } as NodeDataMap[K];
    case "template":
      return { templateName: "", language: "en", bodyVars: [], headerVar: "" } as NodeDataMap[K];
    case "set_variable":
      return { variable: "", value: "" } as NodeDataMap[K];
    case "handoff":
      return { team: "", queue: "", note: "" } as NodeDataMap[K];
    case "ai":
      return { prompt: "", temperature: 0.7, model: "", saveAs: "" } as NodeDataMap[K];
    case "start":
      return {} as NodeDataMap[K];
    case "end":
      return {} as NodeDataMap[K];
    default:
      return {} as NodeDataMap[K];
  }
}

/** Best-effort coercion of an unknown JSON payload (from ChatbotFlow.nodes/edges)
 *  into a FlowDocument. Never throws — a malformed flow degrades to empty. */
export function toFlowDocument(nodes: unknown, edges: unknown): FlowDocument {
  const outNodes: FlowNode[] = Array.isArray(nodes)
    ? nodes.flatMap((n) => {
        if (!n || typeof n !== "object") return [];
        const rec = n as Record<string, unknown>;
        if (typeof rec.id !== "string" || typeof rec.type !== "string") return [];
        if (!(rec.type in NODE_META)) return [];
        const pos = rec.position as { x?: unknown; y?: unknown } | undefined;
        return [
          {
            id: rec.id,
            type: rec.type as NodeKind,
            position: {
              x: typeof pos?.x === "number" ? pos.x : 0,
              y: typeof pos?.y === "number" ? pos.y : 0,
            },
            width: typeof rec.width === "number" ? rec.width : undefined,
            height: typeof rec.height === "number" ? rec.height : undefined,
            data: (rec.data && typeof rec.data === "object" ? rec.data : {}) as AnyNodeData,
          },
        ];
      })
    : [];

  const nodeIds = new Set(outNodes.map((n) => n.id));
  const outEdges: FlowEdge[] = Array.isArray(edges)
    ? edges.flatMap((e) => {
        if (!e || typeof e !== "object") return [];
        const rec = e as Record<string, unknown>;
        if (typeof rec.id !== "string" || typeof rec.source !== "string" || typeof rec.target !== "string") {
          return [];
        }
        // Drop dangling edges so the engine/validation never chase missing nodes.
        if (!nodeIds.has(rec.source) || !nodeIds.has(rec.target)) return [];
        return [
          {
            id: rec.id,
            source: rec.source,
            target: rec.target,
            sourceHandle: typeof rec.sourceHandle === "string" ? rec.sourceHandle : null,
            targetHandle: typeof rec.targetHandle === "string" ? rec.targetHandle : null,
            label: typeof rec.label === "string" ? rec.label : undefined,
          },
        ];
      })
    : [];

  return { nodes: outNodes, edges: outEdges };
}
