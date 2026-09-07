/**
 * DigitalUIBuilder — pure renderer for Digital OS screens.
 *
 * Apps declare screens as a title + rows (toggles, cycles, steppers, tiles,
 * headings, info). The builder:
 *   - renders a strict mobile layout: single `\n` separators, no blank lines,
 *     compact checkbox glyphs, optional `(d<n>)` default indicators,
 *   - pages rows so each bubble stays within the native-flow button budget
 *     (`maxButtons`, DOS_MAX_BUTTONS default pending the P0 probe),
 *   - emits the footer buttons (`done`, `back`, `prev`/`next`) plus one control
 *     verb per row (`x` toggle / `c` cycle / `u`/`d` stepper / `o` open tile),
 *     all under the shared `dos:<token>:<verb>` id namespace.
 *
 * Pure: no I/O, no crypto, no session access — fully unit-testable.
 */

export type DosRow =
  | { kind: "toggle"; id: string; label: string; value: boolean; ctlText?: string }
  | { kind: "cycle"; id: string; label: string; options: string[]; index: number; ctlText?: string }
  | { kind: "stepper"; id: string; label: string; value: number; min: number; max: number; default?: number }
  | { kind: "tile"; id: string; label: string; badge?: string }
  | { kind: "heading"; text: string }
  | { kind: "info"; text: string };

export interface DosButton {
  text: string;
  /** Full interaction id: dos:<token>:<verb>. */
  id: string;
}

export interface DosRenderOptions {
  token: string;
  appId: string;
  screen: string;
  title: string;
  rows: DosRow[];
  /** Which page to render (0-based). */
  page: number;
  /** Max native-flow buttons per bubble (incl. footer). */
  maxButtons?: number;
  /** Screen commits via Done (shows the ✅ Done button). */
  showDone?: boolean;
  /** Screen can navigate back to its parent (↩️). */
  showBack?: boolean;
  /** Screen can return directly to the OS drawer (⌂). */
  showHome?: boolean;
}

export interface DosPageRender {
  page: number;
  pageCount: number;
  lines: string[];
  buttons: DosButton[];
  /** Rows actually rendered on this page (handlers index into these). */
  pageRows: DosRow[];
}

/** Hard mobile-layout limit: target visual width, single lines, no double newlines. */
export const DOS_MAX_LINE_CHARS = 38;
export const DEFAULT_MAX_BUTTONS = 4;

/** Control buttons a row contributes (row position is resolved by the pager). */
function rowControlCount(row: DosRow): number {
  switch (row.kind) {
    case "toggle":
    case "cycle":
    case "tile":
      return 1;
    case "stepper":
      return 2;
    default:
      return 0;
  }
}

function rowText(row: DosRow): string | undefined {
  switch (row.kind) {
    case "toggle":
      return `${row.label}[${row.value ? "✓" : " "}]`;
    case "cycle":
      return `${row.label}: ${row.options[row.index] ?? row.options[0] ?? "?"}`;
    case "stepper": {
      const dflt = row.default;
      const marker =
        dflt !== undefined && row.value === dflt ? ` (d${dflt})` : "";
      return `${row.label}: ${row.value}${marker}`;
    }
    case "tile":
      return row.badge ? `${row.label} ${row.badge}` : row.label;
    case "heading":
      return row.text;
    case "info":
      return row.text;
    default:
      return undefined;
  }
}

function rowVerb(row: DosRow, index: number, token: string): DosButton[] {
  const id = (verb: string): string => `dos:${token}:${verb}`;
  switch (row.kind) {
    case "toggle":
      return [{ text: row.ctlText ?? "On/Off", id: id(`x${index}`) }];
    case "cycle": {
      const current = row.options[row.index] ?? row.options[0] ?? "";
      return [{ text: row.ctlText ?? `${current} ▶`, id: id(`c${index}`) }];
    }
    case "stepper":
      return [
        { text: "−", id: id(`d${index}`) },
        { text: "+", id: id(`u${index}`) },
      ];
    case "tile":
      return [{ text: row.label, id: id(`o${index}`) }];
    default:
      return [];
  }
}

/**
 * Chunk rows into pages honoring the button budget per bubble.
 *
 * Uniform per-page accounting keeps every bubble <= maxButtons:
 *   - `done` occupies 1 slot on every page of a committable screen,
 *   - when paging, `prev`/`next` arrows reserve 2 slots (middle pages show
 *     both; first/last show one — uniform reservation guarantees no overflow),
 *   - `back` occupies 1 slot and is only offered on single-page screens
 *     (paged screens navigate home by paging to the end or via app tiles).
 */
function paginate(
  rows: DosRow[],
  maxButtons: number,
  showDone: boolean,
  showBack: boolean,
  showHome: boolean,
): DosRow[][] {
  const controlRows = rows.filter((row) => rowControlCount(row) > 0);
  const controlsTotal = controlRows.reduce(
    (sum, row) => sum + rowControlCount(row),
    0,
  );
  // Back is intentionally omitted from paged config screens: reserving it
  // would make two-button steppers overflow the native-flow cap on the last
  // page. Home is used by result screens, which do not contain controls.
  const footerSlots = (showDone ? 1 : 0) + (showBack && !showDone ? 1 : 0) + (showHome ? 1 : 0);
  const paging = controlsTotal + footerSlots > maxButtons;

  // Rows without controls (headings/info) attach to the current page and are
  // always carried along — they never consume button budget.
  const textRows = rows.filter((row) => rowControlCount(row) === 0);
  let textCursor = 0;
  const takeText = (): DosRow[] => {
    const taken: DosRow[] = [];
    const row = textRows[textCursor];
    if (row) {
      taken.push(row);
      textCursor += 1;
    }
    return taken;
  };

  const pages: DosRow[][] = [];
  const capacity = Math.max(
    1,
    maxButtons - (paging ? 2 : footerSlots),
  );
  let current: DosRow[] = [];
  let currentBudget = 0;
  const flush = (): void => {
    pages.push(current);
    current = [];
    currentBudget = 0;
  };

  for (const row of controlRows) {
    const controls = rowControlCount(row);
    if (current.length && currentBudget + controls > capacity) {
      // Keep the row's own text prefix with it when it opens a new page.
      current.push(...takeText());
      flush();
    }
    current.push(row);
    currentBudget += controls;
  }
  if (current.length || pages.length === 0) {
    while (textCursor < textRows.length) {
      const row = textRows[textCursor];
      if (row) current.push(row);
      textCursor += 1;
    }
    flush();
  }
  return pages;
}

export function renderDosPage(options: DosRenderOptions): DosPageRender {
  const maxButtons = Math.max(2, options.maxButtons ?? DEFAULT_MAX_BUTTONS);
  const showDone = options.showDone ?? false;
  const showBack = options.showBack ?? false;
  const showHome = options.showHome ?? false;
  const pages = paginate(options.rows, maxButtons, showDone, showBack, showHome);
  const pageCount = pages.length;
  const safePage = Math.max(0, Math.min(options.page, pageCount - 1));
  const pageRows = pages[safePage] ?? [];
  const isFirst = safePage === 0;
  const isLast = safePage === pageCount - 1;
  const paging = pageCount > 1;

  const lines: string[] = [];
  lines.push(
    paging
      ? `${options.title} (p${safePage + 1}/${pageCount})`
      : options.title,
  );
  for (const row of pageRows) {
    const text = rowText(row);
    if (text) lines.push(text);
  }

  const buttons: DosButton[] = [];
  for (const [rowIndex, row] of pageRows.entries()) {
    if (rowControlCount(row) === 0) continue;
    buttons.push(...rowVerb(row, rowIndex, options.token));
  }
  if (paging && !isFirst)
    buttons.push({ text: "⏮️ Prev", id: `dos:${options.token}:prev` });
  if (paging && !isLast)
    buttons.push({ text: "Next ⏭️", id: `dos:${options.token}:next` });
  if (showDone && (!paging || isLast))
    buttons.push({ text: "Done ✅", id: `dos:${options.token}:done` });
  if (showBack && !paging)
    buttons.push({ text: "↩️ Back", id: `dos:${options.token}:back` });
  if (showHome && !paging)
    buttons.push({ text: "⌂ Home", id: `dos:${options.token}:home` });

  return { page: safePage, pageCount, lines, buttons, pageRows };
}

/** Compactness audit used by tests: no blank/overlong lines, no double newlines. */
export function auditDosLayout(lines: string[], maxChars = DOS_MAX_LINE_CHARS): string[] {
  const violations: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim().length === 0) violations.push(`line ${index} blank`);
    if (line.length > maxChars) violations.push(`line ${index} ${line.length}>${maxChars}`);
  });
  return violations;
}
