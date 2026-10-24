// ============================================================================
// MODULE : Menu rendering & reply matching (IVR)
// ============================================================================
//
// A menu node is the IVR primitive: a prompt, a set of options, and one branch
// per option. Two halves live here, both pure so they can be tested without a
// database or a WhatsApp account.
//
//   render  — turn a menu into the interactive payload Meta accepts
//   match   — turn whatever the customer replied with back into an option
//
// The matching half is where an IVR is won or lost. People tap, but they also
// type "2", or "two", or "pricing", or "back", or nothing resembling any of it.
// A menu that only understands taps feels broken to the third of customers whose
// WhatsApp client renders the buttons badly or who are simply used to typing.

import type { MenuNodeData, MenuOption } from "./types";

// Meta's hard caps. Exceeding any of them is a 400 from the send API, so they
// are enforced here rather than discovered in production.
export const WA_BUTTONS_MAX = 3;
export const WA_LIST_ROWS_MAX = 10;
const WA_BUTTON_TITLE_MAX = 20;
const WA_ROW_TITLE_MAX = 24;
const WA_ROW_DESC_MAX = 72;
const WA_BODY_MAX = 1024;
const WA_FOOTER_MAX = 60;
const WA_LIST_BUTTON_MAX = 20;

/** Reserved option ids for the navigation rows a menu can add for itself. */
export const NAV_BACK = "__back";
export const NAV_HOME = "__home";
export const NAV_AGENT = "__agent";

/** Where the flow-navigation stack lives inside the flow's variables. */
export const MENU_STACK_VAR = "__menuStack";
/** How many times running the customer has failed to pick something. */
export const MENU_ATTEMPTS_VAR = "__menuAttempts";

export type MenuMatchKind = "option" | "back" | "home" | "agent" | "none";

export interface MenuMatch {
  kind: MenuMatchKind;
  /** Set when kind is "option". */
  option?: MenuOption;
}

function clamp(text: string, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Strip case, accents-free punctuation and spacing so typed replies compare fairly. */
function normalise(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Words that mean "go back" when typed rather than tapped. */
const BACK_WORDS = new Set(["back", "b", "previous", "prev", "return", "peeche"]);
const HOME_WORDS = new Set(["home", "menu", "main", "main menu", "start", "restart", "0"]);
const AGENT_WORDS = new Set(["agent", "human", "person", "support", "help me", "representative"]);

/** Spelled-out numbers people type instead of digits, up to a list's maximum. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Every option the customer will actually see, in the order shown.
 *
 * Navigation rows are appended rather than declared, so an author adding a
 * fourth real option does not have to remember that "Back" was silently
 * occupying a slot. They are also what makes an IVR navigable at all: a tree you
 * can only descend is a trap, and the way out has to be on every screen rather
 * than remembered as a keyword.
 */
export function menuOptions(
  data: MenuNodeData,
  /** `hasHistory` — the customer has descended past the first menu. */
  opts: { hasHistory: boolean },
): MenuOption[] {
  const options = (data.options ?? []).filter((o) => o.id && o.label?.trim());
  const nav: MenuOption[] = [];

  // Both are offered only once there is somewhere else to go. On the first menu
  // "Back" promises something the flow cannot deliver, and "Main menu" returns
  // the customer to the screen they are already looking at — which reads as the
  // bot ignoring them.
  if (data.showBack && opts.hasHistory) {
    nav.push({ id: NAV_BACK, label: data.backLabel?.trim() || "◀ Back" });
  }
  if (data.showHome && opts.hasHistory) {
    nav.push({ id: NAV_HOME, label: data.homeLabel?.trim() || "🏠 Main menu" });
  }
  if (data.showAgent) {
    nav.push({ id: NAV_AGENT, label: data.agentLabel?.trim() || "💬 Talk to a person" });
  }

  return [...options, ...nav];
}

/** buttons or list, honouring the author's choice but never exceeding Meta's cap. */
export function menuRenderMode(data: MenuNodeData, optionCount: number): "buttons" | "list" {
  if (data.render === "list") return "list";
  // An explicit "buttons" that no longer fits is overridden rather than sent and
  // rejected: the author asked for buttons when there were three options and has
  // since added a fourth, and a working list beats a 400 from Meta.
  if (data.render === "buttons" && optionCount <= WA_BUTTONS_MAX) return "buttons";
  return optionCount <= WA_BUTTONS_MAX ? "buttons" : "list";
}

export interface RenderedMenu {
  interactive: Record<string, unknown>;
  /** The options actually sent, in row order. */
  shown: MenuOption[];
  /** Options cut because the list was over Meta's ten-row limit. */
  dropped: number;
  mode: "buttons" | "list";
  /** A plain-text rendering, for channels or clients that cannot show the widget. */
  text: string;
}

/**
 * Build the interactive payload for a menu.
 *
 * `nodeId` goes into every row id so a reply can be attributed to the menu that
 * asked, not merely to an option that might exist on three different menus.
 */
export function renderMenu(params: {
  nodeId: string;
  data: MenuNodeData;
  options: MenuOption[];
  /** Prompt and footer after {{variable}} substitution. */
  prompt: string;
  footer?: string;
}): RenderedMenu {
  const mode = menuRenderMode(params.data, params.options.length);
  const cap = mode === "buttons" ? WA_BUTTONS_MAX : WA_LIST_ROWS_MAX;
  const shown = params.options.slice(0, cap);
  const body = clamp(params.prompt || "Please choose an option:", WA_BODY_MAX);
  const footer = params.footer?.trim() ? clamp(params.footer, WA_FOOTER_MAX) : undefined;

  const rowId = (optionId: string) => `menu:${params.nodeId}:${optionId}`;

  const interactive =
    mode === "buttons"
      ? {
          type: "button",
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: {
            buttons: shown.map((o) => ({
              type: "reply",
              reply: { id: rowId(o.id), title: clamp(o.label, WA_BUTTON_TITLE_MAX) },
            })),
          },
        }
      : {
          type: "list",
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: {
            button: clamp(params.data.listButtonText || "Choose", WA_LIST_BUTTON_MAX),
            sections: [
              {
                title: clamp(params.data.listSectionTitle || "Options", WA_ROW_TITLE_MAX),
                rows: shown.map((o) => ({
                  id: rowId(o.id),
                  title: clamp(o.label, WA_ROW_TITLE_MAX),
                  ...(o.description ? { description: clamp(o.description, WA_ROW_DESC_MAX) } : {}),
                })),
              },
            ],
          },
        };

  // Numbered, because the fallback exists for people who type — and "reply 2" is
  // only useful advice if the options are numbered where they can see them.
  const text = [body, ...shown.map((o, i) => `${i + 1}. ${o.label}`)].join("\n");

  return { interactive, shown, dropped: params.options.length - shown.length, mode, text };
}

/**
 * Work out which option a reply selected.
 *
 * Tried in order of how certain each signal is:
 *
 *   1. Our own row id — the customer tapped. Unambiguous, and scoped to this
 *      menu, so a stale tap on last week's menu cannot select here.
 *   2. Position — "2", or "two". The single most common typed reply, and the one
 *      a text-only fallback explicitly invites.
 *   3. The label, exactly. Someone copying the option back at us.
 *   4. A keyword the author listed, matched on whole words.
 *
 * Deliberately NOT tried: partial or fuzzy label matching. "Plan" against
 * "Change my plan" and "Plan pricing" picks one at random, and an IVR that
 * silently routes you somewhere you did not choose is worse than one that asks
 * again.
 */
export function matchMenuReply(params: {
  nodeId: string;
  options: MenuOption[];
  /** `interactive.button_reply.id` / `list_reply.id`, when the customer tapped. */
  replyId?: string | null;
  /** The message text, when they typed. */
  text?: string | null;
}): MenuMatch {
  const { nodeId, options } = params;

  // 1. A tap on this menu.
  if (params.replyId) {
    const parts = params.replyId.split(":");
    if (parts.length === 3 && parts[0] === "menu" && parts[1] === nodeId) {
      const hit = options.find((o) => o.id === parts[2]);
      if (hit) return asMatch(hit);
    }
  }

  const raw = (params.text ?? "").trim();
  if (!raw) return { kind: "none" };
  const norm = normalise(raw);
  if (!norm) return { kind: "none" };

  // 2. Position, as a digit or a word.
  const position = Number(norm) || NUMBER_WORDS[norm] || 0;
  if (Number.isInteger(position) && position >= 1 && position <= options.length) {
    return asMatch(options[position - 1]);
  }

  // 3. The label verbatim. Checked before navigation words so an option actually
  //    called "Back to school" is not swallowed by the back command.
  const byLabel = options.find((o) => normalise(o.label) === norm);
  if (byLabel) return asMatch(byLabel);

  // 4. An author-listed keyword, whole-word.
  const words = new Set(norm.split(" "));
  const byKeyword = options.find((o) =>
    (o.keywords ?? []).some((k) => {
      const key = normalise(k);
      return key ? (key.includes(" ") ? norm.includes(key) : words.has(key)) : false;
    }),
  );
  if (byKeyword) return asMatch(byKeyword);

  // Typed navigation, for customers who never look at the rows.
  if (BACK_WORDS.has(norm)) return { kind: "back" };
  if (HOME_WORDS.has(norm)) return { kind: "home" };
  if (AGENT_WORDS.has(norm)) return { kind: "agent" };

  return { kind: "none" };
}

function asMatch(option: MenuOption): MenuMatch {
  if (option.id === NAV_BACK) return { kind: "back" };
  if (option.id === NAV_HOME) return { kind: "home" };
  if (option.id === NAV_AGENT) return { kind: "agent" };
  return { kind: "option", option };
}

/**
 * The menu ids the customer has descended through, for Back to pop.
 *
 * Stored as JSON inside the flow's string-valued variable map, and parsed
 * defensively: this value survives in the database between turns, so a flow
 * saved by an older build — or a variable a customer somehow set themselves —
 * must degrade to "no history" rather than throw mid-conversation.
 */
export function readMenuStack(variables: Record<string, unknown>): string[] {
  const raw = variables[MENU_STACK_VAR];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function readMenuAttempts(variables: Record<string, unknown>): number {
  const raw = Number(variables[MENU_ATTEMPTS_VAR]);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}
