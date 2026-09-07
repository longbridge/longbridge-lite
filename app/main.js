// A standalone, read-only Longbridge desktop client. OAuth uses direct HTTP,
// quotes use the documented WebSocket protocol, and no trading API is exposed.

import { View, div, svg } from "gpui-kit";
import { holdContext } from "./context.js";
import {
  CalendarState,
  Button,
  InputState,
  Popover,
  Popup,
  Scrollbar,
  Table,
  TableBody,
  Tabs,
  VirtualListScrollHandle,
  h_flex,
  set_theme,
  v_flex,
  v_virtual_list,
} from "gpui-base";
import { Tab as NativeTab } from "./gpui-omarchy/index.js";
import { fps_monitor } from "gpui-fps";
import { readFile } from "fs/promises";
import { exit, platform } from "process";
import {
  accessToken,
  beginDeviceAuthorization,
  clearTokens,
  loadTokens,
  pollDeviceAuthorization,
} from "./auth.js";
import { TRADE_ORDER_PATH, del, get, post, put } from "./http.js";
import {
  applyQuotes,
  filterRows,
  initialQuotes,
  sortLikeTerminal,
  streamStatusSummary,
  watchlistInstruments,
} from "./market.js";
import { createQuoteStream } from "./quote_stream.js";
import { createTradeStream } from "./trade_stream.js";
import { compactFiveDaySeries, prepareFiveDaySeries } from "./chart.js";
import {
  CHART_MODES,
  chartRequestIdentity,
  mergeLiveChartQuote,
  prepareCandleSeries,
  prepareIntradaySeries,
  windowCandles,
} from "./chart_modes.js";
import { PERIOD, TRADE_SESSION } from "./protocol.js";
import { depthRatio, mergeTrades, normalizeDepth, validDepthLevel } from "./market_detail.js";
import {
  HISTORY_WINDOW_DAYS,
  historyRange,
  mergeOrder,
  normalizeOrders,
  normalizePushedOrder,
} from "./orders.js";
import {
  ORDER_TYPES,
  TIME_IN_FORCE,
  canCancel,
  canReplace,
  cancelOrderBody,
  emptyTicket,
  ANY_TIME,
  RTH_ONLY,
  allowsFractionalShares,
  hasExtendedHours,
  isLimitOrder,
  replaceOrderBody,
  sharesForAmount,
  supportsAmountSizing,
  submitOrderBody,
  ticketSummary,
  validateTicket,
} from "./trade.js";
import { randomUUID } from "crypto";
import {
  addTargetGroup,
  groupRequestId,
  groupsHolding,
  symbolFromInput,
  watchlistGroups,
} from "./watchlist_edit.js";
import {
  accountTotals,
  allocationInUsd,
  normalizeUsdRates,
  portfolioPresentation,
} from "./portfolio.js";
import PriceChartView, {
  PRICE_CHART_LAYOUT,
  compactIntradaySeriesForView,
} from "./price_chart_view.js";
import { loadFpsVisible, saveFpsVisible } from "./fps_preference.js";
import { DEFAULT_CHART_MODE, loadChartMode, saveChartMode } from "./chart_mode_preference.js";
import {
  applyOmarchyRoles,
  omarchyBaseColors,
  omarchyStatusColors,
  omarchyTheme,
} from "./gpui-omarchy/composition.js";
import { applyTerminalStyle, style } from "./style.js";
import {
  changeTone,
  setOmarchyAvatarColors,
  setOmarchyMarketColors,
  statusColors,
} from "./palette.js";
import {
  action,
  allocationChart,
  connectionPill,
  detailGrid,
  emptyPanel,
  kbd,
  errorMessage,
  filterInput,
  intervalTabs,
  valueField,
  HOLDING_ROW_HEIGHT,
  PANE_INSET,
  WATCHLIST_MIN_WIDTH,
  TABLE_HEADER_HEIGHT,
  holdingRow,
  holdingsHeader,
  label,
  deviceCodeBox,
  step,
  menuItem,
  menuTrigger,
  iconAction,
  ORDER_ROW_HEIGHT,
  orderConfirmSummary,
  orderDetail,
  orderRow,
  ordersHeader,
  segmented,
  ticketField,
  ticketGroup,
  ticketHeading,
  tradeSideTone,
  calendarGrid,
  muted,
  numeric,
  panel,
  popoverSurface,
  sessionAvatar,
  portfolioSummary,
  quoteDetail,
  quoteRow,
  orderBookPanel,
  QUOTE_ROW_HEIGHT,
  rule,
  tableToolbar,
  themeButton,
  timeSalesPanel,
  watchlistHeader,
  workspacePanel,
} from "./ui.js";

let themes = null;

async function currentOmarchyColors() {
  if (platform !== "linux") return "";
  try {
    const { current_colors } = await import("omarchy-theme");
    return current_colors();
  } catch (_) {
    return "";
  }
}

/**
 * The desktop's structural tokens: its spacing scale, type scale, rounding and
 * control chrome. Colour is `colors.toml`; this is everything else a theme can
 * say, and Omarchy UI's components read it.
 */
async function currentOmarchyShell() {
  if (platform !== "linux") return "";
  try {
    const { current_shell } = await import("omarchy-theme");
    return current_shell();
  } catch (_) {
    return "";
  }
}

// How many Holdings rows the panel shows before the page scrolls instead of
// the panel growing. Any ceiling would do; this one keeps the summary and the
// allocation chart reachable above it without a scroll.
const HOLDINGS_VIEWPORT_ROWS = 10;
const RESPONSIVE_DETAIL_MIN_WIDTH = 320;
const WORKSPACE_PANEL_GAP = 8;

function responsivePanelWidths(viewportWidth) {
  const available = Math.max(0, Number(viewportWidth) - PANE_INSET * 2);
  const sideBySide =
    available >= WATCHLIST_MIN_WIDTH + RESPONSIVE_DETAIL_MIN_WIDTH + WORKSPACE_PANEL_GAP;
  if (!sideBySide) return { available, sideBySide, watchlist: available, detail: available };
  const content = available - WORKSPACE_PANEL_GAP;
  const detail = Math.max(
    RESPONSIVE_DETAIL_MIN_WIDTH,
    Math.min(content - WATCHLIST_MIN_WIDTH, content * 0.4),
  );
  return { available, sideBySide, watchlist: content - detail, detail };
}

/**
 * How long the steps before the stream exists may take before the window says
 * so. Generous: it covers a token refresh, the watchlist read and the account
 * read, on a slow connection. What it is really for is the case that never
 * finishes at all -- see `armConnectDeadline`.
 */
const CONNECT_DEADLINE_MS = 30_000;

/** How often the chart's live tail may cross the nested-view bridge. */
const CHART_PUBLISH_INTERVAL_MS = 500;

/** Which pane a change is worth repainting. See `syncWorkspacePanels`. */
const PANE_WATCHLIST = 1;
const PANE_QUOTE = 2;
const PANE_CHART = 4;
const PANE_MARKET = 8;
const PANE_DETAIL = PANE_QUOTE | PANE_CHART | PANE_MARKET;
const PANE_BOTH = PANE_WATCHLIST | PANE_DETAIL;

const EMPTY_CANDLES = Object.freeze([]);
const EMPTY_DETAIL_LEVELS = Object.freeze([]);
const EMPTY_DETAIL_TRADES = Object.freeze([]);
const CHART_CACHE_LIMIT = 16;
const CHART_LATEST_END = "latest";
const CANDLE_WINDOW_DAYS = Object.freeze({ "1m": 1, "5m": 5, "15m": 15, "1D": 190 });
const CHART_PERIODS = Object.freeze({
  "1m": PERIOD.ONE_MINUTE,
  "5m": PERIOD.FIVE_MINUTE,
  "15m": PERIOD.FIFTEEN_MINUTE,
  "1D": PERIOD.DAY,
});

function providerDayBucket(value) {
  const seconds = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(seconds) ? Math.floor(seconds / 86_400) : null;
}

function emptyDepthState(symbol = null) {
  return {
    symbol,
    status: symbol ? "loading" : "idle",
    asks: EMPTY_DETAIL_LEVELS,
    bids: EMPTY_DETAIL_LEVELS,
    error: "",
  };
}

function emptyTradesState(symbol = null) {
  return {
    symbol,
    status: symbol ? "loading" : "idle",
    trades: EMPTY_DETAIL_TRADES,
    error: "",
  };
}

/**
 * The height of the window's own title bar, and the room macOS needs on its
 * left for the traffic lights.
 *
 * `src/main.rs` carries the same height: it is what the host centers the
 * traffic lights against when it opens the window, before this script draws
 * anything, so a change here is a change there. The leading inset is this
 * script's alone -- the lights are drawn over the top-left corner of the
 * content, and only a platform that has them needs the room.
 */
const TITLE_BAR_HEIGHT = 44;
// `process.platform` is the host's name for the platform -- Rust's
// `std::env::consts::OS` -- and not Node's, so macOS is "macos" and never
// "darwin". Getting that wrong is silent: the inset falls back to the narrow
// one and the traffic lights are drawn straight over the logo.
const MACOS = platform === "macos";
/**
 * How far in the title bar's leading content starts.
 *
 * The room the host's own window buttons need is the scale's to know -- it is
 * a property of the platform, not of this application -- so it comes from
 * there. What is left here is the ordinary gap for a platform that draws no
 * buttons, and the choice to take whichever is wider: a control sitting a few
 * pixels off the last light reads as a fourth one, so the gap has to stay a
 * gap on the platforms that have them.
 */
function titleBarLeading(tokens) {
  // Whichever is wider. The room the host's own buttons need comes from the
  // scale, because it is the platform's measurement rather than this
  // application's; a platform that draws none still wants the ordinary gap,
  // and a control sitting a few pixels off the last traffic light reads as a
  // fourth one.
  return Math.max(tokens.spacing.sm, style().spacing.windowControlsInset);
}

/** The pages the title bar switches between. */
const PAGES = Object.freeze([
  { key: "watchlist", caption: "Watchlist", shortcut: 1 },
  { key: "portfolio", caption: "Portfolio", shortcut: 2 },
  { key: "orders", caption: "Orders", shortcut: 3 },
]);

/**
 * One duration, one curve, for every transition in the application.
 *
 * @param {import("gpui-kit").Element} element @param {string} property
 */
function motion(element, property) {
  return element.transition(property, { duration: 150, easing: "ease-out" });
}

/**
 * The window is narrow enough to stack the Watchlist over the details rather
 * than beside them, in pixels of drawable width.
 *
 * A resizable group cannot wrap, so this used to be impossible to answer and
 * the panes just shrank. `window.viewport_size()` is legal from `render`,
 * which is where the question is asked.
 */
const NARROW_VIEWPORT = 960;
const COMPACT_WATCHLIST_WIDTH = 440;

/**
 * How tall Today Orders is: its own rows, to a ceiling of five of them.
 *
 * The list is short by nature -- what is working right now -- and most days it
 * is empty. Given a fixed share of the page it spent that share on nothing,
 * and then gave it all back the moment the day's orders arrived, which is a
 * page that jumps. Sized from its rows it is only ever as tall as it has
 * something to say, and the history underneath keeps the rest.
 */
const TODAY_ORDERS_VISIBLE_ROWS = 5;

/** A panel's toolbar, hairline, column heads and its own border. */
const ORDERS_PANEL_CHROME = 69;

/** What the Orders filter narrows on: the instrument, and how an order went. */
const ORDER_FILTER_FIELDS = Object.freeze(["symbol", "name", "statusLabel", "sideLabel"]);

/** How many holdings one page of the Holdings panel shows. */

/**
 * The application keymap.
 *
 * Chords are bound to *actions*, not to handlers: the keymap says which chord
 * means `workspace::reconnect`, `on_action` says what that does, and the
 * session menu dispatches the same name through `window.dispatch_action`
 * without pretending to be a keyboard. Application commands use `ctrl` on
 * Linux and the conventional `cmd` modifier on macOS.
 *
 * @type {readonly import("gpui-kit").KeyBinding[]}
 */
const PRIMARY_MODIFIER = MACOS ? "cmd" : "ctrl";

export const KEY_BINDINGS = Object.freeze([
  {
    keystroke: `${PRIMARY_MODIFIER}-1`,
    action: "workspace::watchlist",
    context: "Workspace",
    caption: "Watchlist",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-2`,
    action: "workspace::portfolio",
    context: "Workspace",
    caption: "Portfolio",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-3`,
    action: "workspace::orders",
    context: "Workspace",
    caption: "Orders",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-k`,
    action: "workspace::show-shortcuts",
    context: "Workspace",
    caption: "Keyboard shortcuts",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-r`,
    action: "workspace::reconnect",
    context: "Workspace",
    caption: "Reconnect",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-t`,
    action: "workspace::toggle-theme",
    context: "Workspace",
    caption: "Switch theme",
  },
  {
    keystroke: `${PRIMARY_MODIFIER}-shift-f`,
    action: "workspace::toggle-fullscreen",
    context: "Workspace",
    caption: "Full screen",
  },
  {
    keystroke: "down",
    action: "collection::next",
    context: "Workspace && !Input",
    caption: "Next row",
    display: "Arrow Down / J",
  },
  { keystroke: "j", action: "collection::next", context: "Workspace && !Input", caption: "" },
  {
    keystroke: "up",
    action: "collection::previous",
    context: "Workspace && !Input",
    caption: "Previous row",
    display: "Arrow Up / K",
  },
  { keystroke: "k", action: "collection::previous", context: "Workspace && !Input", caption: "" },
  {
    keystroke: "home",
    action: "collection::first",
    context: "Workspace && !Input",
    caption: "First row",
    display: "Home / G G",
  },
  { keystroke: "g g", action: "collection::first", context: "Workspace && !Input", caption: "" },
  {
    keystroke: "end",
    action: "collection::last",
    context: "Workspace && !Input",
    caption: "Last row",
    display: "End / Shift+G",
  },
  { keystroke: "shift-g", action: "collection::last", context: "Workspace && !Input", caption: "" },
  {
    keystroke: "enter",
    action: "collection::activate",
    context: "Workspace && !Input",
    caption: "Open row",
    display: "Enter / O",
  },
  { keystroke: "o", action: "collection::activate", context: "Workspace && !Input", caption: "" },
  // Buying and selling get letters of their own rather than a modifier chord:
  // this application is driven from the keyboard, `b` and `s` are free, and a
  // ticket is a dialog with a confirmation in front of it, so a mistyped
  // letter opens a form rather than placing anything.
  {
    keystroke: "b",
    action: "trade::buy",
    context: "Workspace && !Input",
    caption: "Buy selected",
  },
  {
    keystroke: "s",
    action: "trade::sell",
    context: "Workspace && !Input",
    caption: "Sell selected",
  },
  { keystroke: "escape", action: "workspace::dismiss", context: "Workspace", caption: "Dismiss" },
  { keystroke: "tab", action: "shortcut-help::retain-focus", context: "ShortcutHelp", caption: "" },
  {
    keystroke: "shift-tab",
    action: "shortcut-help::retain-focus",
    context: "ShortcutHelp",
    caption: "",
  },
]);

/**
 * How a chord is written for a reader, as opposed to how it is bound.
 *
 * A keystroke such as `"ctrl-shift-f"` is the keymap's declaration, not what a
 * person reads. The display
 * form is one grammar: modifiers in a fixed order, spaces around every `+`, and
 * one name per key rather than whatever the binding happened to abbreviate.
 *
 * Fixed order rather than the order the binding was written in, so
 * `ctrl-shift-f` and a hypothetical `shift-ctrl-f` read the same.
 */
const MODIFIER_ORDER = Object.freeze(["cmd", "ctrl", "shift", "alt"]);
const MODIFIER_NAMES = Object.freeze({ cmd: "Cmd", ctrl: "Ctrl", shift: "Shift", alt: "Alt" });
// One name per key, so nothing in the interface says `Enter` in one place and
// `Return` in another, or `Up` where its neighbour says `Arrow Down`.
const KEY_NAMES = Object.freeze({
  escape: "Escape",
  enter: "Return",
  up: "Arrow Up",
  down: "Arrow Down",
  left: "Arrow Left",
  right: "Arrow Right",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
});

/** @param {string} keystroke A keymap chord, e.g. `"ctrl-shift-f"`. */
export function chordLabel(keystroke) {
  const parts = String(keystroke).split("-");
  const key = parts.pop() ?? "";
  const modifiers = MODIFIER_ORDER.filter((name) => parts.includes(name)).map(
    (name) => MODIFIER_NAMES[name],
  );
  const named =
    KEY_NAMES[key] ??
    (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return [...modifiers, named].join(" + ");
}

/**
 * What each bound action does, in the words the footer rail shows.
 *
 * Keyed by action rather than by chord, because the chord is the keymap's to
 * decide and this is only the caption beside it: rebinding `ctrl-r` changes what
 * the rail draws without touching this table, and adding a caption for an
 * action nothing binds adds nothing to the rail at all.
 */
/** `YYYY-MM-DD` in local time, which is the spelling `CalendarState` uses. */
function calendarDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** @param {string} day @param {number} days */
function shiftDay(day, days) {
  const shifted = new Date(`${day}T00:00:00`);
  shifted.setDate(shifted.getDate() + days);
  return calendarDay(shifted);
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "--";
}

/** @param {unknown} value */
function firstRecord(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return firstRecord(data);
  }
  for (const key of ["list", "accounts"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate[0] ?? null;
  }
  return record;
}

/** @param {unknown} value @returns {LongbridgeHoldingRow[]} */
function normalizeHoldings(value) {
  const root =
    value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
  const data =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? /** @type {Record<string, unknown>} */ (root.data)
      : root;
  const outer = Array.isArray(value)
    ? value
    : ([data.list, data.stock_info, data.stock_positions].find(Array.isArray) ?? []);
  const rows = outer.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = /** @type {Record<string, unknown>} */ (entry);
    return Array.isArray(record.stock_info) ? record.stock_info : [record];
  });
  return rows
    .map((entry) => {
      const holding = /** @type {Record<string, unknown>} */ (entry);
      return {
        symbol: stringValue(holding.symbol),
        name: stringValue(holding.symbol_name ?? holding.name),
        quantity: stringValue(holding.quantity),
        available: stringValue(holding.available_quantity ?? holding.available),
        costPrice: stringValue(holding.cost_price ?? holding.costPrice),
        currency: stringValue(holding.currency),
      };
    })
    .filter((holding) => holding.symbol !== "--");
}

function storedTokens() {
  try {
    return loadTokens();
  } catch (_) {
    return null;
  }
}

export default class LongbridgeApp extends View {
  /** @param {import("gpui-shell").Props | undefined} _props @param {import("gpui-kit").AsyncContext} cx */
  init(_props, cx) {
    holdContext(cx);
    this.dismissStaleDialogs();
    this.followsSystemTheme = false;
    this.omarchyThemeSource = "";
    this.themeSyncPending = false;
    cx.spawn(async (cx) => {
      const themeSource = await readFile("theme.json", "utf8");
      themes = JSON.parse(themeSource);
      const omarchySource = await currentOmarchyColors();
      // The scale first: `omarchyTheme` derives the theme's spacing and radius
      // from it, so a palette applied over the wrong rhythm would have to be
      // applied twice.
      applyTerminalStyle(await currentOmarchyShell());
      applyOmarchyRoles(omarchySource);
      const fallback = themes[window.appearance()];
      const systemTheme = omarchyTheme(omarchySource, fallback.tokens);
      setOmarchyAvatarColors(omarchyBaseColors(omarchySource));
      setOmarchyMarketColors(omarchyStatusColors(omarchySource));
      this.followsSystemTheme = systemTheme !== null;
      this.omarchyThemeSource = systemTheme ? omarchySource : "";
      set_theme(systemTheme ?? fallback);
      this.chartThemeRevision += 1;
      this.syncPriceChartView();
      this.redraw(cx);
    });
    this.instruments = [];
    /** The account's editable watchlist groups, as the list was last read. */
    this.groups = [];
    this.quotes = [];
    this.portfolioQuotes = [];
    this.selectedSymbol = null;
    /** @type {LongbridgePage} */
    this.page = "watchlist";
    this.hasStoredTokens = Boolean(storedTokens());
    this.status = { state: this.hasStoredTokens ? "saved session" : "offline" };
    this.authorization = null;
    this.authorizationGeneration = 0;
    this.account = null;
    this.fxRates = new Map([["USD", 1]]);
    /** @type {LongbridgeHoldingRow[]} */
    this.holdings = [];
    this.initOrdersState();
    this.error = "";
    this.streamError = "";
    this.stream = null;
    this.streamGeneration = 0;
    /**
     * The connected session's context, for work that outlives the view that
     * asked for it. Set by `connect`, and null until one exists.
     *
     * @type {import("gpui-kit").Context | null}
     */
    this.sessionContext = null;
    /** The trade gateway's push channel, which reports this account's orders. */
    this.tradeStream = null;
    this.connectedToken = null;
    this.lastTick = Date.now();
    this.quotePulse = 1;
    // Set when a quote changed the selected instrument's candles, cleared when
    // the coalesced repaint publishes them. See `scheduleRedraw`.
    this.chartDirty = false;
    this.repaint = null;
    /** The pending deferred chart publish, if one is already queued. */
    this.chartPublish = null;
    /** When the chart last crossed the bridge, for the live tail's rate limit. */
    this.chartPublishedAt = 0;
    this.dirtyPanes = 0;
    /** Pushes that have arrived but not yet been merged. See `drainQuotes`. */
    this.pendingQuotes = [];
    // Off unless asked for. The rail names every binding and the row under it
    // reports the window's own measurements -- both are for learning the
    // application and for reading a bug report, and neither is worth four
    // lines of a market terminal once you know them.
    this.statusBarVisible = false;
    this.fpsVisible = loadFpsVisible();
    this.candleCache = new Map();
    this.chartState = { symbol: null, state: "idle" };
    this.chartGeneration = 0;
    this.chartThemeRevision = 0;
    this.initChartModeState();
    this.initDetailMarketState();
    this.initInteractionState();
    this.initKeyboard(cx);
    this.initChartCalendar(cx);
    this.initPriceChartView(cx);
    this.clock = cx.timer.every(1_000, (cx) => {
      this.syncSystemTheme(cx);
      this.lastTick = Date.now();
      this.quotes = sortLikeTerminal(this.quotes, this.lastTick);
      this.redraw(cx);
    });
    if (this.hasStoredTokens) this.resume(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  syncSystemTheme(cx) {
    if (!themes || this.themeSyncPending || platform !== "linux") return;
    this.themeSyncPending = true;
    cx.spawn(async (cx) => {
      try {
        const source = await currentOmarchyColors();
        if (!source || source === this.omarchyThemeSource) return;
        applyTerminalStyle(await currentOmarchyShell());
        applyOmarchyRoles(source);
        const theme = omarchyTheme(source, themes[window.appearance()].tokens);
        if (!theme) return;
        setOmarchyAvatarColors(omarchyBaseColors(source));
        setOmarchyMarketColors(omarchyStatusColors(source));
        this.followsSystemTheme = true;
        this.omarchyThemeSource = source;
        set_theme(theme);
        this.chartThemeRevision += 1;
        this.syncPriceChartView();
        this.redraw(cx);
      } finally {
        this.themeSyncPending = false;
      }
    });
  }

  /**
   * Installs the keymap and the focus target the actions arrive through.
   *
   * An action is dispatched down the window's focus path, so a workspace that
   * nothing inside it has focused hears nothing. The root tracks a handle of
   * its own and takes the keyboard once, which also gives every chord a place
   * to land back on after a popover hands focus over and takes it away again.
   *
   * @param {import("gpui-kit").AsyncContext} cx
   */
  initKeyboard(cx) {
    this.workspaceFocus = cx.focus_handle();
    this.shortcutHelpFocus = cx.focus_handle();
    this.ticketFocus = cx.focus_handle();
    /** The last chord the workspace saw, for the footer's readout. */
    this.lastKeystroke = "";
    this.keyDown = false;
    this.keyHeld = false;
    this.primaryModifierDown = false;
    this.pointerDown = false;
    this.shortcutHelpOpen = false;
    this.diagnosticsOpen = false;
    this.boundKeys = cx.bind_keys([...KEY_BINDINGS]);
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      this.workspaceFocus.focus();
      this.redraw(cx);
    });
  }

  /**
   * The retained month the chart's date picker reads.
   *
   * `CalendarState` is retained state like `InputState`: it is created once
   * here and never in a render. Base's `Calendar` element is deliberately not
   * bound — it would cross into JavaScript once per cell from inside the
   * layout pass — so this answers the grid and `calendarGrid` draws it.
   *
   * @param {import("gpui-kit").AsyncContext} cx
   */
  initChartCalendar(cx) {
    this.chartCalendar = CalendarState.new();
    /** The chart's last day; `null` means "up to today". */
    this.chartEndDate = null;
    this.calendarOpen = false;
    this.chartCalendar.on("change", (date, cx) => {
      const day = typeof date === "string" ? date : null;
      if (!day || day === this.chartEndDate) return;
      this.chartEndDate = day;
      this.loadSelectedChart(cx);
      this.redraw(cx);
    });
  }

  /** Restores the chosen chart interval, and opens its bounded response cache. */
  initChartModeState() {
    // The interval is remembered; the responses are not. An interval is how
    // someone reads a market -- the same choice for every symbol and every
    // session -- so it survives a restart, while the candles behind it are a
    // cache belonging to this running application.
    this.chartMode = loadChartMode();
    this.chartModeMenuOpen = false;
    this.chartCache = new Map();
  }

  /** @returns {keyof typeof CHART_MODES} */
  activeChartMode() {
    return CHART_MODES[this.chartMode] ? this.chartMode : DEFAULT_CHART_MODE;
  }

  chartIdentityEndDate() {
    return this.chartEndDate ?? CHART_LATEST_END;
  }

  currentChartIdentity(symbol = this.selectedSymbol) {
    return symbol
      ? chartRequestIdentity(symbol, this.activeChartMode(), this.chartIdentityEndDate())
      : null;
  }

  cachedChartSeries(symbol = this.selectedSymbol) {
    const identity = this.currentChartIdentity(symbol);
    if (!identity) return EMPTY_CANDLES;
    if (this.chartCache?.has(identity)) {
      const cached = this.chartCache.get(identity);
      // Map insertion order is the LRU order. A completed response and a cache
      // hit both become most-recently used without rebuilding its series.
      this.chartCache.delete(identity);
      this.chartCache.set(identity, cached);
      return cached;
    }
    // Older retained-child fixtures seed the pre-mode cache directly. Keeping
    // this read-only compatibility path lets the state migration land before
    // the retained UI changes, without allowing it to mask a new mode cache.
    return this.activeChartMode() === "5D"
      ? (this.candleCache?.get(symbol) ?? EMPTY_CANDLES)
      : EMPTY_CANDLES;
  }

  hasCachedChartSeries(symbol = this.selectedSymbol) {
    const identity = this.currentChartIdentity(symbol);
    return Boolean(
      identity &&
      (this.chartCache?.has(identity) ||
        (this.activeChartMode() === "5D" && this.candleCache?.has(symbol))),
    );
  }

  cacheChartSeries(identity, candles) {
    if (!this.chartCache) this.chartCache = new Map();
    this.chartCache.delete(identity);
    this.chartCache.set(identity, candles);
    while (this.chartCache.size > CHART_CACHE_LIMIT)
      this.chartCache.delete(this.chartCache.keys().next().value);
  }

  setChartMode(mode, cx) {
    if (!CHART_MODES[mode] || mode === this.activeChartMode()) return;
    this.chartMode = mode;
    // Written after the paint is asked for, not before it: the choice is on
    // screen at the next frame whatever the store does, and a slow flush
    // cannot hold up the chart it selected.
    this.loadSelectedChart(cx);
    this.redraw(cx);
    cx.spawn(async () => saveChartMode(mode));
  }

  /** Invalidates only the currently visible request from the session cache. */
  invalidateCurrentChartCache() {
    const identity = this.currentChartIdentity();
    if (identity) this.chartCache?.delete(identity);
    if (this.activeChartMode() === "5D") this.candleCache?.delete(this.selectedSymbol);
  }

  chartRequestFor(symbol, mode, endDate = this.chartIdentityEndDate()) {
    const selected = CHART_MODES[mode];
    if (!selected) throw new TypeError(`unknown chart mode ${mode}`);
    // An omitted end date is the explicit "current market day" boundary. Any
    // date the user selected, including today, must go through dated history so
    // a command-18 response cannot be cached under a historical identity.
    if (mode === "intraday" && endDate === CHART_LATEST_END) {
      return {
        kind: "intraday",
        params: { symbol, tradeSession: TRADE_SESSION.ALL },
      };
    }
    const requestEnd = endDate === CHART_LATEST_END ? calendarDay(new Date()) : endDate;
    const days = mode === "intraday" ? 0 : mode === "5D" ? 14 : CANDLE_WINDOW_DAYS[mode];
    const startDay = days === 0 ? requestEnd : shiftDay(requestEnd, -days);
    const compact = (day) => day.replaceAll("-", "");
    return {
      kind: "candlesticks",
      params: {
        symbol,
        period: CHART_PERIODS[selected.period],
        startDate: compact(startDay),
        endDate: compact(requestEnd),
        tradeSession: mode === "intraday" ? TRADE_SESSION.ALL : TRADE_SESSION.NORMAL,
      },
    };
  }

  /**
   * Creates the retained chart entity from lifecycle code, never from render.
   *
   * @param {import("gpui-kit").Context} cx
   */
  initPriceChartView(cx) {
    const props = this.nextPriceChartProps();
    this.publishedPriceChartProps = props;
    this.priceChart = cx.new(PriceChartView, props);
  }

  /**
   * What the chart is doing about the instrument now selected.
   *
   * The retained child is told this, and the panel around it reads the same
   * answer -- a plot showing yesterday's symbol while today's is on the way is
   * the one case the two of them must agree about.
   */
  chartActivity() {
    const symbol = this.selectedSymbol ?? "";
    if (this.chartState.symbol === symbol) return this.chartState.state;
    return symbol ? "loading" : "idle";
  }

  /**
   * The plotted series for a symbol's candles, computed once per set of them.
   *
   * Deriving a series is the expensive thing this view does -- a day of
   * intraday candles, normalized, sorted and compacted -- and it was being
   * done on every publish check, twice a second, whether or not anything had
   * changed. QuickJS cuts a job off past its interrupt budget, and this is the
   * job that reached it.
   *
   * The candles are a stable reference: `cachedChartSeries` answers the same
   * array for the same request until a new response replaces it. So they are
   * the cache key, and the answer is the same array too -- which is what makes
   * `syncPriceChartView`'s identity check work at all. Recomputing produced a
   * new array every time, so `previous.chartSeries === next.chartSeries` was
   * never true and every check published.
   *
   * One entry, because one chart is on screen. Coming back to a symbol derives
   * its series again, which is one pass over candles that are already in hand.
   *
   * @param {string} symbol @param {string} mode @param {readonly unknown[]} candles
   */
  chartSeriesFor(symbol, mode, candles) {
    const cached = this.chartSeriesCache;
    if (cached && cached.symbol === symbol && cached.mode === mode && cached.candles === candles) {
      return cached.series;
    }
    const series =
      mode === "intraday"
        ? compactIntradaySeriesForView(prepareIntradaySeries(candles), PRICE_CHART_LAYOUT)
        : mode === "5D"
          ? compactFiveDaySeries(prepareFiveDaySeries(symbol, candles), PRICE_CHART_LAYOUT)
          : prepareCandleSeries(windowCandles(candles));
    this.chartSeriesCache = { symbol, mode, candles, series };
    return series;
  }

  /** The complete immutable input snapshot the child needs to render the chart. */
  chartProps() {
    const symbol = this.selectedSymbol ?? "";
    const mode = this.activeChartMode();
    const candles = symbol ? this.cachedChartSeries(symbol) : EMPTY_CANDLES;
    const state = this.chartActivity();
    const chartSeries = this.chartSeriesFor(symbol, mode, candles);
    const end = this.chartEndDate ?? calendarDay(new Date());
    const description =
      mode === "intraday"
        ? `Trading day ${end}`
        : mode === "5D"
          ? `Five sessions to ${end}`
          : `${mode} bars ending ${end}`;
    return {
      symbol,
      mode,
      description,
      chartSeries,
      state,
      layout: PRICE_CHART_LAYOUT,
      themeRevision: this.chartThemeRevision,
    };
  }

  nextPriceChartProps() {
    return this.chartProps();
  }

  /** Pushes props only when a chart input changed, and only from mutation sites. */
  syncPriceChartView() {
    if (!this.priceChart) return;
    const next = this.nextPriceChartProps();
    const previous = this.publishedPriceChartProps;
    if (
      previous?.symbol === next.symbol &&
      previous?.mode === next.mode &&
      previous?.description === next.description &&
      previous?.chartSeries === next.chartSeries &&
      previous?.state === next.state &&
      previous?.layout === next.layout &&
      previous?.themeRevision === next.themeRevision
    ) {
      return;
    }
    this.publishedPriceChartProps = next;
    this.priceChart.set_props(next);
  }

  /**
   * Merges everything that arrived since the last repaint, in one pass.
   *
   * Order is preserved, so `mergeQuote` refuses an out-of-order push here
   * exactly as it would have one arriving on its own.
   */
  drainQuotes() {
    if (this.pendingQuotes.length === 0) return;
    const arrived = this.pendingQuotes;
    this.pendingQuotes = [];
    const receivedAt = Date.now();
    this.quotes = applyQuotes(this.quotes, arrived, receivedAt);
    this.portfolioQuotes = applyQuotes(this.portfolioQuotes, arrived, receivedAt);
  }

  /**
   * Repaints soon, and at most once however many callers ask in between.
   *
   * A quote is not a reason to repaint on its own. They arrive in bursts --
   * every instrument in a live Hong Kong and A-share watchlist, several times a
   * second each -- and a repaint is two `set_props` and a notify. One of those
   * per quote is more than a market terminal needs and more than a person can
   * read.
   *
   * So a quote sets state and asks for a repaint, and this decides when: the
   * first ask schedules one and the rest of the burst ride on it. A tenth of a
   * second is under what reads as delay and far over the rate the pushes arrive
   * at, which is the point -- the cost stops scaling with how chatty the market
   * is.
   *
   * @param {import("gpui-kit").Context} cx
   */
  scheduleRedraw(cx, panes = PANE_BOTH) {
    this.dirtyPanes |= panes;
    if (this.repaint) return;
    this.repaint = cx.timer.after(100, (cx) => {
      this.repaint = null;
      const pendingPanes = this.dirtyPanes || PANE_BOTH;
      this.dirtyPanes = 0;
      this.drainQuotes();
      // The chart's live tail, at a rate a chart can be read at.
      //
      // `mergeLiveQuote` answers with a new series for every push, so the
      // identity guard in `syncPriceChartView` never holds on this path and
      // every tick would hand the whole window across the nested-view bridge.
      // Crossing it is not the cost -- journalling is: the shell snapshots
      // every object reachable from the child before running its `update`, and
      // what is reachable from this one is five sessions of candles. Twice a
      // second is well under what reads as live on a five-day chart.
      if (this.chartDirty && Date.now() - this.chartPublishedAt >= CHART_PUBLISH_INTERVAL_MS) {
        this.chartDirty = false;
        this.chartPublishedAt = Date.now();
        this.syncPriceChartView();
      }
      this.redraw(cx, pendingPanes);
    });
  }

  /** One repaint funnel for the plain Panel workspace. */
  redraw(cx, _panes = PANE_BOTH) {
    cx.notify();
  }

  releasePriceChartView() {
    if (!this.priceChart) return;
    this.priceChart.release();
    this.priceChart = null;
    this.publishedPriceChartProps = null;
    /** @type {{ symbol: string, mode: string, candles: unknown, series: unknown } | null} */
    this.chartSeriesCache = null;
  }

  /** Initializes data which belongs only to the selected instrument's detail panels. */
  initDetailMarketState() {
    this.depthCache = new Map();
    this.depthState = emptyDepthState();
    this.tradesState = emptyTradesState();
    this.detailMarketGeneration = 0;
  }

  /** Invalidates all in-flight detail work and clears both panel states. */
  clearDetailMarket() {
    this.detailMarketGeneration += 1;
    this.depthState = emptyDepthState();
    this.tradesState = emptyTradesState();
  }

  /**
   * Changes the selected detail instrument without touching the chart's retained props.
   *
   * @param {string | null} symbol
   * @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx
   */
  selectDetailMarket(symbol, cx) {
    const selected = typeof symbol === "string" && symbol ? symbol : null;
    const generation = ++this.detailMarketGeneration;
    this.selectedSymbol = selected;
    const cachedDepth = selected ? this.depthCache?.get(selected) : null;
    this.depthState = cachedDepth ?? emptyDepthState(selected);
    this.tradesState = emptyTradesState(selected);
    this.redraw(cx, PANE_DETAIL);

    const stream = this.stream;
    if (!stream || typeof stream.selectDetailSymbol !== "function") return Promise.resolve();
    try {
      return Promise.resolve(stream.selectDetailSymbol(selected, generation)).catch((error) =>
        this.receiveDetailError({ symbol: selected, generation, error }, cx),
      );
    } catch (error) {
      this.receiveDetailError({ symbol: selected, generation, error }, cx);
      return Promise.resolve();
    }
  }

  /**
   * @param {unknown} detail
   * @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx
   */
  receiveDetailError(detail, cx) {
    if (
      !detail ||
      typeof detail !== "object" ||
      detail.symbol !== this.selectedSymbol ||
      detail.generation !== this.detailMarketGeneration
    ) {
      return;
    }
    const message =
      detail.error instanceof Error ? detail.error.message : String(detail.error ?? "");
    this.depthState = { ...this.depthState, status: "error", error: message };
    this.tradesState = { ...this.tradesState, status: "error", error: message };
    this.scheduleRedraw(cx, PANE_MARKET);
  }

  /**
   * @param {unknown} depth
   * @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx
   * @param {number} generation
   */
  receiveDepth(depth, cx, generation) {
    if (
      !depth ||
      typeof depth !== "object" ||
      generation !== this.detailMarketGeneration ||
      depth.symbol !== this.selectedSymbol ||
      this.depthState.symbol !== this.selectedSymbol
    ) {
      return;
    }
    const normalized = normalizeDepth(depth);
    const hasDepth = [...normalized.asks, ...normalized.bids].some(validDepthLevel);
    this.depthCache ??= new Map();
    if (hasDepth) {
      this.depthState = Object.freeze({
        symbol: normalized.symbol,
        status: "ready",
        asks: normalized.asks,
        bids: normalized.bids,
        error: "",
      });
      this.depthCache.set(normalized.symbol, this.depthState);
    } else {
      this.depthState = this.depthCache.get(normalized.symbol) ?? {
        symbol: normalized.symbol,
        status: "ready",
        asks: normalized.asks,
        bids: normalized.bids,
        error: "",
      };
    }
    this.scheduleRedraw(cx, PANE_MARKET);
  }

  /**
   * @param {unknown} payload
   * @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx
   * @param {number} generation
   */
  receiveTrades(payload, cx, generation) {
    if (
      !payload ||
      typeof payload !== "object" ||
      generation !== this.detailMarketGeneration ||
      payload.symbol !== this.selectedSymbol ||
      this.tradesState.symbol !== this.selectedSymbol
    ) {
      return;
    }
    const trades = Array.isArray(payload.trades) ? payload.trades : EMPTY_DETAIL_TRADES;
    this.tradesState = {
      symbol: this.selectedSymbol,
      status: "ready",
      trades: mergeTrades(this.tradesState.trades, trades),
      error: "",
    };
    this.scheduleRedraw(cx, PANE_MARKET);
  }

  /**
   * The state a render reaches for unconditionally: both controlled popovers,
   * and the retained text state behind the two list filters.
   *
   * Its own method because a view that skipped it draws nothing at all --
   * `Input.new(undefined)` throws and takes the whole tree with it -- and a
   * probe that replaces `init` wholesale would otherwise do exactly that.
   *
   * `InputState.new()` needs a live host call, so this belongs in an `init` or
   * an event handler, never in a render. The query is mirrored onto the view
   * because render reads it every frame and reading it off the handle would
   * put a host call on the frame path. The popovers are controlled: the shell
   * reports every open and close through `on_open_change`, and these two
   * fields are where the answer lives.
   */
  initInteractionState() {
    this.selectedWatchlistSymbol = null;
    this.selectedHoldingSymbol = null;
    this.selectedOrderRowId = null;
    this.activeOrdersList = "today";
    this.collectionScrollHandles = {
      watchlist: VirtualListScrollHandle.new(),
      holdings: VirtualListScrollHandle.new(),
      "today-orders": VirtualListScrollHandle.new(),
      "history-orders": VirtualListScrollHandle.new(),
    };
    this.userMenuOpen = false;
    this.allocationHelpOpen = false;
    /** Which allocation wedge the pointer is over, by symbol. */
    this.hoveredAllocation = null;
    this.todayOrdersQuery = "";
    this.historyOrdersQuery = "";
    this.symbolQuery = "";
    /** The add-a-security surface, and the row menu, are the view's own. */
    this.addSymbolOpen = false;
    this.addSymbolPending = false;
    this.addSymbolError = "";
    /** @type {{ status: "idle" | "loading" | "ready" | "error", symbol: string, name: string, exchange: string, currency: string, last: string, change: string, changePercent: string, error: string }} */
    this.symbolPreview = { status: "idle", symbol: "", error: "" };
    this.symbolPreviewGeneration = 0;
    // A row menu is opened from three lists now, and what it may offer differs
    // by list: an order can be modified and withdrawn, a holding can be traded
    // but not removed from a watchlist it may not even be on.
    /** @type {{ symbol: string, x: number, y: number, source: "watchlist" | "holdings" | "orders", orderId?: string } | null} */
    this.rowMenu = null;
    /**
     * The row a secondary press just landed on, between the list reporting it
     * and the pane under the list placing the menu. See `noteRowPress`.
     *
     * @type {{ source: "watchlist" | "holdings" | "orders", key: string } | null}
     */
    this.pressedRow = null;
    /**
     * The order ticket.
     *
     * `stage` is what makes the confirmation a confirmation: the form's values
     * are frozen into `review` when Review is pressed, and Confirm sends those
     * rather than re-reading the fields. Otherwise what is confirmed is
     * whatever the boxes hold at the moment of the second click, which is not
     * what the reader read.
     *
     * @type {{
     *   open: boolean,
     *   stage: "form" | "review",
     *   mode: "submit" | "replace" | "cancel",
     *   side: string,
     *   symbol: string,
     *   name: string,
     *   currency: string,
     *   orderId: string,
     *   type: string,
     *   timeInForce: string,
     *   outsideRth: boolean,
     *   errors: { price?: string, quantity?: string, form?: string },
     *   review: ReturnType<typeof validateTicket>["normalized"],
     *   pending: boolean,
     *   error: string,
     * }}
     */
    this.ticket = this.blankTicket();
    /**
     * Board lots, by symbol, as the quote socket answered them.
     *
     * A lot is a property of the instrument and does not change while the
     * window is open, so it is asked once and kept. A symbol that could not
     * be looked up records nothing, which is why the ticket reads a missing
     * entry as "not known" rather than as 1 -- a lot invented here would
     * refuse quantities the exchange would have taken.
     *
     * @type {Map<string, number>}
     */
    this.lotSizes = new Map();
    /** Which stock-detail sections are expanded. */
    this.detailSections = { more: false };
    this.watchlistQuery = "";
    this.holdingsQuery = "";
    this.watchlistFilter = InputState.new({ placeholder: "Filter watchlist" });
    this.watchlistFilter.on("change", (_event, cx) => {
      this.watchlistQuery = this.watchlistFilter.value();
      this.redraw(cx);
    });
    this.holdingsFilter = InputState.new({ placeholder: "Filter holdings" });
    this.holdingsFilter.on("change", (_event, cx) => {
      this.holdingsQuery = this.holdingsFilter.value();
      this.redraw(cx);
    });
    // A filter each, rather than one serving both. The two lists answer
    // different questions -- what is working now, and what an account has done
    // -- and a shared box made narrowing the long one hide the short one at
    // the same time. It is also one `InputState` per `Input`: a single state
    // drawn in two panels is one control rendered twice.
    this.todayOrdersFilter = InputState.new({ placeholder: "Filter orders" });
    this.todayOrdersFilter.on("change", (_event, cx) => {
      this.todayOrdersQuery = this.todayOrdersFilter.value();
      this.redraw(cx);
    });
    this.historyOrdersFilter = InputState.new({ placeholder: "Filter orders" });
    this.historyOrdersFilter.on("change", (_event, cx) => {
      this.historyOrdersQuery = this.historyOrdersFilter.value();
      this.redraw(cx);
    });
    // The ticket's two fields. `set_step` and `set_min` are what turn an
    // ordinary text state into a number state -- there is no numeric state
    // type -- and the minimum is what stops the steppers walking a quantity
    // below zero. Neither may be created in `render`.
    this.ticketPrice = InputState.new({ placeholder: "0.00" });
    this.ticketPrice.set_step(0.01);
    this.ticketPrice.set_min(0);
    this.ticketPrice.on("change", (_event, _cx) => this.clearTicketFieldError("price"));
    // Enter in any of the ticket's fields advances it. A form whose only way
    // forward is the pointer is a form that cannot be filled in from the
    // keyboard, and this one is reached by a keystroke to begin with.
    this.ticketPrice.on("submit", (_event, cx) => this.advanceTicket(cx));
    this.ticketQuantity = InputState.new({ placeholder: "0" });
    this.ticketQuantity.set_step(1);
    this.ticketQuantity.set_min(0);
    this.ticketQuantity.on("change", (_event, _cx) => this.clearTicketFieldError("quantity"));
    this.ticketQuantity.on("submit", (_event, cx) => this.advanceTicket(cx));
    // Sizing by amount is a second field rather than a reinterpretation of the
    // first: the two carry different numbers, and switching between them must
    // not silently turn 1500 dollars into 1500 shares.
    this.ticketAmount = InputState.new({ placeholder: "0.00" });
    this.ticketAmount.set_step(100);
    this.ticketAmount.set_min(0);
    this.ticketAmount.on("change", (_event, _cx) => this.clearTicketFieldError("amount"));
    this.ticketAmount.on("submit", (_event, cx) => this.advanceTicket(cx));
    // The one text state that is not a filter: what a filter narrows is
    // already here, and this names something that is not yet.
    this.symbolInput = InputState.new({ placeholder: "AAPL.US" });
    this.symbolInput.on("change", (_event, cx) => {
      this.symbolQuery = this.symbolInput.value();
      if (this.addSymbolError) {
        this.addSymbolError = "";
        this.refreshDialog();
      }
      // The field draws its own value from its retained state, so what needs a
      // redraw is what is said about the value, not the value.
      this.previewSymbol(cx);
    });
  }

  /**
   * Bounds how long the connect sequence may sit in a transient state.
   *
   * `connect` cannot rely on its own `catch`. The sandbox interrupts a script
   * that overruns its execution budget, and that interrupt is not catchable --
   * it unwinds past every `catch` on the way out, `resume`'s included. A
   * sequence cut down that way leaves `status` at whatever step it had reached
   * and nothing else in this view can tell: the header says "Loading
   * watchlist" and goes on saying it for as long as the window is open, which
   * is what a stalled start looks like from the outside.
   *
   * `quote_stream.js` bounds its own handshake for exactly this reason. This is
   * the same guard one layer out, over the steps before the stream exists.
   *
   * @param {import("gpui-kit").Context} cx
   * @param {number} generation
   */
  armConnectDeadline(cx, generation) {
    this.clearConnectDeadline();
    this.connectDeadline = cx.timer.after(CONNECT_DEADLINE_MS, (cx) => {
      this.connectDeadline = null;
      // A later attempt owns the state now, and a stream that reached
      // `connected` needs no rescue.
      if (generation !== this.streamGeneration) return;
      if (this.status.state === "connected") return;
      // Named from the step it was on, because "it stopped at Loading
      // watchlist" and "it stopped at Loading snapshot" send you to different
      // places.
      const stalled = streamStatusSummary(this.status);
      this.status = { state: "error" };
      this.error =
        `Connecting stopped at "${stalled}" after ` +
        `${Math.round(CONNECT_DEADLINE_MS / 1000)}s. Retry, or sign in again.`;
      this.redraw(cx);
    });
  }

  clearConnectDeadline() {
    this.connectDeadline = null;
  }

  /** @param {import("gpui-kit").Context} cx */
  resume(cx) {
    this.status = { state: "restoring_token" };
    this.error = "";
    this.streamError = "";
    // Orders are read rather than streamed, so a reconnect has to ask for them
    // again -- but only where they are on screen, since the page asks for them
    // itself on the way in.
    if (this.page === "orders") this.loadOrders(cx);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.connect(await accessToken(), cx);
      } catch (error) {
        this.clearConnectDeadline();
        this.status = { state: "error" };
        this.error = error instanceof Error ? error.message : String(error);
        this.redraw(cx);
      }
    });
  }

  /** @param {import("gpui-kit").Context} cx */
  signIn(cx) {
    if (this.authorization) return;
    const generation = (this.authorizationGeneration ?? 0) + 1;
    this.authorizationGeneration = generation;
    this.status = { state: "authorizing" };
    this.error = "";
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        const authorization = await beginDeviceAuthorization();
        if (generation !== this.authorizationGeneration) return;
        this.authorization = authorization;
        // The page opens here rather than waiting to be clicked. The address is
        // only known once the device code exists, which is what a second click
        // would have been waiting for — and it is not an address anyone reads,
        // it is one they approve on.
        try {
          cx.open_url(authorization.verificationUri);
        } catch (error) {
          // The browser is a convenience: "Copy link" is still on the card, and
          // an authorization that cannot be opened here is not one that failed.
          // It is said out loud, though. A bare catch here swallowed a missing
          // import once, and the symptom was a browser that simply never
          // opened, with nothing anywhere to say why.
          console.warn(`could not open the authorization page: ${error}`);
        }
        this.redraw(cx);
        const tokens = await pollDeviceAuthorization(authorization, {
          shouldCancel: () => generation !== this.authorizationGeneration,
        });
        if (generation !== this.authorizationGeneration) return;
        this.hasStoredTokens = true;
        this.authorization = null;
        await this.connect(tokens.accessToken, cx);
      } catch (error) {
        if (generation !== this.authorizationGeneration) return;
        this.authorization = null;
        this.status = { state: "error" };
        this.error = error instanceof Error ? error.message : String(error);
        this.redraw(cx);
      }
    });
  }

  /** @param {string} token @param {import("gpui-kit").AsyncContext} cx */
  async connect(token, cx) {
    this.connectedToken = token;
    // The session's own context, kept because some work outlives the view that
    // asks for it. A dialog is its own view: a task spawned from an order
    // ticket dies with the ticket, so anything the ticket starts and does not
    // finish before closing has to be owned by something that is still there.
    // This is the same context every quote push already notifies through, held
    // across every await since the session connected.
    this.sessionContext = cx;
    const generation = ++this.streamGeneration;
    // Stopping the old stream rejects its pending candlestick query. Make that
    // request stale before awaiting stop, so its catch cannot publish into the
    // reconnecting chart while the replacement watchlist is still loading.
    this.chartGeneration += 1;
    this.clearDetailMarket();
    const previous = this.stream;
    this.stream = null;
    this.stopTradeStream();
    if (previous) await previous.stop();
    if (generation !== this.streamGeneration) return;
    this.status = { state: "loading_watchlist" };
    this.armConnectDeadline(cx, generation);
    this.redraw(cx);

    const watchlist = await get("/v1/watchlist/groups");
    const instruments = watchlistInstruments(watchlist);
    if (generation !== this.streamGeneration) return;
    this.groups = watchlistGroups(watchlist);
    this.instruments = instruments;
    this.quotes = sortLikeTerminal(initialQuotes(instruments), Date.now());
    this.selectedSymbol = instruments[0]?.symbol ?? null;
    if (!this.priceChart) this.initPriceChartView(cx);
    this.syncPriceChartView();
    // The primary workspace is usable as soon as Watchlist has loaded. Asset
    // reads are a separate, slower boundary and must not leave navigation in a
    // misleading global Connecting state.
    this.status = { state: "connected" };
    this.clearConnectDeadline();
    this.redraw(cx);
    // Before the portfolio read, and before the quote stream, because it is
    // not conditional on either: an account with an empty watchlist still has
    // orders, and the early return below would skip it.
    this.startTradeStream(token, generation, cx);
    await this.refreshPortfolio();
    if (generation !== this.streamGeneration) return;
    const symbols = [
      ...new Set([
        ...instruments.map((instrument) => instrument.symbol),
        ...this.holdings.map((holding) => holding.symbol),
      ]),
    ];
    if (symbols.length === 0) {
      this.status = { state: "connected" };
      this.redraw(cx);
      this.loadPortfolio(cx);
      return;
    }

    let stream;
    // The stream outlives this call, and so must the context its callbacks
    // notify through: `cx` here is the task's `AsyncContext`, which is the
    // flavour that may be held across an await.
    stream = createQuoteStream({
      accessToken: token,
      symbols,
      onQuote: (quote) => {
        if (generation === this.streamGeneration && this.stream === stream)
          this.receiveQuote(quote, cx);
      },
      onDepth: (depth, detailGeneration) => {
        if (generation === this.streamGeneration && this.stream === stream)
          this.receiveDepth(depth, cx, detailGeneration);
      },
      onTrades: (trades, detailGeneration) => {
        if (generation === this.streamGeneration && this.stream === stream)
          this.receiveTrades(trades, cx, detailGeneration);
      },
      onDetailError: (detail) => {
        if (generation === this.streamGeneration && this.stream === stream)
          this.receiveDetailError(detail, cx);
      },
      onStatus: (status) => {
        if (generation === this.streamGeneration && this.stream === stream)
          this.receiveStatus(status, cx);
      },
    });
    this.stream = stream;
    this.selectDetailMarket(this.selectedSymbol, cx);
    await stream.start();
    if (generation !== this.streamGeneration) {
      await stream.stop();
      return;
    }
    this.loadSelectedChart(cx);
  }

  /** @param {unknown} quote @param {import("gpui-kit").AsyncContext} cx */
  receiveQuote(quote, cx) {
    let selected = false;
    // Deliberately no re-sort here. `sortLikeTerminal` ranks a row from trade
    // session counts taken across the whole list, so running it per quote made
    // the connect burst -- the whole watchlist twice over, snapshot plus
    // isFirstPush, in one synchronous run -- cost seconds and overrun the
    // sandbox's task budget, which unwound the stream before it could reach
    // `connected`. The one-second clock already re-sorts.
    // Buffered, not applied. A connection opens with every instrument twice
    // over -- the snapshot and then the first push -- in one synchronous run,
    // and publishing a new list per quote copies the whole watchlist each time.
    // That burst is what overruns the sandbox's budget, and the interrupt is
    // not catchable, so it takes the rest of the run with it. Held here and
    // merged in one pass by the repaint that was already being coalesced.
    this.pendingQuotes.push(quote);
    if (quote && typeof quote === "object" && quote.symbol === this.selectedSymbol) {
      const identity = this.currentChartIdentity();
      const candles = this.cachedChartSeries();
      if (this.hasCachedChartSeries() && candles) {
        const activeQuote = this.quoteForActiveChart(candles, quote);
        const merged = activeQuote
          ? mergeLiveChartQuote(this.selectedSymbol, this.activeChartMode(), candles, activeQuote)
          : candles;
        if (merged !== candles) {
          if (identity) this.cacheChartSeries(identity, merged);
          // Not published here. A live merge answers with a new series for
          // every push, so each quote must wait for the coalesced redraw rather
          // than crossing the retained-view bridge with a full history window.
          this.chartDirty = true;
        }
      }
      this.quotePulse = 0.72;
      cx.timer.after(160, (cx) => {
        this.quotePulse = 1;
        this.scheduleRedraw(cx, PANE_DETAIL);
      });
      selected = true;
    }
    this.scheduleRedraw(cx, selected ? PANE_BOTH : PANE_WATCHLIST);
  }

  /** @param {import("gpui-kit").Context} cx */
  loadSelectedChart(cx) {
    const symbol = this.selectedSymbol;
    const stream = this.stream;
    if (!symbol) {
      this.chartState = { symbol: null, state: "idle" };
      this.publishChart(cx);
      return;
    }
    const mode = this.activeChartMode();
    const identity = this.currentChartIdentity(symbol);
    const cached = this.hasCachedChartSeries(symbol);
    if (cached) this.cachedChartSeries(symbol);
    const generation = ++this.chartGeneration;
    this.chartState = {
      symbol,
      state: cached ? "ready" : "loading",
    };
    this.redraw(cx);
    this.publishChart(cx);
    if (!stream || cached) return;
    const request = this.chartRequestFor(symbol, mode);
    cx.spawn(async (cx) => {
      try {
        let candles;
        if (request.kind === "intraday") {
          const response = await stream.queryIntraday(request.params);
          candles = response.lines.map((line) => ({
            ...line,
            open: line.price,
            high: line.price,
            low: line.price,
            close: line.price,
          }));
        } else {
          const response = await stream.queryCandlesticks(request.params);
          candles = response.candlesticks;
        }
        if (!this.publishChartResponse(symbol, identity, generation, candles)) return;
      } catch (_) {
        if (!this.acceptsChartResponse(symbol, identity, generation)) return;
        this.chartState = {
          symbol,
          state: this.hasCachedChartSeries(symbol) ? "ready" : "error",
        };
      }
      this.redraw(cx);
      this.publishChart(cx);
    });
  }

  acceptsChartResponse(symbol, identity, generation) {
    return (
      generation === this.chartGeneration &&
      symbol === this.selectedSymbol &&
      identity !== null &&
      identity === this.currentChartIdentity(symbol)
    );
  }

  normalizeChartCandles(mode, candles) {
    const source = Array.isArray(candles) ? candles : EMPTY_CANDLES;
    if (mode === "intraday") return prepareIntradaySeries(source).candles;
    return prepareCandleSeries(source).candles;
  }

  publishChartResponse(symbol, identity, generation, candles) {
    if (!this.acceptsChartResponse(symbol, identity, generation)) return false;
    this.cacheChartSeries(identity, this.normalizeChartCandles(this.activeChartMode(), candles));
    this.chartState = { symbol, state: "ready" };
    return true;
  }

  quoteForActiveChart(candles, quote) {
    if (this.activeChartMode() !== "1D" || quote?.tradeSession !== TRADE_SESSION.NORMAL)
      return quote;
    const last = candles.at(-1);
    if (!last) return null;
    const lastMarketDay =
      typeof last.marketDay === "string"
        ? last.marketDay
        : typeof last.tradingDate === "string"
          ? last.tradingDate
          : null;
    const quoteMarketDay =
      typeof quote.marketDay === "string"
        ? quote.marketDay
        : typeof quote.tradingDate === "string"
          ? quote.tradingDate
          : null;
    if (lastMarketDay && quoteMarketDay) return lastMarketDay === quoteMarketDay ? quote : null;
    const lastBucket = providerDayBucket(last.timestamp);
    const quoteBucket = providerDayBucket(quote.timestamp);
    if (lastBucket === null || quoteBucket === null || lastBucket !== quoteBucket) return null;
    return { ...quote, dailyBucket: quoteBucket };
  }

  /**
   * Hands the chart its series on the next turn rather than in this one.
   *
   * `syncPriceChartView` crosses the nested-view bridge, and what it carries is
   * the whole selected window -- five sessions of minute candles is around two
   * thousand points, and the bridge costs about 0.03 ms each. Sixty
   * milliseconds is nothing on a background task and a stall on a click: the
   * frame that would have shown the new selection cannot be drawn until the
   * handler that started it returns, so the row highlighted late and the click
   * read as dropped. Deferring the publish lets the selection paint on the next
   * frame and the chart arrive on the one after.
   *
   * @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx
   */
  publishChart(cx) {
    if (this.chartPublish) return;
    this.chartPublish = cx.timer.after(0, (cx) => {
      this.chartPublish = null;
      this.syncPriceChartView();
      this.redraw(cx, PANE_DETAIL);
    });
  }

  /** @param {unknown} status @param {import("gpui-kit").AsyncContext} cx */
  receiveStatus(status, cx) {
    this.status = status && typeof status === "object" ? status : { state: "error" };
    if (typeof this.status.error === "string") this.streamError = this.status.error;
    else if (this.status.state === "connected") this.streamError = "";
    this.redraw(cx);
  }

  /**
   * The orders the account has, and how the reading of them went.
   *
   * Held as one value rather than three fields because a panel draws all of
   * it at once: a list that is loading, one that failed, and one that is
   * simply empty are three different things to say and the status is what
   * separates them. Bumping the generation invalidates whatever is in flight,
   * which is what makes signing out safe while a read is outstanding.
   */
  initOrdersState() {
    this.ordersGeneration = (this.ordersGeneration ?? 0) + 1;
    /**
     * @type {LongbridgeOrdersState}
     *
     * `loaded` is whether a read has ever succeeded, which is a different
     * question from `status` and the one the push channel asks. `status` says
     * what the *current* read is doing, and it is `loading` for as long as one
     * is out -- so a channel gated on it went quiet for the whole of every
     * refresh, which is exactly when an order has just been placed.
     */
    this.ordersState = { status: "idle", loaded: false, today: [], history: [], error: "" };
    /** The order whose sheet the right-hand panel is showing, if any. */
    this.selectedOrderId = null;
    this.selectedOrderRowId = null;
    /**
     * Orders the push channel has reported that a read has not caught up to.
     *
     * Longbridge accepts an order before its list reports one: the write and
     * the read reach different sides of the same system. So a read taken just
     * after a write comes back without it, and a list rebuilt from that read
     * alone would drop the order the gateway had already pushed. Held here,
     * folded back in after each read, and let go of once the read agrees --
     * or once the grace period says the endpoint is the better authority.
     *
     * @type {Map<string, { order: LongbridgeOrderRow, at: number }>}
     */
    this.pushedOrders = new Map();
    /**
     * Which scheduled re-read is still wanted.
     *
     * A timer that has been asked for cannot be taken back, so the ask is
     * numbered and the callback checks its number: raising this is what
     * cancels one. See `scheduleOrdersRefresh`.
     *
     * @type {number}
     */
    this.ordersRefreshToken = 0;
  }

  /** The order the detail panel is showing, or null once a reload drops it. */
  selectedOrder() {
    if (!this.selectedOrderId) return null;
    return (
      [...this.ordersState.today, ...this.ordersState.history].find(
        (order) => order.orderId === this.selectedOrderId,
      ) ?? null
    );
  }

  /**
   * Opens an order's sheet, or closes the one already open for it.
   *
   * A second click on the row that opened the panel closes it, so the row is
   * the control for its own detail rather than something that can only ever
   * open one.
   *
   * @param {string} orderId @param {import("gpui-kit").Context} cx
   */
  selectOrder(orderId, cx) {
    this.selectedOrderRowId = orderId;
    this.selectedOrderId = this.selectedOrderId === orderId ? null : orderId;
    this.redraw(cx);
  }

  /**
   * Opens the trade gateway's push channel for this session.
   *
   * Orders change without this application doing anything -- a resting limit
   * order fills at three in the afternoon, an exchange rejects one after
   * accepting it -- and until this existed the only way to learn that was to
   * ask again. The gateway says so instead.
   *
   * It is a second socket to a second host, and deliberately not folded into
   * `createQuoteStream`: the two gateways number their commands
   * independently, and one that fails has no business taking the other down.
   * A trade channel that will not connect leaves prices running.
   *
   * @param {string} token @param {number} generation @param {import("gpui-kit").AsyncContext} cx
   */
  startTradeStream(token, generation, cx) {
    this.stopTradeStream();
    let stream;
    // Guarded, because the comment above is only true if this cannot throw.
    // `createTradeStream` validates its arguments and its transport, and a
    // throw here is on the connect path -- it would take the watchlist, the
    // quotes and the chart down with it, over a channel none of them need.
    try {
      stream = this.buildTradeStream(token, generation, cx);
    } catch (error) {
      console.warn(`the trade stream could not be opened: ${error}`);
      return;
    }
    this.tradeStream = stream;
    stream.start();
  }

  /**
   * The push channel itself, separated only so that opening one can be tried
   * without the failure reaching the session it was opened from.
   *
   * @param {string} token @param {number} generation @param {import("gpui-kit").AsyncContext} cx
   */
  buildTradeStream(token, generation, cx) {
    let stream;
    stream = createTradeStream({
      accessToken: token,
      onOrder: (order) => {
        if (generation === this.streamGeneration && this.tradeStream === stream)
          this.receiveOrderChange(order, cx);
      },
      onStatus: (status, detail) => {
        // Not shown, and only the faults are logged.
        //
        // Not shown because `streamError` is the market data connection, which
        // is what the window's status line is about; an order channel that is
        // reconnecting says nothing there, because prices have not stopped.
        //
        // Only the faults because the rest is a channel working. Every step of
        // every connection used to be logged, on the grounds that a channel
        // which draws nothing has no other way to be observed and that its
        // symptom when wrong -- orders that do not appear -- looks exactly like
        // a quiet account. That was worth five lines per connection while the
        // channel was unproven. It is not worth them now: a handshake that
        // reaches `connected`, and an order that arrives, say nothing a reader
        // of this log needs, and saying it every time buries the two lines that
        // do. What is left is a channel that could not stay up and a callback
        // that threw -- neither of which happens when this is working.
        if (status !== "reconnecting" && status !== "callback_error") return;
        const detailText = Object.entries(detail ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(" ");
        console.warn(`trade stream ${status}${detailText ? ` ${detailText}` : ""}`);
      },
    });
    return stream;
  }

  /** Closes the push channel, if one is open. Safe to call when none is. */
  stopTradeStream() {
    const stream = this.tradeStream;
    this.tradeStream = null;
    stream?.stop();
  }

  /**
   * One order's news, from the gateway.
   *
   * Applied to today's list only. An order that changes today is today's,
   * whatever the History window would say about it, and inserting into both
   * would show it twice.
   *
   * A push that changes nothing is dropped before the repaint. The gateway
   * sends one message per state change and some states repeat, so the
   * comparison is what keeps a resting order from repainting the window every
   * time the exchange restates it.
   *
   * @param {Record<string, unknown>} pushed @param {import("gpui-kit").Context} cx
   */
  receiveOrderChange(pushed, cx) {
    const order = normalizePushedOrder(pushed);
    if (!order.orderId) return;
    // Recorded whether or not there is a list to put it in. A push that
    // arrives before the page has ever been read is the one that matters
    // most -- it is the order that was just placed -- and the read that
    // follows folds it back in rather than losing it.
    this.pushedOrders.set(order.orderId, { order, at: Date.now() });
    // Before the list has ever been read there is nothing to merge into: a
    // first push would otherwise become a one-row list that looks complete
    // and is not.
    //
    // Deliberately not `status === "ready"`. A read in flight leaves `status`
    // at `loading`, and a read that failed leaves it at `error`; neither means
    // the list on screen has stopped being a list. Gating on the read rather
    // than on the list is what kept the gateway's news off the screen for the
    // whole of every refresh -- including the refresh that follows placing an
    // order, which is the one moment this channel exists for.
    if (!this.ordersState.loaded) return;
    // The gateway got there first, so the read armed by the write has nothing
    // left to find. Dropped whether or not the row actually changed: a repeat
    // of a state this list already has is still the channel proving it is
    // working, which is the only thing the fallback was insuring against.
    this.cancelOrdersRefresh();
    const today = mergeOrder(this.ordersState.today, order);
    if (today === this.ordersState.today) return;
    this.ordersState = { ...this.ordersState, today };
    // Through the application's one repaint funnel, as every quote push is.
    //
    // Not `redraw(cx)` directly. `cx` here was captured when the session
    // connected and has been held across every await since; `scheduleRedraw`
    // notifies from inside `cx.timer.after`, which hands its callback a
    // context of its own, and that is the arrangement every working push in
    // this application uses. It also coalesces, which a fill wants: one
    // submission arrives as a short burst -- accepted, queued, filled in parts
    // -- and each on its own paint would be three repaints for one event.
    this.scheduleRedraw(cx);
  }

  /**
   * Reads both order lists, on the page that shows them.
   *
   * The push channel keeps today's list current once it has been read, but it
   * only reports changes: it never says what was already there, and it says
   * nothing at all about History. So the page still asks once, when it opens
   * and when the session reconnects, rather than on a timer nobody asked for.
   *
   * @param {import("gpui-kit").Context} cx
   */
  loadOrders(cx) {
    cx.spawn(async (cx) => this.reloadOrders(cx));
  }

  /**
   * How long after placing, changing or withdrawing an order the list gives up
   * on being told and asks instead.
   *
   * The gateway is the fast path and normally reports the order within a
   * moment of the write returning. This is the slow one, for the times it does
   * not: a channel that is reconnecting, or a notification that was never
   * sent. Three seconds is what ../longbridge-gpui waits, and it is chosen the
   * same way -- long enough that the push almost always wins the race and the
   * read never happens, short enough that a reader who was told their order
   * was accepted does not sit looking at a list without it.
   */
  static get ORDER_ACTION_FALLBACK_MS() {
    return 3_000;
  }

  /**
   * Asks for the list again in a while, unless something says not to.
   *
   * The push channel is what usually says not to: an order that arrives on it
   * has already reached the screen, and the read this would have done would
   * only have confirmed it. So this is armed by a write and disarmed by the
   * news -- see `receiveOrderChange` -- rather than being a poll that runs
   * whether or not anything happened.
   *
   * @param {number} delayMillis @param {import("gpui-kit").Context} cx
   */
  scheduleOrdersRefresh(delayMillis, cx) {
    const token = (this.ordersRefreshToken ?? 0) + 1;
    this.ordersRefreshToken = token;
    cx.timer.after(delayMillis, (cx) => {
      if (this.ordersRefreshToken !== token) return;
      this.ordersRefreshToken = 0;
      // Not on a page that is not showing them. The page asks on the way in,
      // so a reader who has moved on gets a current list when they come back
      // rather than one read while they were elsewhere.
      if (this.page !== "orders") return;
      this.loadOrders(cx);
    });
  }

  /** Drops a scheduled re-read, because the news arrived on its own. */
  cancelOrdersRefresh() {
    this.ordersRefreshToken = (this.ordersRefreshToken ?? 0) + 1;
  }

  /**
   * Reads the order lists after an order was placed, changed or withdrawn.
   *
   * Through the session's context, and deliberately not through the ticket's.
   *
   * A dialog is its own view -- `presentTicket` hands `open_dialog` a function
   * the shell calls when *it* renders -- so the context a ticket button is
   * given belongs to the ticket. A task spawned from it and then *awaited
   * across* `close_dialog` is a task waiting on a view that is being taken
   * down: the read is issued, the panel is put into `loading` to say so, and
   * the continuation that would have published the answer never runs. The
   * list then sits at "Loading orders" for the life of the session, holding no
   * rows, and the gateway's push for the order that was just placed is dropped
   * with it because a list that has never loaded has nothing to merge into.
   * Switching pages was the only way out, because that read is asked for by
   * the workspace and the workspace is still there.
   *
   * `addSymbol` is the same shape and does not have this problem, for the one
   * reason worth copying: every await it does happens *before* it closes its
   * dialog. This does the same by owning the work elsewhere rather than by
   * holding the ticket open for a read nobody is reading.
   *
   * Two reads, not one. The first is now, for the rest of the page. The second
   * is the fallback three seconds out, because Longbridge accepts an order
   * before its own list reports one -- and the gateway, which reports it
   * immediately, disarms that fallback when it does.
   *
   * @param {import("gpui-kit").Context} [fallbackContext]
   */
  refreshOrdersAfterAction(fallbackContext) {
    const cx = this.sessionContext ?? fallbackContext;
    if (!cx) return;
    this.loadOrders(cx);
    this.scheduleOrdersRefresh(LongbridgeApp.ORDER_ACTION_FALLBACK_MS, cx);
  }

  /**
   * How long a pushed order outlives a read that disagrees with it.
   *
   * The gap it covers is the one between a write being accepted and this
   * account's list reporting it, which is seconds. Past that the endpoint is
   * the better authority: an order that fills and moves to History would
   * otherwise be held in today's list by a push nothing ever supersedes.
   */
  static get ORDER_PUSH_GRACE_MS() {
    return 30_000;
  }

  /**
   * The read's list, with anything the push channel knows and it does not.
   *
   * `updatedAt` is what decides. A read that carries the same version of an
   * order, or a newer one, has caught up, and the pushed copy is let go; a
   * read that is still behind keeps it. Entries past the grace period are
   * dropped whatever the read says.
   *
   * @param {readonly LongbridgeOrderRow[]} today @param {number} [now]
   */
  applyPushedOrders(today, now = Date.now()) {
    let merged = today;
    for (const [orderId, entry] of this.pushedOrders) {
      const read = merged.find((candidate) => candidate.orderId === orderId);
      if (
        (read && read.updatedAt >= entry.order.updatedAt) ||
        now - entry.at > LongbridgeApp.ORDER_PUSH_GRACE_MS
      ) {
        this.pushedOrders.delete(orderId);
        continue;
      }
      merged = mergeOrder(merged, entry.order);
    }
    return merged;
  }

  /**
   * Reads both order lists, in whatever task is already running.
   *
   * Separate from `loadOrders` so a caller already inside a `cx.spawn` can
   * await it rather than start a second task inside the first, which is not
   * guaranteed to outlive the one that opened it.
   *
   * The ticket is not such a caller, and awaiting this from one was the bug:
   * see `refreshOrdersAfterAction`. Whichever way it is reached, a read whose
   * task does not survive leaves the panel saying "Loading orders" forever --
   * the continuation never runs, so the state never leaves `loading`.
   *
   * The generation stays here rather than at the call sites, so both paths get
   * it: a read that is overtaken by a newer one does not put its older answer
   * back.
   *
   * What comes back is reconciled with what the push channel has already
   * reported -- see `applyPushedOrders` -- because the two do not agree
   * immediately after a write.
   *
   * @param {import("gpui-kit").Context} cx
   */
  async reloadOrders(cx) {
    if (!this.hasStoredTokens) return;
    const generation = (this.ordersGeneration ?? 0) + 1;
    this.ordersGeneration = generation;
    this.ordersState = { ...this.ordersState, status: "loading", error: "" };
    this.redraw(cx);
    try {
      const { today, history } = await this.refreshOrders();
      if (generation !== this.ordersGeneration) return;
      this.ordersState = {
        status: "ready",
        loaded: true,
        today: this.applyPushedOrders(today),
        history,
        error: "",
      };
    } catch (error) {
      if (generation !== this.ordersGeneration) return;
      this.ordersState = {
        ...this.ordersState,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.redraw(cx);
  }

  async refreshOrders() {
    // In parallel. These are two independent reads of two endpoints, and run
    // one after the other the page waited for their sum -- about three
    // quarters of a second against a live account -- when the slower of the
    // two is all it owes. They used to be sequential because two requests that
    // discovered an expired access token together would each rotate the
    // refresh token and retire each other's; `refreshAccessToken` now
    // deduplicates that rotation, so the reason is gone.
    const [today, history] = await Promise.all([
      get("/v1/trade/order/today"),
      get("/v1/trade/order/history", historyRange()),
    ]);
    return { today: normalizeOrders(today), history: normalizeOrders(history) };
  }

  /**
   * Reads the watchlist again, keeping the prices already on screen.
   *
   * A quote is a running value, not a property of the list, so a row that was
   * already there keeps the one it has: rebuilding from `initialQuotes` alone
   * would blank every price on the screen each time a security was added.
   */
  async refreshWatchlist() {
    const watchlist = await get("/v1/watchlist/groups");
    const instruments = watchlistInstruments(watchlist);
    const previous = new Map(this.quotes.map((quote) => [quote.symbol, quote]));
    this.groups = watchlistGroups(watchlist);
    this.instruments = instruments;
    this.quotes = sortLikeTerminal(
      initialQuotes(instruments).map((quote) => previous.get(quote.symbol) ?? quote),
      Date.now(),
    );
  }

  /**
   * Looks up whatever has been typed, as soon as it is the shape of a symbol.
   *
   * A watchlist is a list of securities, and `NVDA.US` is a string until
   * something says what it names. So the moment the field holds a symbol this
   * asks the socket what that symbol is, and the answer -- a name, an
   * exchange, a price -- is what the reader confirms rather than the spelling
   * they just typed.
   *
   * The generation is what makes a fast typist safe: every keystroke starts a
   * lookup and only the newest one is allowed to publish.
   *
   * @param {import("gpui-kit").Context} cx
   */
  previewSymbol(cx) {
    const { symbol } = symbolFromInput(this.symbolQuery);
    if (!symbol) {
      if (this.symbolPreview.status === "idle") return;
      this.symbolPreviewGeneration += 1;
      this.setSymbolPreview({ status: "idle", symbol: "", error: "" });
      return;
    }
    if (this.symbolPreview.symbol === symbol && this.symbolPreview.status !== "error") return;
    const generation = ++this.symbolPreviewGeneration;
    this.setSymbolPreview({ status: "loading", symbol, error: "" });
    const stream = this.stream;
    if (!stream) {
      this.setSymbolPreview({
        status: "error",
        symbol,
        error: "Not connected. Reconnect to look this symbol up.",
      });
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const [statics, quotes] = await Promise.all([
          stream.queryStaticInfo([symbol]),
          stream.queryQuotes([symbol]).catch(() => []),
        ]);
        if (generation !== this.symbolPreviewGeneration) return;
        const info = statics.find((entry) => entry.symbol === symbol) ?? statics[0];
        if (!info || !info.symbol) {
          this.setSymbolPreview({
            status: "error",
            symbol,
            error: `No security is called ${symbol}.`,
          });
          return;
        }
        // The same answer carries the board lot. Filing it here means a ticket
        // opened on a security just added already knows its lot.
        const lot = Number(info.lotSize);
        if (Number.isFinite(lot) && lot > 0) this.lotSizes.set(symbol, lot);
        const quote = quotes.find((entry) => entry.symbol === symbol) ?? quotes[0] ?? {};
        const [row] = applyQuotes(initialQuotes([{ symbol, code: symbol.split(".")[0] }]), [
          { ...quote, symbol },
        ]);
        this.setSymbolPreview({
          status: "ready",
          symbol,
          name: info.nameEn || info.nameCn || info.nameHk || symbol,
          exchange: info.exchange || symbol.split(".")[1] || "",
          currency: info.currency || "",
          last: row?.last ?? "--",
          change: row?.change ?? "--",
          changePercent: row?.changePercent ?? "--",
          error: "",
        });
      } catch (failure) {
        if (generation !== this.symbolPreviewGeneration) return;
        this.setSymbolPreview({
          status: "error",
          symbol,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    });
  }

  /**
   * Adds the typed security to the account's first watchlist group.
   *
   * The list is read back rather than assumed: Longbridge answers a refused
   * addition with a code in a 200, and a symbol that named nothing comes back
   * as a list that does not contain it. So what says the change happened is
   * the change being there afterwards.
   *
   * @param {import("gpui-kit").Context} cx
   */
  addSymbol(cx) {
    if (this.addSymbolPending || this.symbolPreview.status !== "ready") return;
    const { symbol, error } = symbolFromInput(this.symbolQuery);
    const group = addTargetGroup(this.groups);
    const refused = error
      ? error
      : this.quotes.some((quote) => quote.symbol === symbol)
        ? `${symbol} is already on the watchlist.`
        : group
          ? ""
          : "This account has no watchlist group to add to.";
    if (refused) {
      this.addSymbolError = refused;
      this.refreshDialog();
      return;
    }
    this.addSymbolPending = true;
    this.addSymbolError = "";
    this.refreshDialog();
    cx.spawn(async (cx) => {
      try {
        await put("/v1/watchlist/groups", {
          id: groupRequestId(group),
          securities: [symbol],
          mode: "add",
        });
        await this.refreshWatchlist();
        if (!this.instruments.some((instrument) => instrument.symbol === symbol)) {
          throw new Error(`Longbridge did not add ${symbol}. Check the symbol.`);
        }
        await this.stream?.watchSymbols([symbol]);
        this.symbolInput.set_value("");
        this.symbolQuery = "";
        this.forgetAddSymbol();
        window.close_dialog();
        this.selectQuote(symbol, cx);
        this.redraw(cx);
        window.push_toast({
          title: `${symbol} added to ${group.name}`,
          level: "success",
          id: "watchlist-add",
        });
      } catch (failure) {
        this.addSymbolPending = false;
        this.addSymbolError = failure instanceof Error ? failure.message : String(failure);
        this.refreshDialog();
      }
    });
  }

  /**
   * Takes a security out of every group that holds it.
   *
   * Out of every one, because the account's groups overlap -- the whole list
   * and the market's own group both hold it -- and taking it out of one of
   * them leaves it on screen, put there by the other.
   *
   * @param {string} symbol @param {import("gpui-kit").Context} cx
   */
  dropSymbol(symbol, cx) {
    const holders = groupsHolding(this.groups, symbol);
    this.rowMenu = null;
    this.redraw(cx);
    if (holders.length === 0) return;
    cx.spawn(async (cx) => {
      try {
        for (const group of holders) {
          await put("/v1/watchlist/groups", {
            id: groupRequestId(group),
            securities: [symbol],
            mode: "remove",
          });
        }
        await this.refreshWatchlist();
        if (this.instruments.some((instrument) => instrument.symbol === symbol)) {
          throw new Error(`Longbridge is still watching ${symbol}.`);
        }
        // A holding is streamed for the Portfolio page whether or not the
        // watchlist names it, so only a symbol nothing else needs is dropped.
        if (!this.holdings.some((holding) => holding.symbol === symbol)) {
          await this.stream?.unwatchSymbols([symbol]);
        }
        if (this.selectedSymbol === symbol) {
          this.selectedSymbol = null;
          const next = this.quotes[0]?.symbol ?? null;
          if (next) this.selectQuote(next, cx);
          else this.clearDetailMarket();
        }
        this.redraw(cx);
        window.push_toast({
          title: `${symbol} removed from the watchlist`,
          level: "success",
          id: "watchlist-drop",
        });
      } catch (failure) {
        this.error = failure instanceof Error ? failure.message : String(failure);
        this.redraw(cx);
      }
    });
  }

  /** A ticket that is not open, which is also the shape of one that is. */
  blankTicket() {
    return {
      open: false,
      stage: /** @type {"form" | "review"} */ ("form"),
      mode: /** @type {"submit" | "replace" | "cancel"} */ ("submit"),
      side: "Buy",
      symbol: "",
      name: "",
      currency: "",
      orderId: "",
      // Fixed for the life of the ticket, not minted per click. That is what
      // makes a retry after a lost response idempotent: pressing Confirm again
      // sends the id Longbridge already answered, and gets that order back
      // instead of a second one. A fresh id per press would make this field a
      // decoration.
      requestId: "",
      /** @type {number | null} The board lot, once it is known. */
      lotSize: null,
      /** @type {"shares" | "amount"} Which number the reader is typing. */
      sizing: "shares",
      type: "LO",
      timeInForce: "Day",
      outsideRth: false,
      errors: /** @type {{ price?: string, quantity?: string, form?: string }} */ ({}),
      review: /** @type {ReturnType<typeof validateTicket>["normalized"]} */ (null),
      pending: false,
      error: "",
    };
  }

  /**
   * The last traded price, as a number, or `null`.
   *
   * What an amount is divided by when the order names no price of its own. It
   * is a reading rather than a promise, which is why a market order sized this
   * way says on its confirmation what it was sized against.
   *
   * @param {string} symbol
   */
  lastTradedPrice(symbol) {
    const quote = this.quotes.find((entry) => entry.symbol === symbol);
    const value = Number(String(quote?.last ?? "").trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * How many shares of an instrument this account could sell.
   *
   * `available` rather than `quantity`: a position can be partly committed to
   * orders that have not filled, and offering the whole holding would put a
   * rejection behind the Review button. A holding this account does not have
   * answers `null` -- not zero, because zero is a claim about the position and
   * `null` is the absence of one, which is the difference `validateTicket`
   * turns on.
   *
   * @param {string} symbol
   */
  sellableQuantity(symbol) {
    const holding = this.holdings.find((entry) => entry.symbol === symbol);
    if (!holding) return null;
    for (const candidate of [holding.available, holding.quantity]) {
      const value = Number(String(candidate ?? "").trim());
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  /**
   * What this application knows about an instrument, for the ticket's heading
   * and the currency on its estimate. The watchlist is asked first and the
   * portfolio second: a holding that is not watched still has a name.
   *
   * @param {string} symbol
   */
  instrumentFacts(symbol) {
    const quote = this.quotes.find((entry) => entry.symbol === symbol);
    const holding = this.holdings.find((entry) => entry.symbol === symbol);
    /** @param {unknown} value */
    const readable = (value) => {
      const text = String(value ?? "").trim();
      return text === "--" ? "" : text;
    };
    return {
      name: readable(quote?.name) || readable(holding?.name),
      currency: readable(quote?.currency) || readable(holding?.currency),
    };
  }

  /**
   * Opens a ticket to place an order.
   *
   * The price starts at the last traded price, which is the number someone
   * about to trade is already looking at -- and, being a limit order, one that
   * will not fill at a price they did not choose. The quantity starts empty:
   * there is no amount that can be guessed, and a pre-filled one is an amount
   * nobody typed sitting behind a Confirm button.
   *
   * @param {string} symbol @param {"Buy" | "Sell"} side @param {import("gpui-kit").Context} cx
   */
  openTicket(symbol, side, cx) {
    this.syncDialogFlags();
    // The menu closes on the way in, before anything can decline to open a
    // ticket. A menu item that was pressed has to stop being on screen either
    // way: leaving it up is how a refusal reads as the application ignoring
    // the click.
    this.rowMenu = null;
    // One dialog at a time: the shell keeps a stack, and a ticket opened over
    // the add-a-security dialog would close that one on its way out.
    if (!symbol || this.ticket.open || this.addSymbolOpen) {
      this.redraw(cx);
      return;
    }
    const facts = this.instrumentFacts(symbol);
    const quote = this.quotes.find((entry) => entry.symbol === symbol);
    const last = String(quote?.last ?? "").trim();
    this.ticket = {
      ...this.blankTicket(),
      open: true,
      mode: "submit",
      side,
      symbol,
      name: facts.name,
      currency: facts.currency,
      requestId: randomUUID(),
      lotSize: this.lotSizes.get(symbol) ?? null,
    };
    this.ticketPrice.set_value(last && last !== "--" ? last : "");
    this.ticketQuantity.set_value("");
    this.ticketAmount.set_value("");
    this.presentTicket();
    this.loadLotSize(symbol, cx);
    this.redraw(cx);
  }

  /**
   * Asks the quote socket what one lot of an instrument is.
   *
   * Hong Kong trades in board lots -- 100 shares of one security, 500 of
   * another -- and an order for part of a lot is refused by the exchange. The
   * size is in the static info the socket already answers; nothing carried it
   * up before, because nothing needed it until an order could be placed.
   *
   * It is fetched when a ticket opens rather than for the whole watchlist:
   * one instrument is being traded, and asking about the other forty would be
   * a request per window rather than per order.
   *
   * A lookup that fails is not reported. The ticket then validates without a
   * lot, which refuses nothing -- the exchange still enforces it, and its
   * refusal arrives with a reason, which is more than this client could say.
   *
   * @param {string} symbol @param {import("gpui-kit").Context} cx
   */
  loadLotSize(symbol, cx) {
    if (this.lotSizes.has(symbol)) return;
    const stream = this.stream;
    if (!stream) return;
    cx.spawn(async (cx) => {
      try {
        const infos = await stream.queryStaticInfo([symbol]);
        const info = infos.find((entry) => entry.symbol === symbol) ?? infos[0];
        const lot = Number(info?.lotSize);
        if (!Number.isFinite(lot) || lot <= 0) return;
        this.rememberLotSize(symbol, lot, cx);
      } catch (_) {
        // Not knowing the lot is a state the ticket already handles.
      }
    });
  }

  /**
   * Files a board lot, and tells an open ticket that is waiting on it.
   *
   * The ticket holds its own copy rather than reading the map as it renders,
   * so this has to reach the one on screen -- which may have been opened
   * before the answer arrived.
   *
   * @param {string} symbol @param {number} lot @param {import("gpui-kit").Context} cx
   */
  rememberLotSize(symbol, lot, cx) {
    this.lotSizes.set(symbol, lot);
    if (this.ticket.open && this.ticket.symbol === symbol) {
      this.ticket = { ...this.ticket, lotSize: lot };
      this.refreshTicket();
    }
    this.redraw(cx);
  }

  /**
   * Opens a ticket on whatever the keyboard is pointing at.
   *
   * Which instrument `b` means depends on the page, because the selection
   * does: the Watchlist has a selected quote, the Portfolio a selected
   * holding, and the Orders page a selected order, which names one. A page
   * with nothing selected does nothing rather than guessing at a row.
   *
   * @param {"Buy" | "Sell"} side @param {import("gpui-kit").Context} cx
   */
  openTicketForSelection(side, cx) {
    if (this.ticket.open || this.addSymbolOpen) return;
    const symbol =
      this.page === "portfolio"
        ? this.selectedHoldingSymbol
        : this.page === "orders"
          ? (this.selectedOrder()?.symbol ?? null)
          : this.selectedSymbol;
    if (symbol) this.openTicket(symbol, side, cx);
  }

  /**
   * Opens a ticket to change an order that has not finished.
   *
   * Both fields start at what the order already says, so leaving one alone
   * leaves it alone -- the endpoint requires the quantity on every
   * replacement, so an untouched quantity is still sent, and it must be sent
   * as what it was.
   *
   * @param {LongbridgeOrderRow} order @param {import("gpui-kit").Context} cx
   */
  openReplaceTicket(order, cx) {
    this.syncDialogFlags();
    this.rowMenu = null;
    if (!order || this.ticket.open || !canReplace(order)) {
      this.redraw(cx);
      return;
    }
    const facts = this.instrumentFacts(order.symbol);
    this.ticket = {
      ...this.blankTicket(),
      open: true,
      mode: "replace",
      side: order.side,
      symbol: order.symbol,
      name: order.name || facts.name,
      currency: order.currency || facts.currency,
      orderId: order.orderId,
      lotSize: this.lotSizes.get(order.symbol) ?? null,
      type: isLimitOrder(order.type) ? "LO" : "MO",
      timeInForce: order.timeInForce === "GTC" ? "GTC" : "Day",
    };
    this.ticketPrice.set_value(order.price === "--" ? "" : order.price);
    this.ticketQuantity.set_value(order.quantity === "--" ? "" : order.quantity);
    // A replacement edits an order that already exists, and what it holds is a
    // share count -- so it opens on the field that number belongs in.
    this.ticketAmount.set_value("");
    this.presentTicket();
    this.loadLotSize(order.symbol, cx);
    this.redraw(cx);
  }

  /**
   * Opens the confirmation for withdrawing an order.
   *
   * It opens straight into `review`: there is nothing to fill in, and the
   * whole of the interaction is being sure which order is about to be taken
   * back.
   *
   * @param {LongbridgeOrderRow} order @param {import("gpui-kit").Context} cx
   */
  openCancelTicket(order, cx) {
    this.syncDialogFlags();
    this.rowMenu = null;
    if (!order || this.ticket.open || !canCancel(order)) {
      this.redraw(cx);
      return;
    }
    this.ticket = {
      ...this.blankTicket(),
      open: true,
      stage: "review",
      mode: "cancel",
      side: order.side,
      symbol: order.symbol,
      name: order.name,
      currency: order.currency,
      orderId: order.orderId,
      type: order.type,
    };
    this.presentTicket();
    this.redraw(cx);
  }

  /**
   * Closes a dialog left over from a previous view.
   *
   * The shell's dialog stack outlives a view. A reload builds a new one, and
   * the surface still standing draws from a closure over the old instance --
   * whose `InputState`s went with it, so the fields come back as "this input
   * state has been released" and the ticket loses the boxes it is made of.
   *
   * The mirror is the other half of the same seam: `syncDialogFlags` handles a
   * surface the shell dropped without telling this side, and this handles this
   * side going away without telling the shell. Neither direction is reported,
   * so both are asked about at the points where it matters.
   */
  dismissStaleDialogs() {
    // The dialog calls are illegal in a window whose first view is not a
    // `ShellRoot` -- a test probe, which has no dialog stack and therefore
    // nothing left in it. "No dialog" is the right answer there, so the
    // refusal is the answer rather than a failure.
    try {
      if (this.shellHasDialog()) window.close_all_dialogs();
    } catch (_) {
      // Nothing to close, and nowhere to have closed it.
    }
  }

  /**
   * Brings the dialog flags back in line with the shell's own stack.
   *
   * `open_dialog` is given `escape_dismissable` and `backdrop_dismissable`,
   * which hand those two gestures to the shell -- and `DialogOptions` carries
   * no close callback, so the shell has no way to say it used one. `open` on
   * this side is therefore a *mirror*, and it goes stale the moment a reader
   * presses Escape or clicks the backdrop: the surface is gone from the
   * window while the flag still says it is up.
   *
   * A stale flag is not cosmetic. Every `open...` guard reads it, so the
   * ticket could be opened exactly once per run -- and because the guard
   * returns before the row menu is dismissed, a second Buy did nothing at all
   * and left its menu standing, which is what makes it look like a dropped
   * `notify` rather than a piece of state that is out of date.
   *
   * `has_active_dialog()` is the authority. Asking it before anything reads
   * the flags is the only place the two can be reconciled without a callback
   * the runtime does not offer.
   */
  syncDialogFlags() {
    if (!this.ticket.open && !this.addSymbolOpen) return;
    if (this.shellHasDialog()) return;
    this.forgetTicket();
    this.forgetAddSymbol();
  }

  /**
   * Whether the shell is showing a dialog.
   *
   * A method rather than the call itself so a probe can answer for it:
   * `open_dialog` requires a `ShellRoot` as the window's first view, which a
   * test window does not have, and the behaviour worth pinning down is what
   * this application does with the answer rather than the shell's bookkeeping.
   */
  shellHasDialog() {
    return window.has_active_dialog();
  }

  /** Puts the ticket on screen, and gives it the keyboard. */
  presentTicket() {
    window.open_dialog(() => this.ticketDialog(this.tokens), {
      escape_dismissable: true,
      backdrop_dismissable: true,
    });
    // Otherwise the ticket opens with the keyboard still on the workspace
    // behind it: Tab walks the watchlist, and Enter activates a row under a
    // dialog the reader is looking at.
    this.ticketFocus?.focus();
  }

  /**
   * Redraws the open ticket.
   *
   * The same reason `refreshDialog` exists: a dialog is its own view built
   * from a function the shell calls when it renders, so `cx.notify()` here
   * reaches the workspace and never the dialog.
   */
  refreshTicket() {
    if (this.ticket.open) window.refresh();
  }

  /**
   * Clears one field's error as it is typed into.
   *
   * An error that stays under a field being corrected is an error about a
   * value that no longer exists. It is cleared on change rather than
   * re-validated: the answer is not finished being typed.
   *
   * @param {"price" | "quantity" | "amount"} field
   */
  clearTicketFieldError(field) {
    if (!this.ticket.open || !this.ticket.errors[field]) return;
    const errors = { ...this.ticket.errors };
    delete errors[field];
    this.ticket = { ...this.ticket, errors };
    this.refreshTicket();
  }

  /** The ticket's fields, as `validateTicket` reads them. */
  ticketForm() {
    return {
      symbol: this.ticket.symbol,
      side: this.ticket.side,
      type: this.ticket.type,
      price: this.ticketPrice.value(),
      quantity: this.ticketQuantity.value(),
      sizing: this.ticket.sizing,
      amount: this.ticketAmount.value(),
      timeInForce: this.ticket.timeInForce,
      outsideRth: this.ticket.outsideRth,
    };
  }

  /**
   * Changes one of the ticket's choices.
   *
   * Field errors are dropped with it. Every one of these choices changes which
   * fields exist or what they mean -- switching to a market order takes the
   * price away, switching to an amount takes the quantity away -- so a
   * complaint about the previous arrangement is about a field the reader is no
   * longer looking at.
   *
   * @param {Partial<{ type: string, timeInForce: string, outsideRth: boolean, sizing: string }>} change
   */
  updateTicket(change) {
    this.ticket = { ...this.ticket, ...change, errors: {}, error: "" };
    this.refreshTicket();
  }

  /**
   * Checks the ticket and, if it holds together, freezes it into the
   * confirmation.
   *
   * Nothing has been sent at this point and nothing will be until Confirm.
   * What this does is decide there is something worth confirming.
   *
   * @param {import("gpui-kit").Context} _cx
   */
  reviewTicket(_cx) {
    if (!this.ticket.open || this.ticket.pending) return;
    const result = validateTicket(this.ticketForm(), {
      available: this.ticket.side === "Sell" ? this.sellableQuantity(this.ticket.symbol) : null,
      lotSize: this.ticket.lotSize,
      lastPrice: this.lastTradedPrice(this.ticket.symbol),
    });
    if (!result.ok) {
      this.ticket = { ...this.ticket, errors: result.errors, error: "" };
      this.refreshTicket();
      return;
    }
    this.ticket = {
      ...this.ticket,
      stage: "review",
      errors: {},
      error: "",
      review: result.normalized,
    };
    this.refreshTicket();
  }

  /**
   * One step forward through the ticket, from the keyboard.
   *
   * Enter means "the next thing", and the next thing depends on where the
   * ticket is: from the fields it is the confirmation, from the confirmation
   * it is sending. It deliberately does not skip the confirmation -- Enter in
   * a filled-in form is exactly the keystroke someone presses without looking,
   * and the screen it lands on is the one that says what is about to happen.
   *
   * @param {import("gpui-kit").Context} cx
   */
  advanceTicket(cx) {
    if (!this.ticket.open || this.ticket.pending) return;
    if (this.ticket.stage === "form") this.reviewTicket(cx);
    else this.confirmTicket(cx);
  }

  /** Back to the fields, with what was typed still in them. */
  backToTicketForm() {
    if (!this.ticket.open || this.ticket.pending) return;
    this.ticket = { ...this.ticket, stage: "form", error: "" };
    this.refreshTicket();
  }

  /** Drops what the ticket was holding, without touching the shell's stack. */
  forgetTicket() {
    this.ticket = this.blankTicket();
  }

  /** @param {import("gpui-kit").Context} cx */
  closeTicket(cx) {
    if (!this.ticket.open) return;
    this.forgetTicket();
    window.close_dialog();
    // Back where it came from. A dialog that takes the keyboard has to give it
    // back, or the chords the workspace is written around reach nothing.
    this.workspaceFocus?.focus();
    this.redraw(cx);
  }

  /**
   * Sends the confirmed ticket.
   *
   * Two things make this safe to press. The request is built from
   * `ticket.review` -- the values that were confirmed, not the fields, which
   * may have been stepped since Review. And the submit carries the ticket's
   * own `client_request_id`, so pressing Confirm again after a lost response
   * returns the first order rather than placing a second.
   *
   * What counts as sent is the request returning. A Longbridge write can
   * refuse inside a 200, and `http.js` turns that into an error, so a return
   * here means the order was accepted -- unlike a watchlist change, which
   * `addSymbol` has to read back because a symbol naming nothing comes back
   * as a list that simply does not contain it.
   *
   * The order list is refreshed afterwards to show the result, and that
   * refresh is deliberately not allowed to fail the submit: the order exists
   * either way, and reporting a failed *read* as a failed *order* is how
   * someone ends up placing it twice.
   *
   * A failure to send leaves the dialog open with the reason in it. Closing it
   * would take the answer away along with the ticket, and the reader would be
   * left to find out from the order list whether anything happened.
   *
   * @param {import("gpui-kit").Context} cx
   */
  confirmTicket(cx) {
    const ticket = this.ticket;
    if (!ticket.open || ticket.pending || ticket.stage !== "review") return;
    if (ticket.mode !== "cancel" && !ticket.review) return;
    this.ticket = { ...this.ticket, pending: true, error: "" };
    this.refreshTicket();
    cx.spawn(async (cx) => {
      try {
        if (ticket.mode === "submit") {
          await post(TRADE_ORDER_PATH, submitOrderBody(ticket.review, ticket.requestId));
        } else if (ticket.mode === "replace") {
          await put(TRADE_ORDER_PATH, replaceOrderBody(ticket.orderId, ticket.review));
        } else {
          await del(TRADE_ORDER_PATH, cancelOrderBody(ticket.orderId));
        }
        this.forgetTicket();
        window.close_dialog();
        this.workspaceFocus?.focus();
        // The order list is where the result of all three of these is, so the
        // page follows the action rather than leaving the reader to go looking
        // for what they just did. `showPage` is not used because it declines
        // to do anything when the page is already the one asked for, and the
        // list has to be re-read either way -- so the page is set here and the
        // read is asked for once, below.
        this.page = "orders";
        this.redraw(cx);
        window.push_toast({
          title:
            ticket.mode === "submit"
              ? `${ticket.side} ${ticket.symbol} submitted`
              : ticket.mode === "replace"
                ? `${ticket.symbol} order updated`
                : `${ticket.symbol} order withdrawn`,
          level: "success",
          id: "trade-order",
        });
        // Through a read that carries a generation, rather than by assigning
        // the state here: a read already in flight would otherwise answer
        // afterwards with a list fetched before the order existed and put it
        // back, so the new order appeared and then vanished. It also shows the
        // list as loading while it is, and reports a failed read on the page
        // that could not be read rather than on a ticket that succeeded.
        //
        // Handed to the session and not awaited here. This task belongs to the
        // ticket, and the ticket's view has just been closed above -- see
        // `refreshOrdersAfterAction` for what awaiting past that did.
        //
        // The read is for the rest of the page rather than for the order that
        // was just placed: Longbridge accepts an order before its list reports
        // one, and what closes that gap is the gateway pushing it as soon as
        // it exists -- see `receiveOrderChange`.
        this.refreshOrdersAfterAction(cx);
      } catch (failure) {
        this.ticket = {
          ...this.ticket,
          pending: false,
          error: failure instanceof Error ? failure.message : String(failure),
        };
        this.refreshTicket();
      }
    });
  }

  /** @param {import("gpui-kit").Context} cx */
  loadPortfolio(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.refreshPortfolio();
        this.error = "";
        this.redraw(cx);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.redraw(cx);
      }
    });
  }

  async refreshPortfolio() {
    // Keep authenticated reads sequential: if both discover an expired access
    // token together, two refresh-token rotations could race.
    const account = await get("/v1/asset/account", { currency: "USD" });
    const positions = await get("/v1/asset/stock");
    let exchangeRates = null;
    try {
      exchangeRates = await get("/v1/asset/exchange_rates");
    } catch (_) {
      // The account snapshot is already USD. Native-currency holdings remain
      // visibly unpriced until the optional exchange-rate read succeeds.
    }
    this.account = firstRecord(account);
    this.fxRates = normalizeUsdRates(exchangeRates);
    this.holdings = normalizeHoldings(positions);
    const previous = new Map(this.portfolioQuotes.map((quote) => [quote.symbol, quote]));
    this.portfolioQuotes = initialQuotes(
      this.holdings.map((holding) => {
        const [code, market = ""] = holding.symbol.split(".");
        return {
          symbol: holding.symbol,
          code,
          name: holding.name,
          market,
          currency: holding.currency,
        };
      }),
    ).map((quote) => previous.get(quote.symbol) ?? quote);
  }

  /** @param {"light" | "dark"} mode @param {import("gpui-kit").Context} cx */
  chooseTheme(mode, cx) {
    if (this.followsSystemTheme) return;
    if (themes) {
      set_theme(themes[mode]);
      this.chartThemeRevision += 1;
      this.syncPriceChartView();
    }
    this.redraw(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  toggleFps(cx) {
    this.fpsVisible = !this.fpsVisible;
    const visible = this.fpsVisible;
    cx.spawn(async () => saveFpsVisible(visible));
    this.redraw(cx);
  }

  /** @param {string} value @param {string} what @param {import("gpui-kit").Context} cx */
  copyAuthorization(value, what, cx) {
    cx.write_to_clipboard(value);
    window.push_toast({ title: `${what} copied`, level: "success", id: "authorization-copy" });
  }

  /** @param {import("gpui-kit").Context} cx */
  signOut(cx) {
    this.authorizationGeneration = (this.authorizationGeneration ?? 0) + 1;
    const stream = this.stream;
    if (stream) cx.spawn(() => stream.stop());
    this.stream = null;
    this.stopTradeStream();
    this.streamGeneration += 1;
    this.sessionContext = null;
    this.connectedToken = null;
    this.authorization = null;
    this.account = null;
    this.fxRates = new Map([["USD", 1]]);
    this.holdings = [];
    this.initOrdersState();
    this.status = { state: "offline" };
    this.streamError = "";
    this.hasStoredTokens = false;
    this.instruments = [];
    this.quotes = [];
    this.portfolioQuotes = [];
    this.selectedSymbol = null;
    this.clearDetailMarket();
    this.depthCache?.clear();
    this.candleCache.clear();
    this.chartCache?.clear();
    this.chartGeneration += 1;
    this.chartState = { symbol: null, state: "idle" };
    this.releasePriceChartView();
    cx.spawn(async () => {
      await clearTokens();
    });
    this.redraw(cx);
  }

  /**
   * The workspace's actions, in the order the keymap above names them.
   *
   * Each is registered on the root rather than on the control it affects: an
   * action is dispatched down the focus path, and the root is the one element
   * every chord can reach whatever has the keyboard.
   *
   * @param {import("gpui-kit").Element} element
   */
  workspaceActions(element) {
    return element
      .on_action("workspace::watchlist", (_event, cx) => this.showPage("watchlist", cx))
      .on_action("workspace::portfolio", (_event, cx) => this.showPage("portfolio", cx))
      .on_action("workspace::orders", (_event, cx) => this.showPage("orders", cx))
      .on_action("workspace::show-shortcuts", (_event, cx) => {
        this.shortcutHelpOpen = true;
        this.shortcutHelpFocus.focus();
        this.redraw(cx);
      })
      .on_action("workspace::reconnect", (_event, cx) => this.resume(cx))
      .when(!this.followsSystemTheme, (workspace) =>
        workspace.on_action("workspace::toggle-theme", (_event, cx) =>
          this.chooseTheme(cx.theme().appearance === "dark" ? "light" : "dark", cx),
        ),
      )
      .on_action("workspace::toggle-fullscreen", () => window.toggle_fullscreen())
      .on_action("collection::next", (_event, cx) => this.stepSelection(1, cx))
      .on_action("collection::previous", (_event, cx) => this.stepSelection(-1, cx))
      .on_action("collection::first", (_event, cx) => this.selectCollectionBoundary(false, cx))
      .on_action("collection::last", (_event, cx) => this.selectCollectionBoundary(true, cx))
      .on_action("collection::activate", (_event, cx) => this.activateCollection(cx))
      .on_action("trade::buy", (_event, cx) => this.openTicketForSelection("Buy", cx))
      .on_action("trade::sell", (_event, cx) => this.openTicketForSelection("Sell", cx))
      .on_action("workspace::dismiss", (_event, cx) => this.dismiss(cx));
  }

  /**
   * Escape, and what it means here.
   *
   * The workspace claims it only when it has something to put away. When it
   * has not, `cx.propagate()` hands the action back so it carries on to
   * whatever is further out — which is how one chord serves a script-drawn
   * surface and base's own overlays without either knowing about the other.
   *
   * @param {import("gpui-kit").Context} cx
   */
  dismiss(cx) {
    this.syncDialogFlags();
    if (this.shortcutHelpOpen) {
      this.shortcutHelpOpen = false;
      this.workspaceFocus.focus();
      this.redraw(cx);
      return;
    }
    if (this.calendarOpen) {
      this.calendarOpen = false;
      this.redraw(cx);
      return;
    }
    if (this.userMenuOpen || this.allocationHelpOpen) {
      this.userMenuOpen = false;
      this.allocationHelpOpen = false;
      this.redraw(cx);
      return;
    }
    if (this.rowMenu) {
      this.rowMenu = null;
      this.redraw(cx);
      return;
    }
    if (this.ticket.open) {
      this.closeTicket(cx);
      return;
    }
    if (this.addSymbolOpen) {
      this.closeAddSymbol(cx);
      return;
    }
    if (this.page === "orders" && this.selectedOrderId) {
      this.selectedOrderId = null;
      this.redraw(cx);
      return;
    }
    const filter = this.pageFilter();
    if (filter.query) {
      filter.clear();
      this.redraw(cx);
      return;
    }
    cx.propagate();
  }

  /**
   * The list filter belonging to the page on screen: the handle, what it
   * currently holds, and how to empty the copy this view renders from.
   */
  pageFilter() {
    if (this.page === "portfolio") {
      return {
        query: this.holdingsQuery,
        clear: () => {
          this.holdingsFilter.set_value("");
          this.holdingsQuery = "";
        },
      };
    }
    if (this.page === "orders") {
      // Both, because Escape puts away what the page is narrowed by and the
      // page is narrowed by either of them.
      return {
        query: this.todayOrdersQuery || this.historyOrdersQuery,
        clear: () => {
          this.todayOrdersFilter.set_value("");
          this.todayOrdersQuery = "";
          this.historyOrdersFilter.set_value("");
          this.historyOrdersQuery = "";
        },
      };
    }
    return {
      query: this.watchlistQuery,
      clear: () => {
        this.watchlistFilter.set_value("");
        this.watchlistQuery = "";
      },
    };
  }

  /** @param {LongbridgePage} page @param {import("gpui-kit").Context} cx */
  showPage(page, cx) {
    if (this.page === page) return;
    this.page = page;
    if (page === "portfolio") this.loadPortfolio(cx);
    if (page === "orders") this.loadOrders(cx);
    this.redraw(cx);
  }

  /** Moves the selection through the active collection's visible ordering. */
  stepSelection(delta, cx) {
    const collection = this.activeCollection();
    const { rows } = collection;
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => collection.key(row) === collection.selected);
    const next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
    collection.select(collection.key(rows[next]), cx);
    collection.scroll.scroll_to_item(next);
  }

  /** Selects the first or last row in the active visible collection. */
  selectCollectionBoundary(last, cx) {
    const collection = this.activeCollection();
    const { rows } = collection;
    if (rows.length === 0) return;
    const index = last ? rows.length - 1 : 0;
    const row = rows[index];
    collection.select(collection.key(row), cx);
    if (last) collection.scroll.scroll_to_bottom();
    else collection.scroll.scroll_to_item(0, "top");
  }

  /** The visible rows and selection owner for the page currently on screen. */
  activeCollection() {
    if (this.page === "portfolio") {
      const rows = filterRows(
        portfolioPresentation(
          this.holdings,
          [...this.quotes, ...this.portfolioQuotes],
          this.fxRates,
        ).holdings,
        this.holdingsQuery,
        ["symbol", "name"],
      );
      return {
        rows,
        selected: this.selectedHoldingSymbol,
        key: (row) => row.symbol,
        scroll: this.collectionScrollHandles.holdings,
        select: (symbol, cx) => {
          this.selectedHoldingSymbol = symbol;
          this.redraw(cx);
        },
      };
    }
    if (this.page === "orders") {
      const today = filterRows(this.ordersState.today, this.todayOrdersQuery, ORDER_FILTER_FIELDS);
      const history = filterRows(
        this.ordersState.history,
        this.historyOrdersQuery,
        ORDER_FILTER_FIELDS,
      );
      const selectedInToday = today.some((row) => row.orderId === this.selectedOrderRowId);
      const selectedInHistory = history.some((row) => row.orderId === this.selectedOrderRowId);
      const list = selectedInHistory
        ? "history"
        : selectedInToday
          ? "today"
          : today.length
            ? "today"
            : "history";
      this.activeOrdersList = list;
      const rows = list === "today" ? today : history;
      return {
        rows,
        selected: this.selectedOrderRowId,
        key: (row) => row.orderId,
        scroll: this.collectionScrollHandles[`${list}-orders`],
        select: (orderId, cx) => {
          this.selectedOrderRowId = orderId;
          this.redraw(cx);
        },
      };
    }
    return {
      rows: filterRows(this.quotes, this.watchlistQuery, ["code", "name", "symbol"]),
      selected: this.selectedWatchlistSymbol ?? this.selectedSymbol,
      key: (row) => row.symbol,
      scroll: this.collectionScrollHandles.watchlist,
      select: (symbol, cx) => {
        this.selectedWatchlistSymbol = symbol;
        this.redraw(cx);
      },
    };
  }

  /** Activates the selected row's primary command. */
  activateCollection(cx) {
    const collection = this.activeCollection();
    const selected = collection.selected;
    if (!selected || !collection.rows.some((row) => collection.key(row) === selected)) return;
    if (this.page === "portfolio") {
      if (!this.quotes.some((quote) => quote.symbol === selected)) return;
      this.selectQuote(selected, cx);
      this.showPage("watchlist", cx);
      return;
    }
    if (this.page === "orders") {
      this.selectedOrderRowId = selected;
      this.selectedOrderId = selected;
      this.redraw(cx);
      return;
    }
    this.selectedWatchlistSymbol = selected;
    this.selectQuote(selected, cx);
  }

  /**
   * Every chord the workspace sees, for the footer's readout.
   *
   * `keystroke` is the whole chord already unparsed — `"ctrl-shift-f"` — which
   * is the form a comparison is written against, and it is spelled the same on
   * every platform.
   *
   * `is_held` is only on the press half, which is the shape of the question:
   * a release is not held by definition.
   *
   * @param {import("gpui-kit").KeyEvent} event
   * @param {boolean} down
   * @param {import("gpui-kit").Context} cx
   */
  observeKey(event, down, cx) {
    const held = down && Boolean(event.is_held);
    if (event.keystroke === this.lastKeystroke && down === this.keyDown && held === this.keyHeld) {
      return;
    }
    this.lastKeystroke = event.keystroke;
    this.keyDown = down;
    this.keyHeld = held;
    this.redraw(cx);
  }

  /** @param {import("gpui-kit").ModifiersChangedEvent} event @param {import("gpui-kit").Context} cx */
  observeModifiers(event, cx) {
    const down = MACOS ? Boolean(event.modifiers.platform) : Boolean(event.modifiers.control);
    if (down === this.primaryModifierDown) return;
    this.primaryModifierDown = down;
    this.redraw(cx);
  }

  /**
   * Whether the primary button is down, which nothing else can answer: a click
   * is reported once, after the release, and says nothing about the interval
   * between the two.
   *
   * @param {boolean} down @param {import("gpui-kit").Context} cx
   */
  observePointer(down, cx) {
    if (this.pointerDown === down) return;
    this.pointerDown = down;
    this.redraw(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  render(cx) {
    const tokens = cx.theme();
    // A dialog outlives the render that opened it and is handed no context of
    // its own, so the palette it draws in is the one this pass resolved.
    this.tokens = tokens;
    // The shell owns a dialog once it is up -- Escape and the backdrop close
    // it without telling anyone -- so the view reconciles rather than assumes.
    if (this.addSymbolOpen && !window.has_active_dialog()) this.forgetAddSymbol();
    return this.workspaceActions(
      div()
        .id("workspace-root")
        .key_context("Workspace")
        .tab_index(0)
        .track_focus(this.workspaceFocus)
        .on_key_down((event, cx) => this.observeKey(event, true, cx))
        .on_key_up((event, cx) => this.observeKey(event, false, cx))
        .on_modifiers_changed((event, cx) => this.observeModifiers(event, cx))
        .on_mouse_down("left", (_event, cx) => this.observePointer(true, cx))
        .on_mouse_up("left", (_event, cx) => this.observePointer(false, cx)),
    )
      .relative()
      .size_full()
      .child(
        v_flex()
          .w_full()
          .h_full()
          .bg(tokens.background)
          // The title bar reaches both edges and the window's very top, because
          // it *is* the window's top: there is no system one behind it. Only
          // what is under it is inset.
          .child(this.titleBar(tokens))
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              // One inset on all four sides. The title bar is the window's top
              // edge, so the gap under it is this window's top gap -- drawn at
              // the same width as the three the panes keep from the frame.
              .p(PANE_INSET)
              .gap(tokens.spacing.sm)
              .child(
                // The performance overlay is anchored in *this* box rather than
                // in the window, which is what keeps it off the footer. Anchored
                // to the window it sat in the bottom-left corner, on top of
                // "Read only · Trading disabled"; anchored here it stops where
                // the workspace stops, which is the row above.
                v_flex()
                  .relative()
                  .flex_1()
                  .min_h(0)
                  .child(this.hasStoredTokens ? this.workspace(tokens) : this.loginGate(tokens))
                  .when(this.fpsVisible, (element) =>
                    element.child(fps_monitor().anchor("bottom_left")),
                  ),
              )
              .when(this.statusBarVisible, (element) => element.child(this.footer(tokens))),
          ),
      )
      .when(this.shortcutHelpOpen, (element) => element.child(this.shortcutHelp(tokens)));
  }

  /** The discoverable view of the same records installed by `initKeyboard`. */
  shortcutHelp(tokens) {
    return div()
      .id("keyboard-shortcuts-overlay")
      .key_context("ShortcutHelp")
      .tab_index(0)
      .track_focus(this.shortcutHelpFocus)
      .on_action("shortcut-help::retain-focus", (_event, cx) => {
        this.shortcutHelpFocus.focus();
        cx.stop_propagation();
      })
      .absolute()
      .inset_0()
      .flex()
      .items_center()
      .justify_center()
      .bg(tokens.background)
      .child(
        v_flex()
          .id("keyboard-shortcuts")
          .w(420)
          .max_h(560)
          .gap(tokens.spacing.sm)
          .p(tokens.spacing.md)
          .bg(tokens.surface)
          .border(1)
          .border_color(tokens.border)
          .child(label(tokens, "Keyboard shortcuts", "heading").font_weight(700))
          .children(
            KEY_BINDINGS.filter((binding) => Boolean(binding.caption)).map((binding) =>
              h_flex()
                .items_center()
                .justify_between()
                .gap(tokens.spacing.md)
                .child(label(tokens, binding.caption))
                .child(kbd(tokens, binding.display ?? chordLabel(binding.keystroke))),
            ),
          )
          .child(muted(tokens, "Press Escape to close")),
      );
  }

  /**
   * The window's own title bar. There is no system one behind it: the host
   * opens the window with a transparent title bar, so this row is both the
   * application's chrome and the strip the window is dragged by.
   *
   * Three tracks, and the outer two share a width so the middle one is centered
   * on the window rather than on whatever is left over: identity on the left,
   * the page switch in the middle, the session's own controls on the right.
   * `titleBarLeading` is the room macOS needs for the traffic lights, which
   * are drawn over this corner by the system.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  titleBar(tokens) {
    const status = statusColors(tokens);
    return (
      h_flex()
        .id("window-title-bar")
        .flex_none()
        .h(TITLE_BAR_HEIGHT)
        .w_full()
        .items_center()
        .gap(tokens.spacing.md)
        // Symmetric, so the page switch between the two tracks is centred on the
        // window rather than on a box that has been pushed right. The room macOS
        // needs for its traffic lights is the *left track's* padding, below: as
        // padding here it inset the content box on one side only, and the middle
        // came to rest 42 pixels right of centre.
        .px(tokens.spacing.sm)
        .bg(tokens.surface)
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            // The traffic lights are drawn over this corner by the system, so
            // the mark starts after them. On a platform without them this is the
            // ordinary gap.
            .pl(titleBarLeading(tokens) - tokens.spacing.sm)
            // The mark and the name are one lockup, so they sit on a shared
            // baseline. Not `items_center`, which leaves the name floating above
            // the mark's foot, and not `items_end` either: that aligns the *line
            // box*, and a 1.25 line box keeps room under the baseline for
            // descenders, so the mark still ends up sitting low by that much.
            // Baseline alignment puts the mark's foot on the letters' own.
            .items_baseline()
            // 6, not a spacing token: this is the gap inside one lockup, which is
            // an optical fit between a mark and a wordmark rather than a layout
            // step. The scale's neighbours (4 and 8) are both wrong by eye here.
            .gap(6)
            .child(
              div()
                .relative()
                .w(20)
                .h(20)
                .flex_none()
                .accessibility_label("Longbridge")
                .child(
                  svg("assets/logo-foreground.svg")
                    .absolute()
                    .inset_0()
                    .text_color(tokens.foreground),
                )
                .child(
                  svg("assets/logo-info-cyan.svg").absolute().inset_0().text_color(status.info),
                )
                .child(
                  svg("assets/logo-warning.svg").absolute().inset_0().text_color(status.warning),
                )
                .child(svg("assets/logo-danger.svg").absolute().inset_0().text_color(status.down)),
            )
            .child(label(tokens, "Longbridge", "subtitle").font_weight(700)),
        )
        // The switch is only a switch once there is something to switch between,
        // and both pages need a session.
        .when(this.hasStoredTokens, (element) => element.child(this.pageSwitch(tokens)))
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .items_center()
            .justify_end()
            .gap(tokens.spacing.sm)
            .child(connectionPill(tokens, this.status.state))
            .when(!this.followsSystemTheme, (element) =>
              element.child(
                themeButton(tokens, (_event, cx) =>
                  this.chooseTheme(tokens.appearance === "dark" ? "light" : "dark", cx),
                ),
              ),
            )
            // The menu belongs to the session, not to the Watchlist: it signs out
            // and switches theme, and neither is a property of a list. The
            // window's own corner is where a session's controls live.
            .when(this.hasStoredTokens, (element) => element.child(this.userMenu(tokens))),
        )
    );
  }

  /**
   * Native Omarchy tabs own selection styling and pointer activation.
   * Page shortcuts remain application commands.
   * @param {import("gpui-base").Theme} tokens
   */
  pageSwitch(tokens) {
    return Tabs.new("workspace-tabs")
      .axis("horizontal")
      .accessibility_label("Pages")
      .flex()
      .items_center()
      .flex_none()
      .gap(2)
      .px(tokens.spacing.xs)
      .py(3)
      .bg(tokens.background)
      .border(1)
      .border_color(tokens.border)
      .children(
        PAGES.map((item) => {
          const selected = item.key === this.page;
          return new NativeTab(`page-${item.key}`, item.caption, selected)
              .on_click((_event, cx) => this.showPage(item.key, cx))
              .flex()
              .relative()
              .items_center()
              .justify_center()
              .h(24)
              .py(0)
              .px(tokens.spacing.md)
            .when(this.primaryModifierDown, (tab) =>
              tab.child(
                div()
                  .id(`page-${item.key}-shortcut`)
                  .absolute()
                  .top(1)
                  .right(3)
                  .text_size(9)
                  .line_height(1)
                  .text_color(selected ? tokens.accent_foreground : tokens.muted_foreground)
                  .child(String(item.shortcut)),
              ),
            );
        }),
      );
  }

  /**
   * Whether the window is short enough to stack the Watchlist over the
   * details rather than putting them side by side.
   *
   * `window.viewport_size()` is legal from `render`, which is where the
   * question is asked — a view that sizes itself from the window has to ask
   * during the pass that draws it. It is asked rather than remembered because
   * a value cached on the view would be a frame behind every resize.
   *
   * A resize is not itself an invalidation: a script view renders when it is
   * notified, not on every frame, and the runtime reports no resize event. So
   * the switch lands on the next notification — which, while a session is
   * live, is the clock a tick later at worst.
   */
  isNarrow() {
    return window.viewport_size().width < NARROW_VIEWPORT;
  }

  /**
   * Estimate the center region once per Watchlist paint. The result is passed
   * into every virtual row, avoiding the per-row host sizing calls that cut
   * Release throughput while still letting a wide Watchlist show its columns.
   */
  isWatchlistCompact() {
    return responsivePanelWidths(window.viewport_size().width).watchlist < COMPACT_WATCHLIST_WIDTH;
  }

  /** @param {import("gpui-base").Theme} tokens */
  workspace(tokens) {
    // Each page owns its own scrolling. Watchlist is a master-detail layout
    // whose panes scroll independently, and Portfolio is one long column — a
    // shared scroll container above them would either clip the panes or nest a
    // second scroll inside the first, which is what made Holdings unreachable
    // in a short window.
    const page =
      this.page === "portfolio"
        ? this.portfolioPage(tokens).id("workspace-page")
        : this.page === "orders"
          ? this.ordersPage(tokens).id("workspace-page")
          : this.watchlistPage(tokens);
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(tokens.spacing.sm)
      .when(Boolean(this.error), (element) =>
        element.child(
          h_flex()
            .items_center()
            .justify_between()
            .gap(tokens.spacing.sm)
            .child(errorMessage(tokens, this.error).flex_1())
            .child(action(tokens, "retry-connection", "Retry", (_event, cx) => this.resume(cx))),
        ),
      )
      .child(motion(page.flex_1().min_h(0), "opacity"));
  }

  /**
   * A workspace pane's outer box. Only the side facing the other pane is
   * inset: together they form an 8px center gap without changing the window's
   * own 8px outer margin.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {"left" | "right"} facing Which side the other pane is on.
   */
  pane(tokens, facing) {
    // `flex_1().min_h(0)`, not `size_full()`. A percentage height only resolves
    // against a parent whose own height is already definite; where it is not,
    // `height: 100%` collapses to auto and every `flex_1` child inside falls
    // back to its content height -- the pane floating at the top of an empty
    // region. Growing into the parent's main axis asks for no such resolution.
    return v_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .bg(tokens.background)
      .when(facing === "left", (element) => element.pl(PANE_INSET))
      .when(facing === "right", (element) => element.pr(PANE_INSET));
  }

  /** @param {import("gpui-base").Theme} tokens */
  loginGate(tokens) {
    return h_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .p(tokens.spacing.lg)
      .child(v_flex().w(400).child(this.authPanel(tokens)));
  }

  /** Four plain Panels, ordered by information priority and responsive by width. */
  watchlistPage(tokens) {
    const { sideBySide } = responsivePanelWidths(window.viewport_size().width);
    const watchlist = workspacePanel(tokens, "Watchlist", this.watchlist(tokens));
    // Quote Details is a fixed block of readings, so it takes its own height
    // in both layouts and the column around it does the scrolling. Grown to
    // fill a tall window it drew a band of empty panel under its last row;
    // pinned to a stated height it clipped the disclosure when that opened.
    const quote = workspacePanel(tokens, "Quote Details", this.quoteDetailsPanel(tokens), null, {
      grow: false,
    });
    const chart = workspacePanel(
      tokens,
      "Chart",
      this.chartDetailsPanel(tokens),
      this.chartModeTabs(tokens),
      { grow: false },
    );
    const market = workspacePanel(tokens, "Market Detail", this.marketDetailPanel(tokens), null, {
      grow: false,
    });
    if (!sideBySide) {
      return v_flex()
        .id("watchlist-panels-stacked")
        .flex_1()
        .min_h(0)
        .gap(WORKSPACE_PANEL_GAP)
        .overflow_y_scrollbar()
        .child(watchlist.h(440).flex_none())
        .child(quote.flex_none())
        .child(chart.min_h(320).flex_none())
        .child(market.min_h(360).flex_none());
    }

    return h_flex()
      .id("watchlist-panels")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .items_stretch()
      .gap(WORKSPACE_PANEL_GAP)
      .child(watchlist.flex_basis(0).flex_grow(6).min_w(WATCHLIST_MIN_WIDTH).min_h(0))
      .child(
        v_flex()
          .id("detail-panels")
          .flex_basis(0)
          .flex_grow(4)
          .min_w(RESPONSIVE_DETAIL_MIN_WIDTH)
          .min_h(0)
          .gap(WORKSPACE_PANEL_GAP)
          .overflow_y_scrollbar()
          .child(quote.flex_none())
          .child(chart.min_h(290).flex_none())
          .child(market.min_h(200).flex_none()),
      );
  }

  /**
   * The way to put something on the watchlist: a symbol, typed.
   *
   * There is no search behind it because there is no search endpoint on this
   * boundary, and a client that guessed at what was meant would be adding
   * securities nobody asked for. What it does instead is state the shape --
   * code, dot, market -- refuse anything that is not that shape before the
   * request, and say what Longbridge said when the request is refused.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  addSymbolTrigger(tokens) {
    return iconAction(
      tokens,
      "add-symbol-trigger",
      "Add a security",
      "assets/plus.svg",
      (_event, cx) => this.openAddSymbol(cx),
    );
  }

  /**
   * The add-a-security dialog.
   *
   * A dialog rather than a popover: this is a short task with a decision at
   * the end of it -- type, read what it turned out to be, confirm or think
   * again -- and a surface that closes when the pointer wanders is the wrong
   * shape for one. It is also the only thing on screen while it is open, which
   * is what lets the keyboard go straight into the field.
   *
   * `open_dialog` takes a function, not an element: the dialog outlives the
   * pass that opened it and redraws from this on every notify.
   *
   * @param {import("gpui-kit").Context} cx
   */
  openAddSymbol(cx) {
    // The add-a-security dialog is dismissable the same two ways, and its flag
    // goes stale the same way -- this is the pre-existing case of the same
    // defect, not a new one.
    this.syncDialogFlags();
    if (this.addSymbolOpen || this.ticket.open) return;
    this.addSymbolOpen = true;
    this.addSymbolError = "";
    this.addSymbolPending = false;
    this.symbolQuery = "";
    this.symbolInput.set_value("");
    this.symbolPreviewGeneration += 1;
    this.symbolPreview = { status: "idle", symbol: "", error: "" };
    window.open_dialog(() => this.addSymbolDialog(this.tokens), {
      escape_dismissable: true,
      backdrop_dismissable: true,
    });
    this.redraw(cx);
  }

  /**
   * Redraws the open dialog.
   *
   * A dialog is its own view, built from a function the shell calls when *it*
   * renders -- so `cx.notify()` here reaches the workspace and never the
   * dialog, which is how a typed symbol could be previewed into a panel nobody
   * was drawing. There is no handle to notify instead: `open_dialog` answers a
   * depth, not a view. `window.refresh()` is the case its own documentation
   * names, and it is called on a change to what the dialog says -- three times
   * for a typed symbol, not once per keystroke.
   */
  refreshDialog() {
    if (this.addSymbolOpen) window.refresh();
  }

  /** Publishes a preview, and redraws the dialog that is showing it. */
  setSymbolPreview(preview) {
    this.symbolPreview = preview;
    this.refreshDialog();
  }

  /** Drops what the dialog was holding, without touching the shell's stack. */
  forgetAddSymbol() {
    this.addSymbolOpen = false;
    this.addSymbolPending = false;
    this.addSymbolError = "";
    this.symbolPreviewGeneration += 1;
    this.symbolPreview = { status: "idle", symbol: "", error: "" };
  }

  /** @param {import("gpui-kit").Context} cx */
  closeAddSymbol(cx) {
    if (!this.addSymbolOpen) return;
    this.forgetAddSymbol();
    window.close_dialog();
    this.redraw(cx);
  }

  /**
   * The order ticket, in whichever of its two stages it is in.
   *
   * One dialog rather than two, because it is one task: the second stage is
   * what the first stage said, and a reader who presses Back is still filling
   * in the same ticket.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  ticketDialog(tokens) {
    const ticket = this.ticket;
    return (
      v_flex()
        .id("order-ticket-dialog")
        // The confirmation has no field to press Enter in, so the surface holds
        // the keyboard itself. `track_focus` is half of `on_key_down`: without
        // it the handler sits on an element the keyboard never reaches.
        .track_focus(this.ticketFocus)
        .tab_index(0)
        .on_key_down((event, cx) => {
          if (String(event.keystroke ?? "") !== "enter") return;
          // A field's own Enter already advanced the ticket -- letting this one
          // run too would review and then send in a single press.
          if (this.ticket.stage !== "review") return;
          cx.stop_propagation();
          this.advanceTicket(cx);
        })
        .w(380)
        .gap(tokens.spacing.md)
        .p(tokens.spacing.lg)
        .border(1)
        .border_color(tokens.border)
        .bg(tokens.surface)
        .child(
          ticketHeading(
            tokens,
            ticket.mode === "cancel" ? "Withdraw" : ticket.side,
            ticket.symbol,
            ticket.name,
          ),
        )
        .child(
          ticket.stage === "form" ? this.ticketFormBody(tokens) : this.ticketReviewBody(tokens),
        )
        .when(Boolean(ticket.error), (element) => element.child(errorMessage(tokens, ticket.error)))
        .child(this.ticketButtons(tokens))
    );
  }

  /** @param {import("gpui-base").Theme} tokens */
  ticketFormBody(tokens) {
    const ticket = this.ticket;
    const limit = isLimitOrder(ticket.type);
    const byAmount = ticket.sizing === "amount";
    const canSizeByAmount = supportsAmountSizing(ticket.side);
    const sellable = ticket.side === "Sell" ? this.sellableQuantity(ticket.symbol) : null;
    const lot = ticket.lotSize ?? 1;
    const reference = limit
      ? Number(this.ticketPrice.value())
      : (this.lastTradedPrice(ticket.symbol) ?? 0);
    // The running conversion, shown while the amount is still editable. It
    // goes through the same function the validation uses, so what is previewed
    // here and what is sent cannot drift apart.
    const fractional = allowsFractionalShares({
      symbol: ticket.symbol,
      outsideRth: hasExtendedHours(ticket.symbol)
        ? ticket.outsideRth
          ? ANY_TIME
          : RTH_ONLY
        : null,
    });
    const shares = byAmount
      ? sharesForAmount(Number(this.ticketAmount.value()), reference, ticket.lotSize, fractional)
      : 0;
    return (
      v_flex()
        // Three sizes of gap, and the order between them is what carries the
        // grouping: parts of a field are closest, fields within a group are
        // next, and the two groups are furthest apart. Equal gaps would say
        // these are all the same kind of decision.
        .gap(tokens.spacing.lg)
        // What is being traded. The two fields a reader actually decides --
        // the price and the size -- are the widest things on the surface and
        // sit under their own labels, rather than being pushed to the far edge
        // of a caption row.
        .child(
          ticketGroup(tokens, "Order", true)
            .child(
              ticketField(
                tokens,
                "Type",
                segmented(tokens, "ticket-type", ORDER_TYPES, ticket.type, (value) =>
                  this.updateTicket({ type: value }),
                ),
              ),
            )
            .child(
              ticketField(
                tokens,
                "Price",
                // A market order has no price, and an empty box where one
                // belongs invites someone to fill it in. The field is replaced
                // by what the order will actually use.
                limit
                  ? valueField(tokens, this.ticketPrice, { unit: ticket.currency }).h(28)
                  : muted(tokens, "At the market price when it fills"),
                { error: ticket.errors.price },
              ),
            )
            .child(
              byAmount
                ? ticketField(
                    tokens,
                    "Amount",
                    valueField(tokens, this.ticketAmount, { unit: ticket.currency }).h(28),
                    {
                      error: ticket.errors.amount,
                      // The share count the amount works out to, under the field
                      // that decides it -- the order is placed in shares, so this
                      // is the number actually being sent.
                      hint: shares > 0 ? `Buys ${shares} ${shares === 1 ? "share" : "shares"}` : "",
                      accessory: this.sizingSwitch(tokens, canSizeByAmount),
                    },
                  )
                : ticketField(
                    tokens,
                    "Quantity",
                    valueField(tokens, this.ticketQuantity, { unit: "shares" }).h(28),
                    {
                      error: ticket.errors.quantity,
                      // What the field has to respect, said before it is typed
                      // into rather than only when it is refused.
                      hint: [
                        lot > 1 ? `In multiples of ${lot}` : "",
                        sellable === null ? "" : `${sellable} available to sell`,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      accessory: this.sizingSwitch(tokens, canSizeByAmount),
                    },
                  ),
            ),
        )
        // How long the order stands, and where it may fill. Both are choices
        // about the order's existence rather than its content, and separating
        // them is what stops six evenly spaced rows reading as six equal
        // decisions.
        .child(
          ticketGroup(tokens, "Duration")
            .child(
              ticketField(
                tokens,
                "Valid",
                segmented(tokens, "ticket-tif", TIME_IN_FORCE, ticket.timeInForce, (value) =>
                  this.updateTicket({ timeInForce: value }),
                ),
              ),
            )
            .when(hasExtendedHours(ticket.symbol), (element) =>
              element.child(
                ticketField(
                  tokens,
                  "Sessions",
                  segmented(
                    tokens,
                    "ticket-rth",
                    [
                      { value: "rth", label: "Regular" },
                      { value: "any", label: "Pre/post" },
                    ],
                    ticket.outsideRth ? "any" : "rth",
                    (value) => this.updateTicket({ outsideRth: value === "any" }),
                  ),
                ),
              ),
            ),
        )
        .when(Boolean(ticket.errors.form), (element) =>
          element.child(errorMessage(tokens, ticket.errors.form)),
        )
    );
  }

  /**
   * The switch between typing a share count and typing a sum of money.
   *
   * It sits on the field's own caption row rather than taking a row of its
   * own: it is not a third decision beside price and size, it is how the size
   * is being said. Selling does not get it -- a sale disposes of shares, and
   * a proceeds figure is not something an order can be given.
   *
   * @param {import("gpui-base").Theme} tokens @param {boolean} enabled
   */
  sizingSwitch(tokens, enabled) {
    if (!enabled) return null;
    // One control naming the other mode, not two competing for a selected
    // state. Two of them were a segmented control in a caption row, which is
    // not what a caption row is for -- and the selected one drew no border
    // while its neighbour and every hover drew one, so the pair changed width
    // as the pointer crossed it.
    //
    // The field's own label already says which mode is in force. What is left
    // to offer is the way out of it, which is one button and reads as a
    // sentence: `Amount` above the field, `Use shares` beside it.
    const other = this.ticket.sizing === "amount" ? "shares" : "amount";
    const caption = other === "amount" ? "Use amount" : "Use shares";
    return action(
      tokens,
      "ticket-sizing",
      caption,
      (_event, _cx) => this.updateTicket({ sizing: other }),
      { quiet: true },
    ).h(20);
  }

  /** @param {import("gpui-base").Theme} tokens */
  ticketReviewBody(tokens) {
    const ticket = this.ticket;
    if (ticket.mode === "cancel") {
      return v_flex()
        .gap(tokens.spacing.sm)
        .child(muted(tokens, "This order will be withdrawn."))
        .child(
          v_flex()
            .gap(tokens.spacing.xs)
            .p(tokens.spacing.sm)
            .bg(tokens.background)
            .child(
              h_flex()
                .items_baseline()
                .gap(tokens.spacing.xs)
                .child(
                  label(tokens, String(ticket.side).toUpperCase(), "title").text_color(
                    tradeSideTone(tokens, ticket.side),
                  ),
                )
                .child(label(tokens, ticket.symbol, "title")),
            )
            .child(muted(tokens, `Order ${ticket.orderId}`)),
        );
    }
    return orderConfirmSummary(
      tokens,
      ticketSummary(ticket.review, { currency: ticket.currency, name: ticket.name }),
    );
  }

  /** @param {import("gpui-base").Theme} tokens */
  ticketButtons(tokens) {
    const ticket = this.ticket;
    const pending = ticket.pending;
    const confirming = ticket.stage === "review";
    const verb =
      ticket.mode === "cancel" ? "Withdraw" : ticket.mode === "replace" ? "Update" : "Confirm";
    return h_flex()
      .justify_end()
      .gap(tokens.spacing.sm)
      .child(
        action(
          tokens,
          "ticket-back",
          // Back on a ticket that had a form to go back to; Cancel on the
          // withdrawal, which opened straight into its confirmation and has
          // nothing behind it.
          confirming && ticket.mode !== "cancel" ? "Back" : "Cancel",
          (_event, cx) =>
            confirming && ticket.mode !== "cancel" ? this.backToTicketForm() : this.closeTicket(cx),
          { disabled: pending },
        ),
      )
      .child(
        confirming
          ? action(
              tokens,
              "ticket-confirm",
              pending ? "Sending…" : verb,
              (_event, cx) => this.confirmTicket(cx),
              {
                variant: ticket.mode === "cancel" ? "destructive" : "primary",
                disabled: pending,
              },
            )
          : action(tokens, "ticket-review", "Review", (_event, cx) => this.reviewTicket(cx), {
              variant: "primary",
              disabled: pending,
            }),
      );
  }

  /** @param {import("gpui-base").Theme} tokens */
  addSymbolDialog(tokens) {
    const pending = this.addSymbolPending;
    const ready = this.symbolPreview.status === "ready";
    return v_flex()
      .id("add-symbol-dialog")
      .w(360)
      .gap(tokens.spacing.md)
      .p(tokens.spacing.lg)
      .border(1)
      .border_color(tokens.border)
      .bg(tokens.surface)
      .child(
        v_flex()
          .gap(tokens.spacing.xxs)
          .child(label(tokens, "Add to watchlist", "title").font_weight(700))
          .child(muted(tokens, "A code, a dot and its market: AAPL.US, 700.HK, 000001.SZ.")),
      )
      .child(filterInput(tokens, this.symbolInput, 320))
      .child(this.symbolPreviewCard(tokens))
      .when(Boolean(this.addSymbolError), (element) =>
        element.child(errorMessage(tokens, this.addSymbolError)),
      )
      .child(
        h_flex()
          .justify_end()
          .gap(tokens.spacing.sm)
          .child(
            action(tokens, "add-symbol-cancel", "Cancel", (_event, cx) => this.closeAddSymbol(cx)),
          )
          .child(
            action(
              tokens,
              "add-symbol-confirm",
              pending ? "Adding…" : "Add",
              (_event, cx) => this.addSymbol(cx),
              { variant: "primary", disabled: pending || !ready },
            ),
          ),
      );
  }

  /**
   * What the typed symbol turned out to be.
   *
   * Four things can be true of a field someone is typing into -- it is not a
   * symbol yet, it is one and is being looked up, it named a security, or it
   * named nothing -- and each of them is a different thing to say. The last
   * two are why this exists: `NVDA.US` and `NVDA.HK` are both well-formed, and
   * only one of them is a company.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  symbolPreviewCard(tokens) {
    const preview = this.symbolPreview;
    if (preview.status === "idle") return muted(tokens, "Nothing typed yet.");
    if (preview.status === "loading") return muted(tokens, `Looking up ${preview.symbol}…`);
    if (preview.status === "error") return errorMessage(tokens, preview.error);
    const held = this.quotes.some((quote) => quote.symbol === preview.symbol);
    return v_flex()
      .id("add-symbol-preview")
      .gap(tokens.spacing.xs)
      .p(tokens.spacing.sm)
      .bg(tokens.background)
      .child(
        h_flex()
          .items_start()
          .justify_between()
          .gap(tokens.spacing.sm)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(tokens.spacing.xxs)
              .child(label(tokens, preview.name, "subtitle").font_weight(700).truncate())
              .child(
                muted(
                  tokens,
                  [preview.symbol, preview.exchange, preview.currency].filter(Boolean).join(" · "),
                ).truncate(),
              ),
          )
          .child(
            v_flex()
              .flex_none()
              .items_end()
              .gap(tokens.spacing.xxs)
              .child(numeric(tokens, preview.last, "heading"))
              .child(
                numeric(tokens, preview.changePercent, "bodySmall").text_color(
                  changeTone(tokens, preview.changePercent),
                ),
              ),
          ),
      )
      .when(held, (element) => element.child(muted(tokens, "Already on the watchlist.")));
  }

  /**
   * A secondary press on a row, as the list reports it.
   *
   * The list hears the press before the pane under it does -- both listen for
   * the same button, and a press bubbles from the row outwards -- so this only
   * notes which row it was. Where to put the menu is the pane's question: the
   * menu is drawn inside the pane at the pane's own coordinates, which the
   * row's event does not carry, and the pane's `on_mouse_down` reads the note
   * in the same dispatch. A note nothing reads -- a press that landed on no
   * row -- is cleared by the next one.
   *
   * @param {"watchlist" | "holdings" | "orders"} source
   * @param {string} key
   */
  noteRowPress(source, key) {
    this.pressedRow = { source, key };
  }

  /**
   * The row the press being dispatched landed on, if it landed on one of
   * `source`'s rows, and clears the note either way.
   *
   * @param {"watchlist" | "holdings" | "orders"} source
   */
  takeRowPress(source) {
    const pressed = this.pressedRow;
    this.pressedRow = null;
    return pressed?.source === source ? pressed.key : null;
  }

  /**
   * Opens the row menu at the pointer, for the row that was pressed.
   *
   * Pressed rather than selected: a menu that acted on the selected row while
   * the pointer sat on another was a menu the reader could not trust without
   * reading its heading first. The row is the one the list reported through
   * `noteRowPress` a moment ago; a press that landed between rows opens
   * nothing. The selection does not move -- the two states are drawn apart,
   * see `rowState` in `ui.js` -- so opening a menu on a row is not the same
   * as looking at it.
   *
   * @param {import("gpui-kit").MouseButtonEvent} event @param {import("gpui-kit").Context} cx
   */
  openRowMenu(event, cx) {
    const symbol = this.takeRowPress("watchlist");
    if (!symbol) return;
    const local = event.local_position ?? { x: 0, y: 0 };
    this.rowMenu = {
      symbol,
      x: Math.max(0, local.x),
      y: Math.max(0, local.y),
      source: "watchlist",
    };
    this.redraw(cx);
  }

  /**
   * The same menu, opened from a holding.
   *
   * A holding is an instrument this account owns, so the two trade entries
   * belong on it -- but "Remove" does not: it takes a security off a
   * watchlist, and a holding need not be on one. Offering it here would be a
   * menu item that either does nothing or removes something the reader was
   * not looking at.
   *
   * @param {import("gpui-kit").MouseButtonEvent} event
   * @param {import("gpui-kit").Context} cx
   */
  openHoldingMenu(event, cx) {
    const symbol = this.takeRowPress("holdings");
    if (!symbol) return;
    const local = event.local_position ?? { x: 0, y: 0 };
    this.rowMenu = {
      symbol,
      x: Math.max(0, local.x),
      y: Math.max(0, local.y),
      source: "holdings",
    };
    this.redraw(cx);
  }

  /**
   * The same menu, opened from an order.
   *
   * What can be done to an order depends on how far along it is, so both
   * entries are drawn either way and disabled when they do not apply: a menu
   * whose items come and go is one the reader has to re-read every time.
   *
   * @param {import("gpui-kit").MouseButtonEvent} event
   * @param {import("gpui-kit").Context} cx
   */
  openOrderMenu(event, cx) {
    const orderId = this.takeRowPress("orders");
    const order = [...this.ordersState.today, ...this.ordersState.history].find(
      (entry) => entry.orderId === orderId,
    );
    if (!order) return;
    const local = event.local_position ?? { x: 0, y: 0 };
    this.rowMenu = {
      symbol: order.symbol,
      x: Math.max(0, local.x),
      y: Math.max(0, local.y),
      source: "orders",
      orderId: order.orderId,
    };
    this.redraw(cx);
  }

  /** @param {import("gpui-base").Theme} tokens */
  rowMenuSurface(tokens) {
    const menu = this.rowMenu;
    const order =
      menu.source === "orders"
        ? [...this.ordersState.today, ...this.ordersState.history].find(
            (entry) => entry.orderId === menu.orderId,
          )
        : null;
    const surface = popoverSurface(tokens, "row-menu-surface", { width: 200, menu: true })
      .on_mouse_down_out((_event, cx) => {
        this.rowMenu = null;
        this.redraw(cx);
      })
      .child(muted(tokens, menu.symbol).px(tokens.spacing.sm).py(tokens.spacing.xxs))
      // An order that has finished is offered neither entry. Drawn and
      // disabled, they were two rows of grey saying nothing a reader could
      // act on -- and the status, which is on the row this menu was opened
      // from, already says why. A menu is a list of what can be done.
      .when(Boolean(order) && canReplace(order), (element) =>
        element.child(
          menuItem(tokens, "row-menu-replace", "Modify order…", (_event, cx) =>
            this.openReplaceTicket(order, cx),
          ),
        ),
      )
      .when(Boolean(order) && canCancel(order), (element) =>
        element.child(
          menuItem(
            tokens,
            "row-menu-cancel",
            "Withdraw order",
            (_event, cx) => this.openCancelTicket(order, cx),
            { destructive: true },
          ),
        ),
      )
      .when(menu.source !== "orders", (element) =>
        element
          .child(
            menuItem(
              tokens,
              "row-menu-buy",
              "Buy…",
              (_event, cx) => this.openTicket(menu.symbol, "Buy", cx),
              { tone: tradeSideTone(tokens, "Buy") },
            ),
          )
          .child(
            menuItem(
              tokens,
              "row-menu-sell",
              "Sell…",
              (_event, cx) => this.openTicket(menu.symbol, "Sell", cx),
              { tone: tradeSideTone(tokens, "Sell") },
            ),
          ),
      )
      .child(
        menuItem(tokens, "row-menu-copy", "Copy symbol", (_event, cx) => {
          this.rowMenu = null;
          this.copySymbol(menu.symbol, cx);
        }),
      )
      // Not destructive: taking a security off a watchlist deletes nothing and
      // is undone by adding it back. The role belongs to the things that
      // cannot be, and spending it here leaves nothing louder for them.
      .when(menu.source === "watchlist", (element) =>
        element.child(
          menuItem(tokens, "row-menu-drop", "Remove", (_event, cx) =>
            this.dropSymbol(menu.symbol, cx),
          ),
        ),
      );

    // A real anchored surface rather than an absolutely-placed child.
    //
    // Placed as a child the menu was an ordinary element sitting over the
    // list, so the rows underneath went on receiving the pointer: moving down
    // the menu lit up whichever row happened to be behind each item. `Popup`
    // paints its content in a layer above the window and, since
    // longbridge/gpui-kit#2887, blocks the mouse behind that layer --
    // which is the part a hand-placed element cannot do at all.
    //
    // The trigger is a zero-sized anchor at the pointer, because that is where
    // a context menu belongs and `Popup` anchors to its trigger's bounds. The
    // anchor carries the coordinates now; the surface only says what a menu
    // looks like.
    // The `Popup` itself is what carries the coordinates, not its trigger.
    // Given to the pane as a child it takes a place in the pane's flow -- after
    // every row -- and a trigger positioned inside it anchors the menu to the
    // bottom of the list rather than to the pointer. Positioned here, against
    // the pane's own `relative()`, the trigger is a point at the pointer and
    // the menu opens from it.
    return (
      Popup.new("row-menu", div().w(0).h(0))
        // `top_left`, not `bottom_left`: the anchor names which corner of the
        // menu meets the trigger, so `bottom_left` hung the menu upwards from
        // the pointer and covered the row it was opened on. A context menu
        // grows down and to the right from where the pointer is.
        .anchor("top_left")
        .content(surface)
        .absolute()
        // Offset by one step from the pointer rather than opened under it. A
        // menu whose first row is already beneath the cursor arrives with that
        // row highlighted, which reads as a choice the reader did not make --
        // and is one keypress away from being acted on.
        .left(menu.x + tokens.spacing.xs)
        .top(menu.y + tokens.spacing.xs)
    );
  }

  /** @param {import("gpui-base").Theme} tokens */
  watchlist(tokens) {
    const status = streamStatusSummary({ state: this.status.state, delay: this.status.delay });
    const rows = filterRows(this.quotes, this.watchlistQuery, ["code", "name", "symbol"]);
    const compact = this.isWatchlistCompact();
    return (
      panel(tokens)
        .id("watchlist-pane")
        // No top edge: the tab bar above this pane already draws the line, and
        // two of them at the same seam is a doubled border rather than a
        // stronger one.
        .border_t(0)
        .flex_1()
        .min_h(0)
        // The row menu is drawn inside this pane, at the pointer, so the pane
        // is what its coordinates are measured from.
        .relative()
        // On the pane rather than on whatever holds it: the pane is now a dock
        // panel's whole body, and there is no wrapper left to carry this.
        .on_mouse_down("right", (event, cx) => this.openRowMenu(event, cx))
        .child(
          tableToolbar(tokens, "watchlist-toolbar")
            // No title here. The tab above this row already says "Watchlist",
            // and a pane that names itself twice is two headers wearing one
            // pane. What is left is what the tab cannot carry: the filter, the
            // way to add to the list, and the feed's state.
            .child(filterInput(tokens, this.watchlistFilter))
            .child(
              h_flex()
                .items_center()
                .gap(tokens.spacing.sm)
                .child(muted(tokens, status))
                .child(this.addSymbolTrigger(tokens)),
            ),
        )
        .child(rule(tokens))
        .when(Boolean(this.streamError), (element) =>
          element.child(errorMessage(tokens, streamStatusSummary(this.status))),
        )
        .child(
          this.instrumentTable(
            tokens,
            "watchlist",
            "Watchlist",
            rows,
            QUOTE_ROW_HEIGHT,
            watchlistHeader(tokens, compact),
            (quote, index) =>
              quoteRow(
                tokens,
                quote,
                quote.symbol === (this.selectedWatchlistSymbol ?? this.selectedSymbol),
                index,
                this.lastTick,
                compact,
                this.rowMenu?.source === "watchlist" && this.rowMenu.symbol === quote.symbol,
              ),
            (symbol, cx) => {
              this.selectedWatchlistSymbol = symbol;
              this.selectQuote(symbol, cx);
            },
            this.watchlistQuery
              ? emptyPanel(tokens, "No matches", "Nothing in the watchlist matches that filter.")
              : emptyPanel(
                  tokens,
                  "Watchlist is empty",
                  "Add a security with the + beside the filter, or in Longbridge.",
                ),
            2,
            undefined,
            (symbol) => this.noteRowPress("watchlist", symbol),
          )
            .flex_1()
            .min_h(0),
        )
        .when(this.rowMenu?.source === "watchlist", (element) =>
          element.child(this.rowMenuSurface(tokens)),
        )
    );
  }

  /**
   * A virtualized table: a header row group, and a body whose rows are built
   * during layout for the range on screen.
   *
   * `row_count` describes the whole collection rather than what is drawn —
   * which is exactly what it is for, so a screen reader can say "row 5 of 200"
   * for a window onto a long list. It counts the header, which is row one.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {string} id
   * @param {string} name
   * @param {any[]} rows
   * @param {number} rowHeight
   * @param {import("gpui-kit").Element} header
   * @param {(row: any, index: number) => import("gpui-kit").Element} renderRow
   * @param {((key: string, cx: import("gpui-kit").Context) => void) | null} onSelect
   * @param {import("gpui-kit").Element} empty
   * @param {number} [columnCount]
   * @param {(row: any, index: number) => string} [rowKey] The identity a row is
   *   reported by, which is what `onSelect` and `onSecondaryPress` are handed.
   * @param {((key: string) => void) | null} [onSecondaryPress] A right press
   *   on a row, reported before the pane under the list hears the same press;
   *   see `noteRowPress`.
   */
  instrumentTable(
    tokens,
    id,
    name,
    rows,
    rowHeight,
    header,
    renderRow,
    onSelect,
    empty,
    columnCount = 5,
    rowKey = (row, index) => String(row?.symbol ?? index),
    onSecondaryPress = null,
  ) {
    const body = TableBody.new(`${id}-body`)
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        // The renderer runs inside layout, so it registers nothing: selection
        // is the list's own `on_item_click`, reported as the row's stable
        // instrument key even if filtering or sorting changes its index before
        // a queued click is delivered.
        v_virtual_list(
          `${id}-rows`,
          rows.length,
          rowHeight,
          // A row's identity is its instrument, not its position. Both lists
          // reorder under it — the watchlist by session, holdings by market
          // value — and a key taken from the index would move a click onto
          // whatever slid into that slot.
          (index) => rowKey(rows[index], index),
          (range) =>
            rows
              .slice(range.start, range.end)
              .map((row, offset) => renderRow(row, range.start + offset)),
        )
          .track_scroll(this.collectionScrollHandles[id])
          .size_full()
          .when(Boolean(onSelect), (list) => list.on_item_click(onSelect))
          .when(Boolean(onSecondaryPress), (list) =>
            list.on_item_secondary_click((key) => onSecondaryPress(key)),
          ),
      )
      .child(Scrollbar.vertical(`${id}-rows`).absolute().inset_0());

    return Table.new(`${id}-table`)
      .accessibility_label(name)
      .row_count(rows.length + 1)
      .column_count(columnCount)
      .flex()
      .flex_col()
      .child(header)
      .child(rows.length ? body : empty);
  }

  /**
   * The session menu, in the window's top-right corner.
   *
   * `Popover` owns the press, the anchoring and the dismissal; the rows are
   * ordinary buttons carrying the menu-item role, because the runtime binds no
   * menu component to build them from.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  userMenu(tokens) {
    const selected = this.quotes.find((quote) => quote.symbol === this.selectedSymbol);
    const close = (cx) => {
      this.userMenuOpen = false;
      this.redraw(cx);
    };
    return Popover.new("user-menu")
      .open(this.userMenuOpen)
      .on_open_change((open, cx) => {
        this.userMenuOpen = open;
        this.redraw(cx);
      })
      .trigger(sessionAvatar(tokens, "user-menu-trigger", "Session menu", this.userMenuOpen))
      .content(
        popoverSurface(tokens, "session-menu-surface", { menu: true })
          .child(
            // The menu does what the chord does, by name. Neither knows about
            // the other: the reconnect chord is bound to this action in the keymap, the
            // root answers it, and this dispatches it down the same focus path
            // rather than calling the handler behind the keymap's back.
            menuItem(
              tokens,
              "user-menu-reconnect",
              "Reconnect stream",
              (_event, cx) => {
                close(cx);
                window.dispatch_action("workspace::reconnect");
              },
              { detail: chordLabel(`${PRIMARY_MODIFIER}-r`) },
            ),
          )
          .child(
            menuItem(
              tokens,
              "user-menu-status-bar",
              this.statusBarVisible ? "Hide status bar" : "Show status bar",
              (_event, cx) => {
                close(cx);
                this.statusBarVisible = !this.statusBarVisible;
                this.redraw(cx);
              },
            ),
          )
          .child(
            menuItem(
              tokens,
              "user-menu-fps",
              this.fpsVisible ? "Hide FPS" : "Show FPS",
              (_event, cx) => {
                close(cx);
                this.toggleFps(cx);
              },
            ),
          )
          .child(
            menuItem(
              tokens,
              "user-menu-copy-symbol",
              "Copy selected symbol",
              (_event, cx) => {
                close(cx);
                if (selected) this.copyAuthorization(selected.symbol, "Symbol", cx);
              },
              { detail: selected ? selected.code : "", disabled: !selected },
            ),
          )
          .child(
            menuItem(
              tokens,
              "user-menu-refresh-chart",
              "Reload 5D chart",
              (_event, cx) => {
                close(cx);
                this.invalidateCurrentChartCache();
                this.loadSelectedChart(cx);
              },
              { disabled: !selected },
            ),
          )
          .child(rule(tokens))
          .child(
            menuItem(tokens, "user-menu-longbridge", "Longbridge website", (_event, cx) => {
              close(cx);
              cx.open_url("https://longbridge.com");
            }),
          )
          .child(
            menuItem(tokens, "user-menu-github", "GitHub", (_event, cx) => {
              close(cx);
              cx.open_url("https://github.com/longbridge/longbridge-lite");
            }),
          )
          .child(rule(tokens))
          .when(!this.followsSystemTheme, (element) =>
            element
              .child(
                menuItem(
                  tokens,
                  "user-menu-theme",
                  tokens.appearance === "dark" ? "Light theme" : "Dark theme",
                  (_event, cx) => {
                    close(cx);
                    window.dispatch_action("workspace::toggle-theme");
                  },
                  { detail: chordLabel(`${PRIMARY_MODIFIER}-t`) },
                ),
              )
              .child(rule(tokens)),
          )
          // The window's own controls. They are `Window` methods over there
          // and `window` methods here, so this is the platform's zoom and the
          // platform's fullscreen rather than a size the script picked.
          .child(
            menuItem(
              tokens,
              "user-menu-fullscreen",
              window.is_fullscreen() ? "Leave full screen" : "Enter full screen",
              (_event, cx) => {
                close(cx);
                window.dispatch_action("workspace::toggle-fullscreen");
              },
              { detail: chordLabel(`${PRIMARY_MODIFIER}-shift-f`) },
            ),
          )
          .child(
            menuItem(
              tokens,
              "user-menu-zoom",
              window.is_maximized() ? "Unzoom" : "Zoom",
              (_event, cx) => {
                close(cx);
                window.zoom_window();
              },
            ),
          )
          .child(
            menuItem(tokens, "user-menu-minimize", "Minimize", (_event, cx) => {
              close(cx);
              window.minimize_window();
            }),
          )
          .child(rule(tokens))
          .child(
            menuItem(
              tokens,
              "user-menu-sign-out",
              "Sign out",
              (_event, cx) => {
                close(cx);
                this.signOut(cx);
              },
              { destructive: true },
            ),
          )
          .child(rule(tokens))
          .child(
            // Leaving is in the menu because the window no longer carries a
            // system title bar on every platform: macOS still draws its traffic
            // lights over the corner, but a Linux window has no close button of
            // its own to offer. `process.exit` is a request -- the host decides
            // what it means, and this one quits -- so the keyboard route and
            // this item end in the same place. The hint is spelled as the
            // binding `src/main.rs` actually registers, like every other hint
            // in this menu.
            menuItem(
              tokens,
              "user-menu-exit",
              "Exit",
              (_event, cx) => {
                close(cx);
                exit(0);
              },
              { detail: chordLabel(MACOS ? "cmd-q" : "alt-f4") },
            ),
          ),
      );
  }

  /**
   * A right press anywhere in the Watchlist copies the selected instrument.
   *
   * `on_click` cannot say this: it reports neither which button was pressed
   * nor how many presses ago, and a row cannot carry a handler of its own —
   * rows are rebuilt every frame the list scrolls. So the pane carries one.
   *
   * The press stops here. The pane sits inside a resizable group inside the
   * workspace, and neither of those has any business with a copy.
   *
   * @param {import("gpui-kit").Context} cx
   */
  copySelectedSymbol(cx) {
    cx.stop_propagation();
    const quote = this.quotes.find((entry) => entry.symbol === this.selectedSymbol);
    if (quote) this.copyAuthorization(quote.symbol, "Symbol", cx);
  }

  /**
   * Copies a named symbol.
   *
   * The row menu is opened from three lists now, and only one of them is the
   * watchlist -- so what it copies is the row it was opened on, which is not
   * necessarily the selected quote.
   *
   * @param {string} symbol @param {import("gpui-kit").Context} cx
   */
  copySymbol(symbol, cx) {
    if (symbol) this.copyAuthorization(symbol, "Symbol", cx);
  }

  /**
   * @param {string} symbol The virtual list's stable item key.
   * @param {import("gpui-kit").Context} cx
   */
  selectQuote(symbol, cx) {
    if (!symbol || symbol === this.selectedSymbol) return;
    this.selectDetailMarket(symbol, cx);
    // Paint the selection first. `loadSelectedChart` publishes the chart, and
    // publishing it is the expensive half of this click -- see `publishChart`.
    this.redraw(cx);
    this.loadSelectedChart(cx);
  }

  // Test probes can draw the complete detail stack without the Watchlist.
  stockDetail(tokens) {
    return v_flex()
      .size_full()
      .min_w(0)
      .min_h(0)
      .children([
        this.quoteDetailsPanel(tokens).flex_1().min_h(0),
        this.chartDetailsPanel(tokens).flex_1().min_h(0),
        this.marketDetailPanel(tokens).flex_1().min_h(0),
      ]);
  }

  selectedQuote() {
    return this.quotes.find((entry) => entry.symbol === this.selectedSymbol) ?? this.quotes[0];
  }

  /**
   * The two ways into a ticket, under the instrument they act on.
   *
   * Coloured the way the side column of an order is, and the way a rising and
   * a falling number are: buying and selling are readings rather than
   * interface roles, so they do not take the primary and destructive tokens --
   * selling is not destruction.
   *
   * The shortcuts are named on the buttons because that is where someone
   * looking for them will be looking.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {string} symbol
   */
  tradeActions(tokens, symbol) {
    /** @param {string} id @param {string} caption @param {"Buy" | "Sell"} side */
    const button = (id, caption, side) =>
      action(tokens, id, caption, (_event, cx) => this.openTicket(symbol, side, cx))
        .flex_1()
        .text_color(tradeSideTone(tokens, side))
        .border_color(tradeSideTone(tokens, side));
    return h_flex()
      .id("trade-actions")
      .gap(tokens.spacing.sm)
      .px(tokens.spacing.sm)
      .pb(tokens.spacing.sm)
      .child(button("trade-buy", "Buy", "Buy"))
      .child(button("trade-sell", "Sell", "Sell"));
  }

  /** Quote facts are always expanded: the Panel itself is the disclosure. */
  quoteDetailsPanel(tokens) {
    const quote = this.selectedQuote();
    return panel(tokens)
      .id("quote-details-panel")
      .border_t(0)
      .flex_none()
      .min_w(0)
      .child(
        quote
          ? v_flex()
              .flex_none()
              .child(
                quoteDetail(tokens, quote, this.lastTick, this.quotePulse ?? 1, {
                  open: this.detailSections.more,
                  onToggle: (open, cx) => {
                    this.detailSections = { ...this.detailSections, more: open };
                    this.redraw(cx);
                  },
                }),
              )
              .child(this.tradeActions(tokens, quote.symbol))
          : emptyPanel(
              tokens,
              "Watchlist is empty",
              "Add securities in Longbridge, then reconnect to refresh this read-only view.",
            ),
      );
  }

  /** The retained chart has its own Panel and is never mounted by market-detail pushes. */
  chartDetailsPanel(tokens) {
    return panel(tokens)
      .id("chart-panel")
      .border_t(0)
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(v_flex().child(this.chartSection(tokens)));
  }

  /** Compact underline interval tabs carried by the Chart Panel TitleBar. */
  chartModeTabs(tokens) {
    const mode = this.activeChartMode();
    const chartModes = [
      ["intraday", "Intraday"],
      ["5D", "5D"],
      ["1m", "1m"],
      ["5m", "5m"],
      ["15m", "15m"],
      ["1D", "1D"],
    ];
    const chartWidth = responsivePanelWidths(window.viewport_size().width).detail;
    if (chartWidth < 440) {
      const caption = chartModes.find(([id]) => id === mode)?.[1] ?? mode;
      return Popover.new("chart-mode-menu")
        .open(this.chartModeMenuOpen)
        .on_open_change((open, cx) => {
          this.chartModeMenuOpen = open;
          this.redraw(cx);
        })
        .trigger(
          Button.new("chart-mode-menu-trigger")
            .accessibility_label("Chart interval")
            .flex()
            .items_center()
            .justify_center()
            .h(22)
            .px(tokens.spacing.xs)
            .border(0)
            .bg(tokens.background)
            .text_size(11)
            .text_color(tokens.foreground)
            .child(`${caption} ▾`),
        )
        .content(
          popoverSurface(tokens, "chart-mode-menu-surface", { width: 112, menu: true }).children(
            chartModes.map(([id, itemCaption]) =>
              menuItem(
                tokens,
                `chart-mode-menu-${id}`,
                itemCaption,
                (_event, cx) => {
                  this.chartModeMenuOpen = false;
                  this.setChartMode(id, cx);
                },
                { detail: mode === id ? "✓" : "" },
              ),
            ),
          ),
        );
    }
    // The library's underline shape. What was here was the same thing written
    // by hand, and written slightly differently from the workspace's own run
    // of tabs a few hundred lines up -- which is the reason a component for it
    // exists.
    return intervalTabs(
      tokens,
      "chart-mode",
      chartModes.map(([id, caption]) => ({ value: id, label: caption })),
      mode,
      (value, cx) => this.setChartMode(value, cx),
      "Chart interval",
    );
  }

  /** One market-reading scroll: Order Book then Time & Sales. */
  marketDetailPanel(tokens) {
    const quote = this.selectedQuote();
    return panel(tokens)
      .id("market-detail-panel")
      .border_t(0)
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        quote
          ? v_flex().child(
              v_flex()
                .gap(tokens.spacing.xs)
                .py(tokens.spacing.xs)
                .child(orderBookPanel(tokens, this.depthState, depthRatio(this.depthState)))
                .child(
                  timeSalesPanel(tokens, this.tradesState, {
                    symbol: quote.symbol,
                    market: quote.market,
                  }),
                ),
            )
          : emptyPanel(
              tokens,
              "Watchlist is empty",
              "Select a security to read its market detail.",
            ),
      );
  }

  /**
   * The chart, the day it ends on, and the two ways to change that day.
   *
   * The wheel is the second one, and it is what `on_scroll_wheel` is for:
   * `overflow_scroll()` would hand the gesture to a scroll container, and
   * there is nothing here to scroll — the gesture drives a value instead.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  chartSection(tokens) {
    // `today()` is the day the state read when it was created, so a session
    // left open across midnight would still be holding yesterday. The ceiling
    // is the later of that and the clock, which is right either way.
    const today = calendarDay(new Date());
    const end = this.chartEndDate ?? today;
    return (
      v_flex()
        .relative()
        // The title, interval tabs, supporting copy and plot share the Panel's
        // `sm` content baseline; a second, larger inset made the chart appear
        // to drift right under its own title.
        .px(tokens.spacing.sm)
        .py(tokens.spacing.sm)
        .gap(tokens.spacing.sm)
        .child(
          // The plot fades rather than switching. A new interval or a new
          // instrument replaces every point on it at once, and a plot that
          // snapped from one series to another read as a glitch rather than as
          // an answer; held back while the request is out and brought up when
          // it lands, the same 150ms as everything else, it reads as one.
          motion(
            div()
              .id("price-chart-wheel")
              .flex_1()
              .min_h(244)
              .opacity(this.chartActivity() === "ready" ? 1 : 0.45)
              // A wheel over the chart walks the window a day at a time. The
              // handler reads `delta.y` in pixels, which is what every device
              // reports; `delta_lines` is only there when one reported lines.
              .on_scroll_wheel((event, cx) => {
                const step = event.delta.y > 0 ? -1 : event.delta.y < 0 ? 1 : 0;
                if (step === 0) return;
                const next = shiftDay(end, step);
                this.setChartEnd(next > today ? null : next, cx);
              })
              .child(this.priceChart),
            "opacity",
          ),
        )
    );
  }

  /**
   * The month the picker is showing, drawn from the retained `CalendarState`.
   *
   * It is the application's own surface rather than a `Popover`, which is what
   * `on_mouse_down_out` is for: a press anywhere outside puts it away, the
   * same listener base's own overlays close on.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {string} today
   */
  calendarSurface(tokens, today) {
    return div()
      .id("chart-calendar-surface")
      .absolute()
      .right(tokens.spacing.lg)
      .top(48)
      .w(220)
      .p(PANE_INSET)
      .bg(tokens.surface)
      .border(1)
      .border_color(tokens.border)
      .on_mouse_down_out((_event, cx) => {
        this.calendarOpen = false;
        this.redraw(cx);
      })
      .child(
        calendarGrid(tokens, this.chartCalendar, {
          selected: this.chartEndDate,
          latest: today,
          onPick: (day, cx) => {
            // `set_value` is what raises the state's own `change`, so the
            // reload is written once, in the handler `init` registered.
            this.chartCalendar.set_value(day);
            this.calendarOpen = false;
            this.redraw(cx);
          },
          onMonth: (delta, cx) => {
            if (delta < 0) this.chartCalendar.prev_month();
            else this.chartCalendar.next_month();
            this.redraw(cx);
          },
        }),
      );
  }

  /**
   * @param {string | null} day `null` puts the window back on today.
   * @param {import("gpui-kit").Context} cx
   */
  setChartEnd(day, cx) {
    if (day === this.chartEndDate) return;
    this.chartEndDate = day;
    this.loadSelectedChart(cx);
    this.redraw(cx);
  }

  /** @param {import("gpui-base").Theme} tokens */
  portfolioPage(tokens) {
    const balance =
      this.account && typeof this.account === "object"
        ? /** @type {Record<string, unknown>} */ (this.account)
        : null;
    const presentation = portfolioPresentation(
      this.holdings,
      [...this.quotes, ...this.portfolioQuotes],
      this.fxRates,
    );
    const allocation = allocationInUsd(
      this.holdings,
      [...this.quotes, ...this.portfolioQuotes],
      this.fxRates,
    );
    // What the account holds, which the account endpoint does not report --
    // see `accountTotals`. Read from the balance's cash rather than from the
    // formatted card below it, so the sum is of two numbers and not of a
    // number and a string.
    const totals = balance
      ? accountTotals(allocation, balance.total_cash ?? balance.totalCash)
      : null;
    const account = balance
      ? {
          netAssets: stringValue(balance.net_assets ?? balance.netAssets),
          totalCash: stringValue(balance.total_cash ?? balance.totalCash),
          buyingPower: stringValue(balance.buy_power ?? balance.buyPower),
          currency: "USD",
          risk: stringValue(balance.risk_level ?? balance.riskLevel),
        }
      : null;

    const holdingRows = filterRows(presentation.holdings, this.holdingsQuery, ["symbol", "name"]);
    // The page does not scroll; Holdings does. The two cards above it are as
    // tall as their content and the table takes the rest, which is what stops
    // the window growing a scrollbar of its own.
    //
    // That leaves exactly one scroll on this page, and it is the virtualized
    // one -- the table only builds the rows it is showing, so the taller the
    // window the more it draws and the less it pages. A scrolling *page* put a
    // second scroll outside that one, and a table with its own scroll inside a
    // scrolling column is how Holdings used to end up unreachable.
    return (
      v_flex()
        .flex_1()
        .min_h(0)
        .gap(tokens.spacing.md)
        // The menu is placed against this page, so its coordinates are
        // measured from it -- the same arrangement the Watchlist pane has.
        .relative()
        .on_mouse_down("right", (event, cx) => this.openHoldingMenu(event, cx))
        // The summary and the ring share a row, four parts to six. They answer
        // the same question -- what is in this account -- from two directions,
        // and reading one under the other made the page a column of cards where
        // it is really two views of one thing. The ring takes the larger share:
        // it carries a legend beside it, and the summary is a handful of figures.
        //
        // `flex_wrap` because a narrow window cannot hold both: they stack rather
        // than squeezing the legend out of the ring.
        .child(
          h_flex()
            .flex_none()
            .flex_wrap()
            .items_stretch()
            .gap(tokens.spacing.md)
            .child(
              workspacePanel(
                tokens,
                "Portfolio summary",
                account
                  ? portfolioSummary(tokens, account, presentation.summaries, totals)
                  : emptyPanel(
                      tokens,
                      "No account snapshot",
                      "Waiting for Longbridge account assets.",
                    ),
                null,
                { note: account ? `Risk level ${account.risk}` : "Read only" },
              )
                .flex_basis(0)
                .flex_grow(4)
                .min_w(320),
            )
            .when(allocation.slices.length > 0 || allocation.unpriced.length > 0, (element) =>
              element.child(
                workspacePanel(
                  tokens,
                  "Asset allocation",
                  h_flex()
                    .flex_wrap()
                    .items_start()
                    .gap(tokens.spacing.xl)
                    .p(tokens.spacing.md)
                    .child(
                      v_flex()
                        .flex_basis(360)
                        .flex_grow(1)
                        .child(
                          allocationChart(tokens, allocation, {
                            hovered: this.hoveredAllocation,
                            onHover: (symbol, cx) => {
                              if (this.hoveredAllocation === symbol) return;
                              this.hoveredAllocation = symbol;
                              this.redraw(cx);
                            },
                          }),
                        ),
                    ),
                  // The control stays opposite the heading; only the words
                  // that describe the card sit next to its name.
                  this.allocationHelp(tokens, allocation),
                  { note: "Market value in USD" },
                )
                  .flex_basis(0)
                  .flex_grow(6)
                  .min_w(380),
              ),
            ),
        )
        .child(
          workspacePanel(
            tokens,
            "Holdings",
            this.instrumentTable(
              tokens,
              "holdings",
              "Holdings",
              holdingRows,
              HOLDING_ROW_HEIGHT,
              holdingsHeader(tokens),
              (holding, index) =>
                holdingRow(
                  tokens,
                  holding,
                  holding.symbol === this.selectedHoldingSymbol,
                  index,
                  this.rowMenu?.source === "holdings" && this.rowMenu.symbol === holding.symbol,
                ),
              (symbol, cx) => {
                this.selectedHoldingSymbol = symbol;
                this.redraw(cx);
              },
              this.holdingsQuery
                ? emptyPanel(tokens, "No matches", "No holding matches that filter.")
                : emptyPanel(
                    tokens,
                    "No stock positions",
                    "This account currently reports no stock holdings.",
                  ),
            )
              // A definite height is what makes virtualization possible at all,
              // and this page is a scrolling column with no leftover height to
              // claim -- so it takes the leftover height of a page that no
              // longer scrolls, rather than being sized from a row count and
              // letting the page scroll past it.
              .flex_1()
              .min_h(0),
            filterInput(tokens, this.holdingsFilter, 160),
            {
              note:
                holdingRows.length === this.holdings.length
                  ? `${this.holdings.length} positions`
                  : `${holdingRows.length} of ${this.holdings.length} positions`,
            },
          )
            .flex_1()
            .min_h(0),
        )
        .when(this.rowMenu?.source === "holdings", (element) =>
          element.child(this.rowMenuSurface(tokens)),
        )
    );
  }

  /**
   * Today's orders over the account's history, which is how the Longbridge
   * terminal stacks them: what is working now is read first and is the shorter
   * list, and the record underneath it is the one worth scrolling.
   *
   * One filter serves both. They are two windows onto the same collection --
   * the same instruments, the same statuses -- and a filter per table would
   * ask a reader to say "AAPL" twice to answer one question.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  /**
   * Puts the row menu on the Orders page, wherever that page's layout put its
   * panels.
   *
   * The page returns one of three arrangements depending on the window, and
   * the menu belongs to all of them -- so it is attached to whichever was
   * built rather than written into each.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {import("gpui-kit").Element} page
   */
  withOrderMenu(tokens, page) {
    return page
      .relative()
      .on_mouse_down("right", (event, cx) => this.openOrderMenu(event, cx))
      .when(this.rowMenu?.source === "orders", (element) =>
        element.child(this.rowMenuSurface(tokens)),
      );
  }

  ordersPage(tokens) {
    const state = this.ordersState;
    const today = filterRows(state.today, this.todayOrdersQuery, ORDER_FILTER_FIELDS);
    const history = filterRows(state.history, this.historyOrdersQuery, ORDER_FILTER_FIELDS);
    const selected = this.selectedOrder();
    // An account with nothing working is the ordinary case, not an error, and
    // most days Today is empty: a panel that still reserved a table's height
    // for it spent a third of the page saying so and took that height from the
    // history underneath, which is the list actually being read. So a list
    // with no rows to draw keeps its heading -- which is where the count and
    // the filter live -- and gives everything below it back.
    const todayPanel = this.ordersPanel(tokens, {
      id: "today-orders",
      title: "Today Orders",
      rows: today,
      total: state.today.length,
      filter: this.todayOrdersFilter,
      query: this.todayOrdersQuery,
      empty: "No orders today.",
    });
    const historyPanel = this.ordersPanel(tokens, {
      id: "history-orders",
      title: "History Orders",
      note: `last ${HISTORY_WINDOW_DAYS} days`,
      rows: history,
      total: state.history.length,
      filter: this.historyOrdersFilter,
      query: this.historyOrdersQuery,
      empty: `No orders in the last ${HISTORY_WINDOW_DAYS} days.`,
    });
    const sheet = selected ? this.orderDetailPanel(tokens, selected) : null;
    const todayCollapsed = this.ordersCollapsed(today);
    const historyCollapsed = this.ordersCollapsed(history);
    const todayHeight =
      ORDERS_PANEL_CHROME + Math.min(today.length, TODAY_ORDERS_VISIBLE_ROWS) * ORDER_ROW_HEIGHT;

    // A narrow window scrolls the panels at stated heights rather than sharing
    // one height between them, which is what the stacked Watchlist does and
    // for the same reason: three panels dividing a short window leaves each of
    // them too short to read, and a sheet opening under them takes the height
    // out of the lists that were being read.
    if (this.isNarrow()) {
      return this.withOrderMenu(
        tokens,
        v_flex()
          .id("orders-page-stacked")
          .flex_1()
          .min_h(0)
          .gap(tokens.spacing.md)
          .overflow_y_scrollbar()
          .child(todayCollapsed ? todayPanel.flex_none() : todayPanel.h(todayHeight).flex_none())
          .child(historyCollapsed ? historyPanel.flex_none() : historyPanel.h(400).flex_none())
          .when(Boolean(sheet), (element) => element.child(sheet.h(460).flex_none())),
      );
    }

    const lists = v_flex()
      .id("orders-lists")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .gap(tokens.spacing.md)
      .child(todayCollapsed ? todayPanel.flex_none() : todayPanel.h(todayHeight).flex_none())
      .child(historyCollapsed ? historyPanel.flex_none() : historyPanel.flex_1().min_h(200));
    if (!sheet) return this.withOrderMenu(tokens, lists);
    // Beside the lists, where there is room for a column of its own.
    return this.withOrderMenu(
      tokens,
      h_flex()
        .id("orders-page-split")
        .flex_1()
        .min_h(0)
        // `h_flex` centres its children, and a centred panel is one as tall as
        // its own content: the lists collapsed to their headers and the sheet
        // drew a title over nothing.
        .items_stretch()
        .gap(tokens.spacing.md)
        .child(lists)
        .child(sheet.w(320).flex_none()),
    );
  }

  /**
   * The right-hand sheet: one order in full, with the way out of it.
   *
   * The close control is the panel's, not the row's -- a reader who opened
   * this by clicking a row that has since scrolled away still has to be able
   * to put it back. Escape does the same thing, which is what `dismiss` is
   * for.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {LongbridgeOrderRow} order
   */
  orderDetailPanel(tokens, order) {
    const known = this.quotes.some((quote) => quote.symbol === order.symbol);
    return workspacePanel(
      tokens,
      "Order",
      v_flex()
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .child(
          orderDetail(tokens, order, {
            // Passing the handler is what offers the action, so an order that
            // has finished gets a sheet with no controls rather than a sheet
            // with two dead ones.
            onReplace: canReplace(order) ? (_event, cx) => this.openReplaceTicket(order, cx) : null,
            onCancel: canCancel(order) ? (_event, cx) => this.openCancelTicket(order, cx) : null,
          }),
        ),
      h_flex()
        .items_center()
        .gap(tokens.spacing.xs)
        .when(known, (element) =>
          element.child(
            iconAction(
              tokens,
              "order-detail-quote",
              "Open this instrument",
              "assets/chart-line.svg",
              (_event, cx) => this.showOrderInstrument(order.orderId, cx),
            ),
          ),
        )
        .child(
          iconAction(
            tokens,
            "order-detail-close",
            "Close order detail",
            "assets/x.svg",
            (_e, cx) => {
              this.selectedOrderId = null;
              this.redraw(cx);
            },
          ),
        ),
    )
      .id("order-detail-panel")
      .min_h(0);
  }

  /**
   * One order table, with the state of the read written where the rows would
   * be. A list that is loading, one that failed and one that is simply empty
   * are three different things to say, and saying none of them would leave a
   * failed request looking like an account that has never traded.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {{
   *   id: string,
   *   title: string,
   *   note?: string,
   *   rows: readonly LongbridgeOrderRow[],
   *   total: number,
   *   filter: import("gpui-base").InputStateHandle,
   *   query: string,
   *   empty: string,
   * }} options
   */
  ordersPanel(tokens, options) {
    const { id, title, note = "", rows, total, filter, query, empty } = options;
    const counted = total === 1 ? "1 order" : `${total} orders`;
    const summary = query ? `${rows.length} of ${counted}` : counted;
    return workspacePanel(
      tokens,
      title,
      this.ordersCollapsed(rows)
        ? // No column heads over no rows: what is left to say is one line, and
          // the heading above it already says whose line it is.
          h_flex()
            .id(`${id}-state`)
            .items_center()
            .px(tokens.spacing.sm)
            .py(tokens.spacing.sm)
            .child(muted(tokens, this.ordersEmptyLine(query, empty)))
        : this.instrumentTable(
            tokens,
            id,
            title,
            rows,
            ORDER_ROW_HEIGHT,
            ordersHeader(tokens, id),
            (order, index) =>
              orderRow(
                tokens,
                order,
                index,
                order.orderId === (this.selectedOrderRowId ?? this.selectedOrderId),
                this.rowMenu?.source === "orders" && this.rowMenu.orderId === order.orderId,
              ),
            (orderId, cx) => this.selectOrder(orderId, cx),
            this.ordersEmpty(tokens, empty),
            6,
            (order, index) => String(order?.orderId ?? index),
            (orderId) => this.noteRowPress("orders", orderId),
          )
            .flex_1()
            .min_h(0),
      // Both lists carry a filter, because each narrows itself: they answer
      // different questions, and one box for the two of them hid the short
      // list every time the long one was narrowed.
      filterInput(tokens, filter, 160),
      { note: note ? `${summary} · ${note}` : summary, grow: !this.ordersCollapsed(rows) },
    )
      .id(id)
      .flex_1()
      .min_h(0);
  }

  /**
   * Whether a list has nothing to draw and should give its height back.
   *
   * Not while the read is in flight: a panel that shrank on the way to its
   * rows and grew again when they arrived would move the list underneath it
   * twice per page open.
   *
   * @param {readonly LongbridgeOrderRow[]} rows
   */
  ordersCollapsed(rows) {
    return rows.length === 0 && this.ordersState.status !== "loading";
  }

  /** The one line a collapsed list says instead of its rows. */
  ordersEmptyLine(query, empty) {
    if (this.ordersState.status === "error") return this.ordersState.error;
    if (query) return "No order matches that filter.";
    return empty;
  }

  /** @param {import("gpui-base").Theme} tokens @param {string} empty */
  ordersEmpty(tokens, empty) {
    const state = this.ordersState;
    if (state.status === "loading") {
      return emptyPanel(tokens, "Loading orders", "Reading this account's orders from Longbridge.");
    }
    if (state.status === "error") {
      return emptyPanel(tokens, "Orders unavailable", state.error);
    }
    return emptyPanel(tokens, "Nothing to show", empty);
  }

  /**
   * An order names an instrument, and the instrument is what the rest of the
   * application is about -- so clicking one opens it, the way Return does in
   * the terminal. Only when the Watchlist holds it: the detail panes are drawn
   * from a streamed quote, and selecting a symbol that has none would leave
   * them showing another instrument's readings under this one's name.
   *
   * @param {string} orderId @param {import("gpui-kit").Context} cx
   */
  showOrderInstrument(orderId, cx) {
    const order = [...this.ordersState.today, ...this.ordersState.history].find(
      (row) => row.orderId === orderId,
    );
    if (!order || !this.quotes.some((quote) => quote.symbol === order.symbol)) return;
    this.selectQuote(order.symbol, cx);
    this.showPage("watchlist", cx);
  }

  /**
   * The second `Popover` in the application, and deliberately a different
   * shape from the Watchlist menu: a card of explanatory text rather than a
   * list of commands, so it announces itself as a group and not a menu.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {ReturnType<import("./portfolio.js").allocationInUsd>} allocation
   */
  allocationHelp(tokens, allocation) {
    const priced = allocation.slices.length;
    return Popover.new("allocation-help")
      .open(this.allocationHelpOpen)
      .on_open_change((open, cx) => {
        this.allocationHelpOpen = open;
        this.redraw(cx);
      })
      .trigger(
        menuTrigger(
          tokens,
          "allocation-help-trigger",
          "How this chart is built",
          this.allocationHelpOpen,
        ),
      )
      .content(
        popoverSurface(tokens, "allocation-help-surface", { width: 280 })
          .child(label(tokens, "How this chart is built", "subtitle").font_weight(700))
          .child(
            muted(
              tokens,
              "Positions are ranked by market value in USD. The five largest keep a colour of " +
                "their own; everything after them is folded into one grey Other, because a " +
                "sixth hue would repeat one that already means a different holding.",
            ),
          )
          .child(rule(tokens))
          .child(
            detailGrid(tokens, [
              { title: "Priced positions", value: String(priced) },
              { title: "Unpriced", value: String(allocation.unpriced.length) },
              { title: "Wedges drawn", value: String(Math.min(priced, 6)) },
            ]),
          ),
      );
  }

  /**
   * The sign-in screen.
   *
   * It is the only thing on screen when it is on screen, so it is laid out as
   * one card rather than as a panel among panels: the product mark, then the
   * one thing the person has to do next, then the controls for doing it. When
   * a device code is live that one thing is the code itself, which is why it
   * is the largest text in the application.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  authPanel(tokens) {
    const device = this.authorization;
    const stored = this.hasStoredTokens;
    const needsAttention = stored && this.status.state === "error";
    const status = statusColors(tokens);

    // The chrome carries the identity -- the header above this is showing the
    // mark, the name and the tagline, and the footer is already saying the
    // terminal is read-only. So the card carries the task and nothing else;
    // repeating any of it here would be three of everything on one screen.
    return panel(tokens)
      .p(tokens.spacing.xl)
      .gap(tokens.spacing.lg)
      .child(
        div()
          .relative()
          .self_center()
          .w(40)
          .h(40)
          .accessibility_label("Longbridge")
          .child(
            svg("assets/logo-foreground.svg").absolute().inset_0().text_color(tokens.foreground),
          )
          .child(svg("assets/logo-info-cyan.svg").absolute().inset_0().text_color(status.info))
          .child(svg("assets/logo-warning.svg").absolute().inset_0().text_color(status.warning))
          .child(svg("assets/logo-danger.svg").absolute().inset_0().text_color(status.down)),
      )
      .child(
        device
          ? this.deviceCode(tokens, device)
          : v_flex()
              .items_center()
              .gap(tokens.spacing.xs)
              .child(
                label(
                  tokens,
                  needsAttention
                    ? "Session needs attention"
                    : stored
                      ? "Restoring your session"
                      : "Sign in to continue",
                  "title",
                ).font_weight(700),
              )
              .child(
                muted(
                  tokens,
                  needsAttention
                    ? "Retry the saved session, or clear it and sign in again."
                    : stored
                      ? "Reconnecting with the saved Longbridge session."
                      : "Authorize this device with your Longbridge account.",
                ),
              ),
      )
      .when(Boolean(this.error), (element) => element.child(errorMessage(tokens, this.error)))
      .child(
        v_flex()
          .gap(tokens.spacing.sm)
          .child(
            action(
              tokens,
              "longbridge-sign-in",
              device ? "Waiting for approval" : stored ? "Retry connection" : "Sign in",
              (_event, cx) => (stored ? this.resume(cx) : this.signIn(cx)),
              {
                variant: stored ? "default" : "primary",
                disabled: Boolean(device),
              },
            ).w_full(),
          )
          .when(stored || Boolean(device), (element) =>
            element.child(
              action(
                tokens,
                "longbridge-sign-out",
                device ? "Cancel" : "Clear session",
                (_event, cx) => this.signOut(cx),
                { variant: device ? "ghost" : "destructive", quiet: true },
              ).w_full(),
            ),
          ),
      )
      .child(
        Button.new("longbridge-home-link")
          .role("link")
          .accessibility_label("Open https://longbridge.com")
          .on_click((_event, cx) => cx.open_url("https://longbridge.com"))
          .self_center()
          .border(0)
          .bg(tokens.surface)
          .text_size(11)
          .text_color(tokens.muted_foreground)
          .hover((style) => style.text_color(tokens.foreground))
          .child("https://longbridge.com"),
      );
  }

  /**
   * The live device-code step. Three numbered places, and the code between
   * them as the largest thing on the screen.
   *
   * @param {import("gpui-base").Theme} tokens
   * @param {{ userCode: string, verificationUri: string }} device
   */
  deviceCode(tokens, device) {
    return v_flex()
      .gap(tokens.spacing.sm)
      .child(step(tokens, 1, "Longbridge is open in your browser"))
      .child(step(tokens, 2, "Enter this code"))
      .child(deviceCodeBox(tokens, device.userCode || "--"))
      .child(step(tokens, 3, "Approve the request in Longbridge"))
      .child(
        h_flex()
          .gap(tokens.spacing.sm)
          .child(
            action(
              tokens,
              "copy-device-code",
              "Copy code",
              (_event, cx) => this.copyAuthorization(device.userCode, "Device code", cx),
              { variant: "ghost" },
            ).flex_1(),
          )
          .child(
            action(
              tokens,
              "copy-authorization-link",
              "Copy link",
              (_event, cx) =>
                this.copyAuthorization(device.verificationUri, "Authorization link", cx),
              { variant: "ghost" },
            ).flex_1(),
          ),
      );
  }

  /**
   * The footer: what is available here, and what is going on.
   *
   * Two rows, because they answer different questions. The rail says which
   * commands this view actually has; the status row says what the window and
   * the feed are doing, and it keeps the readout of the last chord delivered --
   * which is *what just happened*, not what is available, and the two are not
   * the same thing even though both are drawn as key caps.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  footer(tokens) {
    const updated = this.quotes.reduce((latest, quote) => Math.max(latest, quote.receivedAt), 0);
    return v_flex()
      .flex_none()
      .gap(tokens.spacing.xs)
      .child(this.shortcutRail(tokens))
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(muted(tokens, "Read only · Trading disabled"))
          .child(this.windowReadout(tokens))
          .child(
            h_flex()
              .items_center()
              .gap(tokens.spacing.sm)
              .child(
                muted(
                  tokens,
                  updated
                    ? `Last tick ${Math.max(0, Math.floor((this.lastTick - updated) / 1_000))}s ago`
                    : "Awaiting quotes",
                ),
              )
              // The far corner, because the performance overlay is anchored in
              // the other one and a control underneath it cannot be pressed.
              .child(this.diagnostics(tokens)),
          ),
      );
  }

  /**
   * The chords this view has, drawn from the keymap rather than written out.
   *
   * Every entry is a binding in `KEY_BINDINGS`, so the rail cannot name a chord
   * that does not work: a rebinding changes what it draws, and deleting a
   * binding deletes its hint. `chordLabel` is what turns the keymap's spelling
   * into the reader's.
   *
   * Only what is available *here*. Collection chords operate on the page on
   * screen, and Escape is only
   * Escape while something is open to put away -- `dismiss` hands the action
   * onward when there is not. Listing either unconditionally would be listing a
   * command that does nothing, which is the one thing a hint rail must not do.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  shortcutRail(tokens) {
    const available = (action) => {
      switch (action) {
        case "workspace::watchlist":
        case "workspace::portfolio":
        case "workspace::orders":
        case "workspace::reconnect":
          return this.hasStoredTokens;
        case "workspace::toggle-theme":
          return !this.followsSystemTheme;
        case "collection::next":
        case "collection::previous":
        case "collection::first":
        case "collection::last":
        case "collection::activate":
          return this.hasStoredTokens;
        case "workspace::dismiss":
          return this.hasSomethingToDismiss();
        default:
          // Theme and full screen are the window's, and the window is always
          // there -- including on the sign-in screen.
          return true;
      }
    };
    const hints = KEY_BINDINGS.filter((binding) => binding.caption && available(binding.action));
    return (
      h_flex()
        .items_center()
        // It wraps rather than truncating or scrolling: a hint that ran off the
        // edge of a narrow window would be a hint nobody has.
        .flex_wrap()
        .gap(tokens.spacing.md)
        .children(
          hints.map((binding) =>
            h_flex()
              // The cap and its caption are one hint, so they do not wrap apart
              // from each other.
              .flex_none()
              .items_center()
              .gap(tokens.spacing.xs)
              .child(kbd(tokens, binding.display ?? chordLabel(binding.keystroke)))
              .child(muted(tokens, binding.caption)),
          ),
        )
    );
  }

  /** Whether Escape has something of this application's to put away. */
  hasSomethingToDismiss() {
    if (this.calendarOpen || this.userMenuOpen || this.allocationHelpOpen || this.shortcutHelpOpen)
      return true;
    if (this.rowMenu) return true;
    // The two dialog flags are mirrors of the shell's stack and can be stale
    // (see `syncDialogFlags`). Escape must not be claimed on behalf of a
    // surface that is no longer up -- claiming it swallows the keystroke and
    // leaves the reader pressing a key that does nothing. `has_active_dialog`
    // is legal from render, unlike the rest of the dialog API, so the question
    // can be asked here.
    if ((this.addSymbolOpen || this.ticket.open) && this.shellHasDialog()) return true;
    if (this.page === "orders" && this.selectedOrderId) return true;
    return Boolean(this.pageFilter().query);
  }

  /**
   * What the window says about itself, and the last chord it delivered.
   *
   * Every measurement here is legal from `render` — a view that sizes itself
   * from the window has to ask during the pass that draws it — and every one
   * of them mirrors a `Window` method by the same name. It doubles as the
   * readout that says the keyboard and the pointer are reaching the workspace
   * at all: the chord is drawn as a key, filled while it is still down.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  windowReadout(tokens) {
    const viewport = window.viewport_size();
    const parts = [
      `${Math.round(viewport.width)}×${Math.round(viewport.height)}`,
      `${Math.round(window.rem_size())}px/rem`,
      // The theme, not `window.appearance()`. They are two different facts and
      // this row is read as "what am I looking at": the window reports the
      // *system's* appearance, so a dark interface on a machine set to light
      // mode said `light` while every pixel on screen said otherwise. The
      // window's own answer is still on screen -- the diagnostics popover
      // carries it, beside this one, where the two are labelled apart.
      tokens.appearance,
      window.is_window_active() ? "active" : "background",
    ];
    if (window.is_fullscreen()) parts.push("fullscreen");
    else if (window.is_maximized()) parts.push("zoomed");
    if (this.isNarrow()) parts.push("narrow");
    return (
      h_flex()
        .items_center()
        .gap(tokens.spacing.sm)
        .child(muted(tokens, parts.join(" · ")))
        .when(Boolean(this.lastKeystroke), (element) =>
          element.child(
            // Displayed the way the rail displays a chord, because it is the same
            // kind of thing said in the same kind of cap. A key the keymap does
            // not bind still arrives here -- `backspace`, a bare letter -- and
            // reads as its own name.
            kbd(tokens, chordLabel(this.lastKeystroke), {
              down: this.keyDown,
              held: this.keyHeld,
            }),
          ),
        )
        // Not through `chordLabel`: this is a button, not a chord, and the
        // formatter would read the hyphen as a modifier and say `Mouse + Left`.
        .when(this.pointerDown, (element) =>
          element.child(kbd(tokens, "Mouse left", { down: true })),
        )
    );
  }

  /**
   * Everything the window will answer, and everything it will do.
   *
   * This application is an example before it is a terminal, so the surface
   * that proves a binding works belongs on screen rather than only in a test.
   * The reads are all legal from `render` and are taken as the popover draws;
   * the changes are all refused from `render` and are on the buttons.
   *
   * @param {import("gpui-base").Theme} tokens
   */
  diagnostics(tokens) {
    const bounds = window.bounds();
    const pointer = window.mouse_position();
    const viewport = window.viewport_size();
    const command = (id, caption, run) =>
      action(tokens, id, caption, (_event, cx) => run(cx), { variant: "ghost", quiet: true });
    return Popover.new("shell-diagnostics")
      .open(this.diagnosticsOpen)
      .on_open_change((open, cx) => {
        this.diagnosticsOpen = open;
        this.redraw(cx);
      })
      .trigger(
        menuTrigger(
          tokens,
          "shell-diagnostics-trigger",
          "Window diagnostics",
          this.diagnosticsOpen,
        ),
      )
      .content(
        popoverSurface(tokens, "diagnostics-surface", { width: 300 })
          .child(label(tokens, "Window", "subtitle").font_weight(700))
          .child(
            detailGrid(tokens, [
              {
                title: "Viewport",
                value: `${Math.round(viewport.width)}×${Math.round(viewport.height)}`,
              },
              {
                title: "Bounds",
                value: `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}×${Math.round(bounds.height)}`,
              },
              { title: "Rem size", value: `${window.rem_size()}px` },
              { title: "Line height", value: `${Math.round(window.line_height())}px` },
              {
                title: "Pointer",
                value: `${Math.round(pointer.x)},${Math.round(pointer.y)}`,
              },
              // Both, and labelled apart. The theme is what the interface is
              // drawn in and what the footer reports; the appearance is the
              // system's, which is the window fact this popover is here to
              // prove can be read at all. They disagree whenever someone runs
              // a dark interface on a machine set to light.
              { title: "Theme", value: tokens.appearance },
              { title: "Appearance", value: window.appearance() },
              { title: "Active", value: window.is_window_active() ? "yes" : "no" },
              {
                title: "State",
                value: window.is_fullscreen()
                  ? "full screen"
                  : window.is_maximized()
                    ? "zoomed"
                    : "normal",
              },
            ]),
          )
          .child(rule(tokens))
          .child(muted(tokens, "Text size"))
          .child(
            h_flex()
              .gap(tokens.spacing.xs)
              .children(
                // The scale's body, title and heading steps. 18 was not on
                // it, and a control that offers a size the interface never
                // draws in is offering a size nothing was measured against.
                [12, 14, 16].map((size) =>
                  command(`shell-rem-${size}`, `${size}px`, () =>
                    window.set_rem_size(size),
                  ).flex_1(),
                ),
              ),
          )
          .child(rule(tokens))
          .child(
            h_flex()
              .flex_wrap()
              .gap(tokens.spacing.xs)
              .child(command("shell-focus-next", "Focus next", () => window.focus_next()))
              .child(command("shell-focus-prev", "Focus previous", () => window.focus_prev()))
              .child(command("shell-activate", "Bring to front", () => window.activate_window()))
              // Every view in the window, not only this one -- which is the
              // difference between it and `cx.notify()`.
              .child(command("shell-refresh", "Redraw window", () => window.refresh())),
          ),
      );
  }
}
