// The terminal's own presentation, composed from Omarchy UI.
//
// Everything generic — a button, a badge, a panel, a table's header, a
// reading, a key cap — is an Omarchy UI class. What is left here is what only
// a market terminal knows: which columns a watchlist has, what a depth book
// looks like, that a rising price is drawn in the palette's green and that
// green is not the same thing as the accent.
//
// Two conventions run through the file.
//
// **Tokens in, context out.** Every function is handed the resolved semantic
// theme, because that is the contract the rest of the application already
// calls with. Omarchy UI's builders resolve the theme from a render context
// and read nothing else from it, so `context(tokens)` is that one call.
//
// **One scale.** Spacing, type steps and control chrome come from `style()`
// in `style.js`, which is the same singleton the library's own components
// read. Nothing in this file writes a pixel.

import { Background, PathBuilder, div } from "gpui-kit";
import { Button as NativeButton, Separator as NativeSeparator, Input as NativeInput, ChoiceItem, ButtonGroup as NativeButtonGroup, TabList as NativeTabList } from "./gpui-omarchy/index.js";
import {
  Table,
  TableBody,
  TableCell as BaseTableCell,
  TableRow as BaseTableRow,
  h_flex,
  v_flex,
} from "gpui-base";
import {
  AccordionGroup,
  AccordionSection,
  Alert,
  alpha,
  Avatar,
  AvatarButton,
  Badge,
  Button,
  CellStack,
  CodeBlock,
  DefinitionList,
  EmptyState,
  ExternalLink,
  GlyphButton,
  IconButton,
  Keycap,
  Label,
  MenuItem,
  Metric,
  MetricGrid,
  MutedText,
  Panel,
  PopupSurface,
  SectionLabel,
  Step,
  Surface,
  tableHeaderHeight,
  TableHeaderRow,
  TableRow,
  Toolbar,
} from "./gpui-omarchy/composition.js";
import {
  amplitude,
  averagePrice,
  changeFromOpen,
  formatCompactNumber,
  quoteFreshness,
  tradeStatusLabel,
} from "./market.js";
import { formatMarketDate, formatMarketTime } from "./chart.js";
import { validDepthLevel } from "./market_detail.js";
import { tradeIdentity, tradeVolumeRatio } from "./market_detail.js";
import { allocationColor, avatarColor, changeTone, statusColors, valueTone } from "./palette.js";
import { allocationSliceAt, foldAllocationSlices } from "./portfolio.js";
import { style } from "./style.js";

/**
 * The one transition this interface uses. A terminal answers immediately; the
 * only thing worth easing is a value fading in over the one it replaced, and
 * it is worth easing at one speed everywhere rather than three.
 */
const MOTION = Object.freeze({ duration: 150, easing: "ease-out" });

/**
 * The render context an Omarchy UI builder needs.
 *
 * `cx.theme()` is the whole of it: the library reads the semantic tokens and
 * nothing else from the context it is given, which is what lets this file keep
 * taking resolved tokens from its callers.
 *
 * @param {import("gpui-base").Theme} tokens
 */
const context = (tokens) => ({ theme: () => tokens });

/** @param {import("gpui-base").Theme} tokens @param {string | number} value @param {string} [size] */
export const label = (tokens, value, size = "body") =>
  new Label(String(value)).size(size).build(context(tokens));

/**
 * A figure rather than prose: a price, a quantity, a percentage, a duration.
 *
 * It states no family of its own. The whole window is monospaced from the root
 * container down and every text style in GPUI cascades, so a family written
 * here would not add a mono face — it would *replace* the one the application
 * registered with whatever this string happened to resolve to, and these
 * elements would be the only text in the window drawn in a different face.
 *
 * What survives is the name at the call site. `numeric` marks a value as a
 * figure wherever one is drawn, which is what a later change to how figures
 * are set — tabular digits, alignment, a colour floor — would need to find.
 *
 * @param {import("gpui-base").Theme} tokens @param {string | number} value @param {string} [size]
 */
export const numeric = (tokens, value, size = "body") => label(tokens, value, size);

/** @param {import("gpui-base").Theme} tokens @param {string | number} value @param {string} [size] */
export const muted = (tokens, value, size = "bodySmall") =>
  new MutedText(String(value)).size(size).build(context(tokens));

/**
 * A section heading or a column head: small, bold, muted and upper case, the
 * way a terminal writes small-caps. Only the visible text is folded — every
 * lookup keyed by a heading's title still takes the title as it was written.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} value
 */
export const smallCaps = (tokens, value) =>
  new SectionLabel(String(value).toUpperCase()).build(context(tokens));

/** @param {import("gpui-base").Theme} tokens */
export const rule = (_tokens) => new NativeSeparator();

/** @param {import("gpui-base").Theme} tokens */
export const panel = (tokens) => new Surface().build(context(tokens));

/**
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui-kit").ClickEvent, cx: import("gpui-kit").Context) => void} onClick
 * @param {{ variant?: LongbridgeActionVariant, disabled?: boolean, selected?: boolean, quiet?: boolean }} [options]
 */
export function action(tokens, id, caption, onClick, options = {}) {
  const { variant = "default", disabled = false, selected = false, quiet = false } = options;
  const ghost = variant === "ghost" || quiet;
  let button = new NativeButton(id).label(caption).child(label(tokens, caption));
  if (variant === "primary") button = button.primary();
  else if (variant === "destructive") button = button.danger();
  else if (!ghost) button = button.outline();
  return button.selected(selected).disabled(disabled).on_click(onClick);
}

/**
 * A quiet icon control: `action`'s ghost variant, one step smaller, with the
 * caption moved into the tooltip and the accessibility label.
 *
 * Where a panel's title row carries its own controls there is room for the
 * mark and not for the word: two captioned buttons beside a heading read as
 * the point of the panel rather than as the way out of it.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {string} hint What the control does, for the tooltip and the label.
 * @param {string} asset
 * @param {(event: import("gpui-kit").ClickEvent, cx: import("gpui-kit").Context) => void} onClick
 */
export function iconAction(tokens, id, hint, asset, onClick) {
  return new IconButton(id)
    .icon(asset)
    .description(hint)
    .quiet()
    .size("small")
    .onClick(onClick)
    .build(context(tokens));
}

/** @param {import("gpui-base").Theme} tokens */
export function themeButton(tokens, onClick) {
  const dark = tokens.appearance === "dark";
  const hint = dark ? "Switch to light theme" : "Switch to dark theme";
  return new IconButton("theme-toggle")
    .icon(dark ? "assets/sun.svg" : "assets/moon.svg")
    .description(hint)
    .quiet()
    .size("small")
    .onClick(onClick)
    .build(context(tokens));
}

/** @param {import("gpui-base").Theme} tokens @param {string} id @param {string} caption @param {string} url */
export function externalLink(tokens, id, caption, url) {
  return new ExternalLink(id).label(caption).href(url).build(context(tokens));
}

/** @param {import("gpui-base").Theme} tokens @param {string} value */
export function connectionPill(tokens, value) {
  const active = value === "connected";
  const waiting =
    value === "authorizing" ||
    value === "connecting" ||
    value === "authenticating" ||
    value === "subscribing" ||
    value === "snapshotting" ||
    value === "reconnecting";
  // A feed's health is a reading, not an interface state: green, yellow and
  // red come from the status row so the one interactive accent keeps meaning
  // "you can press this". The colour is never the whole signal — the word
  // beside it says the same thing.
  const status = statusColors(tokens);
  return new Badge("connection-state")
    .label(
      active ? "Live" : waiting ? "Connecting" : value === "error" ? "Needs attention" : "Offline",
    )
    .dot()
    .quiet(waiting)
    .color(
      active
        ? status.up
        : waiting
          ? status.warning
          : value === "error"
            ? status.down
            : tokens.muted_foreground,
    )
    .description(`Quote stream: ${value}`)
    .build(context(tokens))
    .transition("opacity", MOTION);
}

// What each abbreviated column actually reports. A tooltip takes a string
// rather than an element, and it is the pointer's affordance only — the
// accessible name is the visible header text itself.
//
// Keyed by the title as it is written, not as it is drawn: a header is folded
// to upper case on its way to the screen, and a lookup that followed it there
// would have to be re-keyed every time a column is renamed.
const COLUMN_HINTS = Object.freeze({
  Instrument: "Ticker and security name",
  Last: "Most recent traded price",
  Change: "Move against the previous close, absolute and percent",
  Volume: "Shares traded so far this session",
  Session: "Trading status, or the session the quote came from",
  Quantity: "Shares held, and how many of them are available",
  "Last / Cost": "Latest price over the average cost of the position",
  "Today's P/L": "Move since the previous close, in USD",
  "Total P/L": "Move against cost, in USD and percent",
  Side: "Buy or sell, over the order type",
  Status: "Where the order stands, over whatever the broker said about it",
  Filled: "Shares executed, of the quantity ordered",
  Price: "Price ordered, over the price it executed at",
  Submitted: "When the order was placed, in the market's own time",
});

/**
 * The height a table's header row is drawn at, stated for the same reason the
 * row heights are: a virtualized body sized against a ceiling has to know how
 * much of the panel the header above it already took.
 */
export const TABLE_HEADER_HEIGHT = tableHeaderHeight();

/**
 * A table's header row, with each column's full reading attached as its hint.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {{ title: string, width?: string | number, align?: "start" | "end" }[]} columns
 */
function tableHeaderRow(tokens, id, columns) {
  return new TableHeaderRow(id)
    .columns(
      columns.map((column) => ({
        ...column,
        hint: COLUMN_HINTS[column.title] ?? column.title,
      })),
    )
    .build(context(tokens));
}

const WATCHLIST_COLUMNS = [
  { title: "Instrument", width: "31%" },
  { title: "Last", width: "19%", align: "end" },
  { title: "Change", width: "18%", align: "end" },
  { title: "Volume", width: "16%", align: "end" },
  { title: "Session", align: "end" },
];

/** @param {import("gpui-base").Theme} tokens @param {boolean} [compact] */
export function watchlistHeader(tokens, compact = false) {
  // A narrow dock has room for the object and its current value. The movement,
  // volume and session lanes are secondary readings; keeping them would force
  // every number into the same few pixels and make the primary data overlap.
  return tableHeaderRow(
    tokens,
    "watchlist",
    compact
      ? [
          { title: "Instrument", width: "60%" },
          { title: "Last", align: "end" },
        ]
      : WATCHLIST_COLUMNS,
  );
}

/**
 * One row of a popup menu.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {string} caption
 * @param {(event: import("gpui-kit").ClickEvent, cx: import("gpui-kit").Context) => void} onClick
 * `tone` is for a row whose colour is a *reading* rather than an interface
 * role -- buying and selling take the same two colours a rising and a falling
 * number take. `danger` stays the library's own word for the one role that is
 * one, so the two cannot be confused at a call site.
 *
 * @param {{ detail?: string, destructive?: boolean, disabled?: boolean, tone?: import("gpui-kit").Color }} [options]
 */
export function menuItem(tokens, id, caption, onClick, options = {}) {
  const { detail = "", destructive = false, disabled = false, tone = null } = options;
  const item = new MenuItem(id)
    .label(caption)
    .danger(destructive)
    .disabled(disabled)
    .onClick(onClick);
  if (detail) item.detail(detail);
  // `tone` belongs on the component: `MenuItem` resolves one foreground and
  // hands it to the label, the icon and the detail individually, so a colour
  // applied to the built element reaches the row and none of its text -- a
  // coloured row of theme-coloured words, which is what Buy and Sell were.
  if (tone) item.tone(tone);
  return item.build(context(tokens));
}

/**
 * The surface a `Popover` opens. `role` separates the two uses: a list of
 * commands announces itself as a menu, an explanatory card as a plain group.
 *
 * The id is the caller's because more than one popover can be in the tree at
 * once -- a row menu over an open session menu -- and two surfaces sharing an
 * id are two elements the shell cannot tell apart.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {{ width?: number, menu?: boolean }} [options]
 */
export function popoverSurface(tokens, id, options = {}) {
  const { width = style().spacing.dropdownWidth, menu = false } = options;
  return new PopupSurface(id)
    .build(context(tokens))
    .when(menu, (element) => element.role("menu"))
    .w(width)
    .gap(menu ? style().spacing.xxs : style().spacing.sm)
    .p(menu ? style().spacing.xs : style().spacing.md);
}

/**
 * The frame around a list's filter box.
 *
 * A filter is the one text input a read-only terminal has: it narrows what is
 * already on screen and reaches nothing outside the window. The state it draws
 * lives on the view — `InputState.new()` needs a live host call and belongs in
 * `init`, never in a render.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {import("gpui-base").InputState} state
 * @param {number} [width]
 */
export function filterInput(tokens, state, width = 180) {
  // `small`, because every other control in the toolbars this sits in --
  // `iconAction`, `menuTrigger` -- is small. At the default `medium` the field
  // stood four pixels taller than the buttons beside it and set the height of
  // the whole row, so a strip of quiet chrome asked for more of the pane than
  // the table under it.
  return new NativeInput(state).w(width).h(style().space(24)).py(0);
}

/**
 * A field whose value is in something: a price in a currency, a size in
 * shares.
 *
 * The unit goes to the field rather than beside it, because it belongs to the
 * value. Beside it, a reader has to work out whether the word is part of this
 * control or the label of the next one, and the answer moves with the width of
 * the column they are in.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {import("gpui-base").InputState} state
 * @param {{ unit?: string, width?: number }} [options]
 */
export function valueField(tokens, state, options = {}) {
  const { unit = "", width } = options;
  const field = new NativeInput(state);
  if (unit) field.child(label(tokens, unit));
  if (width !== undefined) field.w(width);
  return field;
}

/**
 * Controls attached to a table use the same inline inset as its header and
 * rows, so the filter, first heading and first cell share one content edge.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 */
export function tableToolbar(tokens, id) {
  return new Toolbar(id).build(context(tokens));
}

/**
 * The `⋯` control a popup menu or a popover hangs from. Icon-only, which is
 * the case a tooltip exists for.
 *
 * `open` is not decoration, and it has to be drawn differently from focus
 * rather than with the same fill. A `Popover` takes the keyboard into its
 * surface while it is up and hands it back to the trigger when it dismisses,
 * so a trigger whose focus style is the open style reads the state backwards
 * in both directions: flat while the menu shows, then lit once it is gone.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {string} hint
 * @param {boolean} [open]
 */
export function menuTrigger(tokens, id, hint, open = false) {
  return new GlyphButton(id)
    .glyph("⋯")
    .description(hint)
    .selected(open)
    .quiet()
    .size("small")
    .build(context(tokens));
}

/**
 * The height every watchlist row is drawn at, and the size the virtual list
 * hands GPUI for each of them. The two have to agree exactly — the list places
 * rows from this number without measuring them — so the row states it rather
 * than letting padding and two lines of type add up to whatever they add up to.
 */
export const QUOTE_ROW_HEIGHT = 44;

/**
 * The two row fills, as fractions of the theme's `muted` over the surface.
 * The selection sits at half strength -- the full token was a heavy band on a
 * table read for hours -- and the pointer one step below that, so the row
 * under the pointer never outweighs the row the panels are showing.
 */
const ROW_SELECTED_ALPHA = 0.5;
const ROW_HOVER_ALPHA = 0.25;

/**
 * The two states a row can be in besides the pointer's own.
 *
 * `selected` is the row the detail panels are showing, and it is a fill. The
 * kit lights a selected row with `accent` and hovers it with `muted`, and on
 * a table that is read for hours both read as a heavy band across the list
 * rather than as a place-keeper. So the row is built unselected and two
 * lighter fills are written over it here -- `muted` at half strength for the
 * selection, a quarter for the pointer -- and the pressed state is the kit's
 * own.
 *
 * `menuTarget` is the row a menu is open for, and it is an outline. A menu opens
 * on whatever row was pressed, which need not be the selected one, and while
 * it is open the reader has to be able to tell the two apart: the fill says
 * "this is what the panels show", the ring says "this is what the menu will
 * act on". An outline rather than a second fill because the two can coincide,
 * and a ring over a fill still reads as both. Drawn as an overlay rather than
 * as the row's own border so the row's box does not change by a pixel when a
 * menu opens over it.
 *
 * @template {import("gpui-kit").Element} T
 * @param {import("gpui-base").Theme} tokens
 * @param {T} row
 * @param {{ selected?: boolean, menuTarget?: boolean }} state
 * @returns {T}
 */
function rowState(tokens, row, state) {
  const selected = Boolean(state.selected);
  const selectedFill = alpha(tokens.muted, ROW_SELECTED_ALPHA);
  return row
    // Both fills are the same hue at two strengths, so the two states read
    // as one scale rather than two colours. A selected row under the pointer
    // keeps the selected fill.
    .hover((appearance) =>
      appearance.bg(selected ? selectedFill : alpha(tokens.muted, ROW_HOVER_ALPHA)),
    )
    .when(selected, (element) => element.bg(selectedFill))
    .when(Boolean(state.menuTarget), (element) =>
      element
        .relative()
        .child(
          div()
            .absolute()
            .inset_0()
            .border(1)
            .border_color(tokens.ring),
        ),
    );
}

/**
 * A watchlist row, as a table row rather than a button that looks like one.
 *
 * It registers no click handler of its own: rows are rebuilt every frame the
 * virtual list is scrolled, and a per-row callback would accumulate one
 * unreachable function per row per frame. The list carries a single
 * `on_item_click` instead and reports the instrument's stable key.
 *
 * `rowIndex` is the row's zero-based position in the whole collection; what is
 * announced is that plus two, because the header above it is row one. Selection
 * is reported separately as the virtual list's stable instrument key, not this
 * transient layout index.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeQuoteRow} quote
 * @param {boolean} selected
 * @param {number} rowIndex
 * @param {number} [now]
 * @param {boolean} [compact]
 * @param {boolean} [menuTarget] A menu is open for this row.
 */
export function quoteRow(
  tokens,
  quote,
  selected,
  rowIndex = 0,
  now = Date.now(),
  compact = false,
  menuTarget = false,
) {
  const cx = context(tokens);
  const tone = changeTone(tokens, quote.change);
  const row = new TableRow(`quote-${quote.symbol}`, rowIndex)
    .height(QUOTE_ROW_HEIGHT)
    .dimmed(!quote.receivedAt);

  row.cell(
    { width: compact ? "60%" : "31%" },
    h_flex()
      .items_center()
      .min_w(0)
      .gap(style().spacing.sm)
      // The badge is an avatar with only its fallback filled: there is no
      // per-market artwork in the application directory, and an image that
      // never resolves is the case the fallback exists for.
      .when(!compact, (cell) => cell.child(marketAvatar(tokens, quote.code || quote.symbol)))
      .child(
        new CellStack()
          .child(label(tokens, compact ? quote.symbol : quote.code).truncate())
          .child(muted(tokens, quote.name).truncate())
          .build(cx),
      ),
  );

  row.cell(
    { width: compact ? "40%" : "19%", align: "end" },
    compact
      ? new CellStack()
          .align("end")
          .child(numeric(tokens, quote.last).truncate())
          .child(numeric(tokens, quote.changePercent).truncate().text_color(tone))
          .build(cx)
      : numeric(tokens, quote.last).truncate(),
  );

  if (!compact) {
    row.cell(
      { width: "18%", align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, quote.changePercent).text_color(tone))
        .child(numeric(tokens, quote.change).text_color(tone))
        .build(cx),
    );
    row.cell({ width: "16%", align: "end" }, muted(tokens, formatCompactNumber(quote.volume)));
    row.cell({ align: "end" }, muted(tokens, tradeStatusLabel(quote)));
  }

  return rowState(tokens, row.build(cx), { selected, menuTarget }).transition("opacity", MOTION);
}

function detailStatus(tokens, state, empty) {
  if (state?.status === "loading") return muted(tokens, "Loading live market data…");
  if (state?.status === "error")
    return muted(tokens, state.error || "Live market data is unavailable. Reconnect to try again.");
  return muted(tokens, empty);
}

function detailNumber(value) {
  return value === undefined || value === null ? "—" : formatCompactNumber(value);
}

function tradeDirection(tokens, direction) {
  if (direction === 2) return { text: "↑ Up", tone: statusColors(tokens).up };
  if (direction === 1) return { text: "↓ Down", tone: statusColors(tokens).down };
  return { text: "• Neutral", tone: tokens.muted_foreground };
}

function depthRow(tokens, side, level) {
  const levelId = level.position ?? level.price;
  return h_flex()
    .id(`order-book-${side}-level-${levelId}`)
    .items_center()
    .min_w(0)
    .h(22)
    .px(style().spacing.sm)
    .child(
      muted(tokens, `${side === "ask" ? "Ask" : "Bid"} ${level.position ?? ""}`)
        .w("28%")
        .min_w(0)
        .truncate(),
    )
    .child(
      numeric(tokens, level.price ?? "—")
        .w("36%")
        .min_w(0)
        .truncate()
        .text_right(),
    )
    .child(numeric(tokens, detailNumber(level.volume)).w("36%").min_w(0).truncate().text_right());
}

function orderBookStatus(state, hasDepth) {
  if (state?.status === "loading") return "Loading";
  if (state?.status === "error") return "Error";
  if (state?.status !== "ready" || !hasDepth) return "Empty";
  return "Live";
}

/**
 * The selected instrument's five-by-five depth book. The server sends nearest
 * levels first; asks are reversed so the best ask sits at the spread and bids
 * remain nearest-first below it. Missing levels are not synthetic rows.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeDepthState} state
 * @param {{ bid: number, ask: number }} ratio
 */
export function orderBookPanel(tokens, state, ratio) {
  const asks = Array.isArray(state?.asks)
    ? state.asks.filter(validDepthLevel).slice(0, 5).reverse()
    : [];
  const bids = Array.isArray(state?.bids) ? state.bids.filter(validDepthLevel).slice(0, 5) : [];
  const hasDepth = asks.length > 0 || bids.length > 0;
  const bidPercent = Math.round((ratio?.bid ?? 0) * 100);
  const askPercent = Math.max(0, 100 - bidPercent);
  const status = orderBookStatus(state, hasDepth);
  return v_flex()
    .id("order-book-panel")
    .w_full()
    .min_w(0)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .px(style().spacing.sm)
        .py(style().spacing.xs)
        .child(new Label("Order Book").strong().build(context(tokens)))
        .child(muted(tokens, status)),
    )
    .child(rule(tokens))
    .child(
      state?.status !== "ready"
        ? v_flex()
            .p(style().spacing.md)
            .child(detailStatus(tokens, state, "No order book data"))
        : hasDepth
          ? v_flex()
              .py(style().spacing.xs)
              .children(asks.map((level) => depthRow(tokens, "ask", level)))
              .child(
                h_flex()
                  .id("order-book-ratio-divider")
                  .items_center()
                  .h(22)
                  .px(style().spacing.sm)
                  .child(muted(tokens, `Bid ${bidPercent}%`).w("28%").min_w(0).truncate())
                  .child(
                    h_flex()
                      .flex_1()
                      .h(5)
                      .overflow_hidden()
                      .bg(tokens.muted)
                      .child(div().h_full().w(`${bidPercent}%`).bg(statusColors(tokens).up))
                      .child(div().h_full().w(`${askPercent}%`).bg(statusColors(tokens).down)),
                  )
                  .child(
                    muted(tokens, `Ask ${askPercent}%`).w("28%").min_w(0).truncate().text_right(),
                  ),
              )
              .children(bids.map((level) => depthRow(tokens, "bid", level)))
          : div().h(0),
    );
}

function tradeTime({ symbol, market }, timestamp) {
  const marketSymbol = symbol || (market ? `market.${market}` : "");
  return formatMarketTime(marketSymbol, timestamp, true) || "--";
}

function tradeRow(tokens, trade, maximum, ctx) {
  const direction = tradeDirection(tokens, trade.direction);
  const ratio = Math.round(tradeVolumeRatio(trade.volume, maximum) * 100);
  const identity = tradeIdentity(trade);
  return h_flex()
    .id(`time-sales-row-${identity}`)
    .relative()
    .items_center()
    .min_w(0)
    .h(24)
    .gap(style().spacing.sm)
    .px(style().spacing.sm)
    .child(muted(tokens, tradeTime(ctx, trade.timestamp)).w("24%").min_w(0).truncate())
    .child(muted(tokens, direction.text).w("25%").min_w(0).truncate().text_color(direction.tone))
    .child(
      numeric(tokens, trade.price ?? "—")
        .flex_1()
        .min_w(0)
        .truncate()
        .text_right(),
    )
    .child(
      div()
        .relative()
        .w("28%")
        .min_w(0)
        .h_full()
        .overflow_hidden()
        .child(
          div()
            .absolute()
            .right(0)
            .top(3)
            .bottom(3)
            .w(`${ratio}%`)
            .bg(direction.tone)
            .opacity(volumeIntensity(ratio)),
        )
        .child(
          numeric(tokens, detailNumber(trade.volume))
            .relative()
            .size_full()
            .flex()
            .items_center()
            .justify_end()
            .truncate(),
        ),
    );
}

function volumeIntensity(ratio) {
  return Math.max(0.35, Math.min(1, 0.35 + (Math.max(0, ratio) / 100) * 0.65));
}

/** @param {import("gpui-base").Theme} tokens @param {LongbridgeTradesState} state @param {{ symbol?: string, market?: string }} [ctx] */
export function timeSalesPanel(tokens, state, ctx = {}) {
  const trades = Array.isArray(state?.trades) ? state.trades.slice(0, 20) : [];
  const maximum = trades.reduce((largest, trade) => {
    const volume =
      typeof trade?.volume === "bigint"
        ? trade.volume < 0n
          ? -trade.volume
          : trade.volume
        : Math.abs(Number(trade?.volume) || 0);
    return typeof largest === "bigint" || typeof volume === "bigint"
      ? BigInt(largest) > BigInt(volume)
        ? largest
        : volume
      : Math.max(largest, volume);
  }, 0);
  const status =
    state?.status === "loading"
      ? "Loading"
      : state?.status === "error"
        ? "Error"
        : state?.status !== "ready" || !trades.length
          ? "Empty"
          : `${trades.length} ${trades.length === 1 ? "trade" : "trades"}`;
  return v_flex()
    .id("time-sales-panel")
    .w_full()
    .min_w(0)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .px(style().spacing.sm)
        .py(style().spacing.xs)
        .child(new Label("Time & Sales").strong().build(context(tokens)))
        .child(muted(tokens, status)),
    )
    .child(rule(tokens))
    .child(
      state?.status !== "ready"
        ? v_flex()
            .p(style().spacing.md)
            .child(detailStatus(tokens, state, "No recent trades"))
        : trades.length
          ? v_flex()
              .py(style().spacing.xs)
              .children(trades.map((trade) => tradeRow(tokens, trade, maximum, ctx)))
          : v_flex()
              .p(style().spacing.md)
              .child(detailStatus(tokens, state, "No recent trades")),
    );
}

function marketTime(timestamp) {
  if (!timestamp) return "--";
  return `${new Date(timestamp).toISOString().slice(11, 19)} UTC`;
}

function dataHealth(quote, now) {
  const freshness = quoteFreshness(quote, now);
  if (freshness === "waiting") return "Waiting for first quote";
  const age = Math.max(0, Math.floor((now - quote.receivedAt) / 1_000));
  return `${freshness === "live" ? "Live" : "Stale"} · ${age}s ago`;
}

/**
 * The readings of a quote, as a wrapping grid of tiles.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {{ title: string, value: string, tone?: string }[]} entries
 */
function statGrid(tokens, id, entries) {
  const cx = context(tokens);
  return new MetricGrid(id)
    .children(
      entries.map((entry) =>
        new Metric(entry.title).value(String(entry.value)).tone(entry.tone).build(cx),
      ),
    )
    .build(cx);
}

/**
 * The selected instrument, as one column: who it is and what it costs, then
 * the readings that change during a session, then everything else behind a
 * disclosure.
 *
 * The identity and the price share the first row rather than stacking in a
 * cell of their own. They are the two halves of one sentence — this security,
 * this price — and the widest thing on screen is the price, so it is set
 * against the pane's right edge where a column of figures would be. What
 * follows is a wrapping grid: the same readings whatever the pane's width,
 * arranged by how much width there is.
 *
 * The disclosure is the pane's own state, passed in, because a section that
 * remembered whether it was open would forget every time the quote ticked.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeQuoteRow} quote
 * @param {number} [now]
 * @param {number} [pulseOpacity]
 * @param {{ open?: boolean, onToggle?: (open: boolean, cx: import("gpui-kit").Context) => void }} [disclosure]
 */
export function quoteDetail(tokens, quote, now = Date.now(), pulseOpacity = 1, disclosure = {}) {
  const cx = context(tokens);
  const tone = changeTone(tokens, quote.change);
  const { open = false, onToggle = () => {} } = disclosure ?? {};
  const dayRange =
    quote.low === "--" || quote.high === "--" ? "--" : `${quote.low} — ${quote.high}`;
  return v_flex()
    .id("quote-detail-content")
    .w_full()
    .min_w(0)
    .child(
      h_flex()
        .id("quote-detail-heading")
        .items_start()
        .justify_between()
        .gap(style().spacing.md)
        .px(style().spacing.sm)
        .pt(style().spacing.sm)
        .pb(style().spacing.xs)
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(style().spacing.xxs)
            .child(new Label(String(quote.name)).size("heading").strong().truncate().build(cx))
            .child(
              muted(tokens, `${quote.market} · ${quote.symbol} · ${quote.currency}`).truncate(),
            ),
        )
        .child(
          v_flex()
            .id("quote-detail-price")
            .flex_none()
            .items_end()
            .gap(style().spacing.xxs)
            .opacity(quote.receivedAt ? pulseOpacity : 0.72)
            .transition("opacity", MOTION)
            .child(numeric(tokens, quote.last, "display"))
            .child(numeric(tokens, `${quote.change} · ${quote.changePercent}`).text_color(tone)),
        ),
    )
    .child(rule(tokens))
    .child(
      statGrid(tokens, "quote-detail-stats", [
        { title: "Previous close", value: quote.prevClose },
        { title: "Open", value: quote.open },
        { title: "High", value: quote.high },
        { title: "Low", value: quote.low },
        { title: "Volume", value: formatCompactNumber(quote.volume) },
        { title: "Turnover", value: formatCompactNumber(quote.turnover) },
      ]),
    )
    .child(rule(tokens))
    .child(
      accordionGroup(tokens, "quote-detail-sections").child(
        accordionSection(tokens, {
          id: "quote-detail-more",
          title: "More detail",
          detail: tradeStatusLabel(quote, now),
          level: 3,
          open,
          inset: style().spacing.sm,
          onToggle,
          body: statGrid(tokens, "quote-detail-more-stats", [
            { title: "Day range", value: dayRange },
            { title: "Amplitude", value: amplitude(quote) },
            { title: "Average price", value: averagePrice(quote) },
            {
              title: "From open",
              value: changeFromOpen(quote),
              tone: changeTone(tokens, changeFromOpen(quote)),
            },
            { title: "Last market update", value: marketTime(quote.updatedAt) },
            { title: "Data health", value: dataHealth(quote, now) },
            { title: "Stream sequence", value: String(quote.sequence ?? "--") },
          ]),
        }),
      ),
    );
}

// The ring's categorical hues live in `palette.js` with the status row: they
// are the other thing the semantic token set cannot carry, and one module owns
// every colour this application draws that is not a token.

// Trimmed from both ends of every wedge so neighbouring fills are separated by
// the surface rather than meeting flush. Skipped when one holding is the whole
// ring, which would otherwise leave a gap in a solid circle.
const WEDGE_GAP_RADIANS = 0.02;

/** The ring's drawn size. `allocationSliceAt` measures the pointer against it. */
const RING_SIZE = 148;

/**
 * One wedge.
 *
 * `state` is what the pointer is doing to the ring: `"lit"` for the wedge
 * being pointed at, `"dimmed"` for the others while one is, and `"resting"`
 * when nothing is. A lit wedge reaches further out than the ring and keeps its
 * full colour; the rest fade back, which is what makes the one being read
 * legible without redrawing the legend beside it.
 *
 * The reach is a geometry change and lands at once; the fade is an opacity
 * change and is what actually animates. Interpolating the path itself is not
 * something this runtime can do, and a wedge that grew over 150ms while its
 * neighbours faded over the same 150ms would be two animations to watch.
 */
function donutSlice(tokens, slice, index, total, count, state = "resting") {
  const span = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
  const gap = count > 1 ? Math.min(WEDGE_GAP_RADIANS, span / 4) : 0;
  const start = (total > 0 ? (slice.offset / total) * Math.PI * 2 : 0) - Math.PI / 2 + gap;
  const end = start + span - gap * 2;
  const steps = Math.max(4, Math.ceil(((end - start) / (Math.PI * 2)) * 48));
  const outer = state === "lit" ? 50 : 48;
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = start + ((end - start) * step) / steps;
    points.push([`${50 + Math.cos(angle) * outer}%`, `${50 + Math.sin(angle) * outer}%`]);
  }
  for (let step = steps; step >= 0; step -= 1) {
    const angle = start + ((end - start) * step) / steps;
    points.push([`${50 + Math.cos(angle) * 29}%`, `${50 + Math.sin(angle) * 29}%`]);
  }
  return window
    .paint_path(
      PathBuilder.fill().add_polygon(points).build(),
      Background.solid(allocationColor(tokens, slice, index)),
    )
    .absolute()
    .inset_0()
    .opacity(state === "dimmed" ? 0.4 : 1)
    .transition("opacity", MOTION);
}

/**
 * The ring, and the legend that says what its colours mean.
 *
 * A wedge cannot be pointed at directly -- every wedge is painted into the
 * same square, so the box a pointer is over is the whole ring -- so the legend
 * row is the handle: pointing at a row lights its wedge, and the ring answers
 * the question the row asks.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {ReturnType<import("./portfolio.js").allocationInUsd>} group
 * @param {{ hovered?: string | null, onHover?: (symbol: string | null, cx: import("gpui-kit").Context) => void }} [pointer]
 */
export function allocationChart(tokens, group, pointer = {}) {
  const { hovered = null, onHover = null } = pointer;
  const unpriced = group.unpriced.length;
  let offset = 0;
  const slices = foldAllocationSlices(group).map((slice) => {
    const result = { ...slice, offset };
    offset += slice.value;
    return result;
  });
  const legend = Table.new(`allocation-${group.currency}`)
    .column_count(3)
    .row_count(slices.length)
    .flex_1()
    .min_w(220)
    .child(
      TableBody.new(`allocation-${group.currency}-body`).children(
        slices.map((slice, index) =>
          BaseTableRow.new(`allocation-${group.currency}-${slice.symbol}`, index + 1)
            .relative()
            .flex()
            .items_center()
            .py(style().spacing.xs)
            .px(style().spacing.xs)
            .border_b(style().spacing.hairline)
            .border_color(tokens.border)
            .bg(hovered === slice.symbol ? tokens.accent : tokens.surface)
            .transition("opacity", MOTION)
            .child(
              BaseTableCell.new(`allocation-name-${slice.symbol}`, 1)
                .flex()
                .items_center()
                .gap(style().spacing.xs)
                .flex_1()
                .child(
                  div()
                    .w(7)
                    .h(7)
                    .bg(allocationColor(tokens, slice, index)),
                )
                .child(label(tokens, slice.name)),
            )
            .child(
              BaseTableCell.new(`allocation-value-${slice.symbol}`, 2)
                .w(90)
                .text_right()
                .child(numeric(tokens, slice.value.toFixed(2), "bodySmall")),
            )
            .child(
              BaseTableCell.new(`allocation-percent-${slice.symbol}`, 3)
                .w(64)
                .text_right()
                .child(numeric(tokens, `${slice.percent.toFixed(1)}%`, "bodySmall")),
            )
            // The handler is on a plain element covering the row, not on the
            // row: a table part carries its click and its hover *styles*, and
            // an `on_hover` written on one is dropped on the way through. The
            // sheet is transparent and takes nothing away from the cells under
            // it, which answer to nothing.
            .when(Boolean(onHover), (row) =>
              row.child(
                div()
                  .id(`allocation-hover-${group.currency}-${slice.symbol}`)
                  .absolute()
                  .inset_0()
                  .on_hover((over, cx) => onHover(over ? slice.symbol : null, cx)),
              ),
            ),
        ),
      ),
    );

  return v_flex()
    .gap(style().spacing.sm)
    .child(
      h_flex()
        .justify_between()
        .child(new Label(String(group.currency)).strong().build(context(tokens)))
        .child(smallCaps(tokens, "Allocation")),
    )
    .child(
      h_flex()
        .flex_wrap()
        .items_center()
        .gap(style().spacing.lg)
        .child(
          div()
            .id(`allocation-ring-${group.currency}`)
            .relative()
            .w(RING_SIZE)
            .h(RING_SIZE)
            .flex_none()
            .when(Boolean(onHover), (ring) =>
              ring
                // A wedge cannot carry the handler -- every wedge is painted
                // into this same box, so all of them would report themselves
                // at once. The box carries it, and `allocationSliceAt` says
                // which wedge the pointer is actually over.
                .on_mouse_move((event, cx) =>
                  onHover(
                    allocationSliceAt(slices, group.total, event.local_position, {
                      width: RING_SIZE,
                      height: RING_SIZE,
                    }),
                    cx,
                  ),
                )
                .on_hover((over, cx) => {
                  if (!over) onHover(null, cx);
                }),
            )
            .children(
              slices.map((slice, index) =>
                donutSlice(
                  tokens,
                  slice,
                  index,
                  group.total,
                  slices.length,
                  hovered === null ? "resting" : hovered === slice.symbol ? "lit" : "dimmed",
                ),
              ),
            ),
        )
        .child(legend),
    )
    .when(unpriced > 0, (element) =>
      element.child(muted(tokens, `${unpriced} unpriced position${unpriced === 1 ? "" : "s"}`)),
    );
}

/**
 * @param {import("gpui-base").Theme} tokens
 * @param {{ title: string, value: string }[]} entries
 * @param {string} [id]
 */
export function detailGrid(tokens, entries, id = "detail-grid") {
  const list = new DefinitionList(id);
  for (const entry of entries) list.entry(entry.title, String(entry.value));
  return list.build(context(tokens));
}

/**
 * An account's readings, the largest first.
 *
 * Total assets leads because it is the number a reader looks for, and because
 * it is the one that is *not* on the account endpoint -- `net_assets` is net
 * of what was borrowed, and on a margin account the two differ by the debt.
 * Both are shown: one says what is held, the other what of it is the holder's.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {{ netAssets: string, totalCash: string, buyingPower: string, currency: string }} account
 * @param {{ currency: string, todayPnl: string, todayPnlValue: number, totalPnl: string, totalPnlValue: number }[]} summaries
 * @param {{ total: number, currency: string, partial: boolean } | null} totals
 */
export function portfolioSummary(tokens, account, summaries, totals = null) {
  const cx = context(tokens);
  // Wide tiles: an account's readings are money with a currency after them,
  // which is two or three times the width of a price.
  const metric = (title, value, tone) =>
    new Metric(title).value(value).size("heading").basis(170).tone(tone).build(cx);
  const pnl = summaries.length
    ? summaries
    : [
        {
          currency: account.currency,
          todayPnl: "--",
          totalPnl: "--",
          todayPnlValue: 0,
          totalPnlValue: 0,
        },
      ];

  return new MetricGrid("portfolio-summary")
    .children(
      totals
        ? [
            metric(
              // A total missing a position is an understatement, and an
              // understatement written as a plain number reads as a fact. The
              // title is where that is said, because a Metric has nowhere else
              // to say it; the allocation card below counts what is missing.
              totals.partial ? "Total assets (partial)" : "Total assets",
              `${totals.total.toFixed(2)} ${totals.currency}`,
            ),
          ]
        : [],
    )
    .child(metric("Net assets", `${account.netAssets} ${account.currency}`))
    .children(
      pnl.map((summary) =>
        metric(
          "Today's P/L",
          `${summary.todayPnl} ${summary.currency}`,
          valueTone(tokens, summary.todayPnlValue),
        ),
      ),
    )
    .children(
      pnl.map((summary) =>
        metric(
          "Total P/L",
          `${summary.totalPnl} ${summary.currency}`,
          valueTone(tokens, summary.totalPnlValue),
        ),
      ),
    )
    .child(metric("Cash", `${account.totalCash} ${account.currency}`))
    .child(metric("Buying power", `${account.buyingPower} ${account.currency}`))
    .build(cx)
    .gap_x(style().spacing.xl);
}

const HOLDINGS_COLUMNS = [
  { title: "Instrument", width: "26%" },
  { title: "Quantity", width: "12%", align: "end" },
  { title: "Last / Cost", width: "20%", align: "end" },
  { title: "Today's P/L", width: "20%", align: "end" },
  { title: "Total P/L", align: "end" },
];

/** @param {import("gpui-base").Theme} tokens */
export function holdingsHeader(tokens) {
  return tableHeaderRow(tokens, "holdings", HOLDINGS_COLUMNS);
}

/**
 * The height Holdings rows are drawn at. See `QUOTE_ROW_HEIGHT`.
 *
 * Tighter than a watchlist row: two lines of type and a hairline come to 39.75,
 * so this is that plus a little, and no more. A portfolio is read as a block —
 * how much of it fits at once matters more than how much air each row has.
 */
export const HOLDING_ROW_HEIGHT = 42;

/**
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeHoldingRow} holding
 * @param {boolean} selected
 * @param {number} rowIndex
 * @param {boolean} [menuTarget] A menu is open for this row.
 */
export function holdingRow(tokens, holding, selected = false, rowIndex = 0, menuTarget = false) {
  const cx = context(tokens);
  const todayTone = valueTone(tokens, holding.todayPnlValue);
  const totalTone = valueTone(tokens, holding.totalPnlValue);
  const row = new TableRow(`holding-${holding.symbol}`, rowIndex)
    .height(HOLDING_ROW_HEIGHT)
    .cell(
      { width: "26%" },
      new CellStack()
        .child(label(tokens, holding.symbol))
        .child(muted(tokens, holding.name))
        .build(cx),
    )
    .cell({ width: "12%", align: "end" }, numeric(tokens, holding.quantity))
    .cell(
      { width: "20%", align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, holding.last))
        .child(muted(tokens, holding.costPrice))
        .build(cx),
    )
    .cell({ width: "20%", align: "end" }, numeric(tokens, holding.todayPnl).text_color(todayTone))
    .cell(
      { align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, holding.totalPnl).text_color(totalTone))
        .child(numeric(tokens, holding.totalPnlPercent, "bodySmall").text_color(totalTone))
        .build(cx),
    )
    .build(cx);
  return rowState(tokens, row, { selected, menuTarget });
}

const ORDER_COLUMNS = [
  { title: "Instrument", width: "25%" },
  { title: "Side", width: "12%" },
  { title: "Status", width: "19%" },
  { title: "Filled", width: "14%", align: "end" },
  { title: "Price", width: "15%", align: "end" },
  { title: "Submitted", align: "end" },
];

/**
 * The two order tables are one table twice, so the id is a parameter: a header
 * that named itself would give Today and History the same cell identities.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 */
export function ordersHeader(tokens, id) {
  return tableHeaderRow(tokens, id, ORDER_COLUMNS);
}

/** The height Orders rows are drawn at. Two lines and a hairline, as Holdings. */
export const ORDER_ROW_HEIGHT = 42;

/**
 * The colour an order's outcome is drawn in.
 *
 * A status is not a signed number, so it does not go through `valueTone`: it
 * is filled, still working, refused, or over. Only the first two are readings
 * a market colour belongs to; the rest stay in the interface's own foregrounds
 * so a list of cancellations does not look like a list of losses.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} kind
 */
export function orderStatusTone(tokens, kind) {
  const status = statusColors(tokens);
  if (kind === "filled") return status.up;
  if (kind === "working") return status.info;
  if (kind === "rejected") return status.down;
  return tokens.muted_foreground;
}

/**
 * The colour a direction is drawn in.
 *
 * Buying and selling are readings, not interface roles, so they take the same
 * two colours a rising and a falling number take rather than the accent and
 * the destructive token -- selling is not destruction. One function so a row,
 * a menu item, a button and a ticket heading cannot drift apart on it.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} side `buy` or `sell`, in any case.
 * @returns {import("gpui-kit").Color}
 */
export function tradeSideTone(tokens, side) {
  const status = statusColors(tokens);
  const kind = String(side ?? "").toLowerCase();
  if (kind === "buy") return status.up;
  if (kind === "sell") return status.down;
  return tokens.foreground;
}

/**
 * One order, as two lines per column: what was asked for over what happened.
 *
 * The columns are the Longbridge terminal's -- instrument, side, type, status,
 * quantity, executed quantity, price and time -- folded in half. A desktop row
 * has two lines where a TUI row has one, so each pair that is only ever read
 * together shares a column instead of taking one of its own.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeOrderRow} order
 * @param {number} rowIndex
 * @param {boolean} [selected] Whether the detail panel is showing this order.
 * @param {boolean} [menuTarget] A menu is open for this row.
 */
export function orderRow(tokens, order, rowIndex = 0, selected = false, menuTarget = false) {
  const cx = context(tokens);
  const sideTone = tradeSideTone(tokens, order.sideKind);
  const seconds = order.submittedAt > 0 ? Math.trunc(order.submittedAt / 1_000) : null;
  const time = seconds === null ? "--" : formatMarketTime(order.symbol, seconds, true);
  const day = seconds === null ? "" : formatMarketDate(order.symbol, seconds);
  const row = new TableRow(`order-${order.orderId}`, rowIndex)
    .height(ORDER_ROW_HEIGHT)
    .cell(
      { width: "25%" },
      new CellStack()
        .child(label(tokens, order.symbol).truncate())
        .child(muted(tokens, order.name).truncate())
        .build(cx),
    )
    .cell(
      { width: "12%" },
      new CellStack()
        .child(label(tokens, order.sideLabel).text_color(sideTone).truncate())
        .child(muted(tokens, order.type).truncate())
        .build(cx),
    )
    .cell(
      { width: "19%" },
      new CellStack()
        .child(
          label(tokens, order.statusLabel)
            .text_color(orderStatusTone(tokens, order.statusKind))
            .truncate(),
        )
        .child(muted(tokens, order.message || order.remark || "").truncate())
        .build(cx),
    )
    .cell(
      { width: "14%", align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, order.executedQuantity).truncate())
        .child(muted(tokens, `of ${order.quantity}`).truncate())
        .build(cx),
    )
    .cell(
      { width: "15%", align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, order.price).truncate())
        .child(muted(tokens, order.executedPrice).truncate())
        .build(cx),
    )
    .cell(
      { align: "end" },
      new CellStack()
        .align("end")
        .child(numeric(tokens, time).truncate())
        .child(muted(tokens, day).truncate())
        .build(cx),
    )
    .build(cx);
  return rowState(tokens, row, { selected, menuTarget });
}

/**
 * One order in full, as the sheet a right-hand panel carries.
 *
 * The Longbridge terminal answers a click with a label/value sheet in three
 * groups -- what was ordered, what happened to it, and when -- and this is
 * that sheet. Rows whose value the API did not send are left out rather than
 * drawn as a dash: a panel of dashes reads as missing data, and what is
 * actually true is that the order has no trigger and was never amended.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {LongbridgeOrderRow} order
 * @param {{ onReplace?: Function | null, onCancel?: Function | null, canReplace?: boolean, canCancel?: boolean }} [actions]
 */
export function orderDetail(tokens, order, actions = {}) {
  // Each action is offered or it is not; there is no third state. A control
  // drawn and disabled is a row of grey saying nothing a reader can act on,
  // and the status above it already says why it cannot.
  const { onReplace = null, onCancel = null } = actions;
  const cx = context(tokens);
  const sideTone = tradeSideTone(tokens, order.sideKind);
  const stamp = (value) => {
    if (!value) return "";
    const seconds = Math.trunc(value / 1_000);
    return `${formatMarketDate(order.symbol, seconds)} ${formatMarketTime(order.symbol, seconds, true)}`;
  };
  const section = (id, title, entries) =>
    v_flex()
      .gap(style().spacing.sm)
      .child(smallCaps(tokens, title))
      .child(
        detailGrid(
          tokens,
          entries.filter((entry) => entry.value),
          id,
        ),
      );
  const amount = (value) =>
    value === "--" || value === "" ? "" : order.currency ? `${value} ${order.currency}` : value;
  return (
    v_flex()
      .id(`order-detail-${order.orderId}`)
      .w_full()
      .gap(style().spacing.md)
      .px(style().spacing.md)
      .py(style().spacing.md)
      .child(
        v_flex()
          .gap(style().spacing.xxs)
          .child(new Label(String(order.symbol)).size("title").strong().truncate().build(cx))
          .child(muted(tokens, order.name).truncate())
          .child(
            h_flex()
              .items_center()
              .gap(style().spacing.xs)
              .child(
                label(tokens, order.statusLabel).text_color(
                  orderStatusTone(tokens, order.statusKind),
                ),
              )
              .child(muted(tokens, "·"))
              .child(label(tokens, order.sideLabel).text_color(sideTone))
              .child(muted(tokens, order.type)),
          ),
      )
      // What can still be done to this order, beside what it is, rather than
      // only behind a right-click on the row that opened this sheet -- the sheet
      // exists precisely so that row does not have to be found again. Both are
      // drawn whatever the status and disabled where the status says they would
      // only be refused, which is the choice the row menu makes and for the same
      // reason: controls that come and go have to be re-read every time.
      .when(Boolean(onReplace || onCancel), (element) =>
        element.child(
          h_flex()
            .gap(style().spacing.sm)
            .when(Boolean(onReplace), (row) =>
              row.child(
                // The ellipsis is the desktop's promise that a command needs
                // more from you before it does anything: Modify opens a ticket
                // to fill in. Withdraw does not have one -- what follows it is
                // a confirmation, not a form.
                action(
                  tokens,
                  `order-detail-replace-${order.orderId}`,
                  "Modify…",
                  onReplace,
                ).flex_1(),
              ),
            )
            .when(Boolean(onCancel), (row) =>
              row.child(
                // Outlined, like Modify beside it: the two are peers, and a
                // borderless one reads as the lesser of them. Destructive
                // carries the colour, and in this kit that is a red label and
                // a red edge rather than a solid block -- which would be the
                // loudest thing on a panel opened to read an order.
                action(tokens, `order-detail-cancel-${order.orderId}`, "Withdraw", onCancel, {
                  variant: "destructive",
                }).flex_1(),
              ),
            ),
        ),
      )
      .child(rule(tokens))
      .child(
        section(`order-detail-${order.orderId}-order`, "Order", [
          { title: "Time in force", value: order.timeInForce },
          { title: "Currency", value: order.currency },
          { title: "Outside RTH", value: order.outsideRth },
          { title: "Channel", value: order.tag },
        ]),
      )
      .child(
        section(`order-detail-${order.orderId}-execution`, "Execution", [
          { title: "Quantity", value: order.quantity },
          { title: "Filled", value: order.executedQuantity },
          { title: "Price", value: amount(order.price) },
          { title: "Filled price", value: amount(order.executedPrice) },
          { title: "Last done", value: amount(order.lastDone) },
          { title: "Trigger price", value: amount(order.triggerPrice) },
        ]),
      )
      .child(
        section(`order-detail-${order.orderId}-timing`, "Timing", [
          { title: "Submitted", value: stamp(order.submittedAt) },
          { title: "Updated", value: stamp(order.updatedAt) },
        ]),
      )
      .child(rule(tokens))
      .child(
        v_flex()
          .gap(style().spacing.xxs)
          .child(muted(tokens, "Order ID"))
          .child(numeric(tokens, order.orderId).truncate()),
      )
      .when(Boolean(order.remark), (element) =>
        element.child(
          v_flex()
            .gap(style().spacing.xxs)
            .child(muted(tokens, "Remark"))
            .child(label(tokens, order.remark)),
        ),
      )
      .when(Boolean(order.message), (element) => element.child(muted(tokens, order.message)))
  );
}

/**
 * A row of mutually exclusive choices, drawn as one control.
 *
 * Two or three options do not need a `Select`: a dropdown hides half the
 * answer behind a click, and laid out flat the choices are readable at rest
 * and each one is already a focusable button. Selection is carried by fill and
 * position rather than by text colour alone.
 *
 * The native group is one keyboard stop. Arrow keys move between enabled
 * choices and Enter/Space commit; the application owns the selected value.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {readonly { value: string, label: string }[]} options
 * @param {string} value
 * @param {(next: string, cx: import("gpui-kit").Context) => void} onChange
 */
export function segmented(tokens, id, options, value, onChange) {
  return new NativeButtonGroup(id, value)
    .children(options.map((option) => new ChoiceItem(option.value, option.label)))
    .on_change(onChange);
}

/**
 * A run of intervals, or of anything else a panel is currently showing one of.
 *
 * Native TabList owns selection styling and keyboard navigation. The view
 * chooses which chart interval each stable option value represents.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {readonly { value: string, label: string }[]} options
 * @param {string} value
 * @param {(next: string, cx: import("gpui-kit").Context) => void} onChange
 * @param {string} [label] what this run is choosing, for a screen reader
 */
export function intervalTabs(tokens, id, options, value, onChange, label = "") {
  const tabs = new NativeTabList(id, value)
    .children(options.map((option) => new ChoiceItem(option.value, option.label)))
    .on_change(onChange);
  if (label) tabs.accessibility_label(label);
  return tabs;
}

/**
 * One field of an order ticket: its label, its control, and what the control
 * needs said about it.
 *
 * One column, so the eye travels down rather than back and forth between a
 * caption on one edge and a value on the other. The gap inside a field is the
 * one for parts of a single control, and it has to stay smaller than the gap
 * between fields for the grouping to read at all.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} caption
 * @param {import("gpui-kit").Element} control
 * @param {{ error?: string, hint?: string, accessory?: import("gpui-kit").Element | null }} [options]
 */
export function ticketField(tokens, caption, control, options = {}) {
  const { error = "", hint = "", accessory = null } = options;
  return (
    v_flex()
      .gap(style().spacing.xs)
      .child(
        h_flex()
          .items_baseline()
          .justify_between()
          .gap(style().spacing.sm)
          .child(muted(tokens, caption))
          // The right of the caption row is where a field's own control goes --
          // the sizing switch above the amount, and nothing anywhere else.
          .when(Boolean(accessory), (element) => element.child(accessory)),
      )
      // The control, whatever it is. A field whose value is in something
      // carries that unit itself -- see `valueField` -- rather than having it
      // hung beside it here.
      .child(control)
      // An error replaces the hint rather than stacking under it: both are about
      // the same field, and the correction is what matters while it applies.
      .when(Boolean(error), (element) =>
        element.child(
          new Label(String(error))
            .size("caption")
            .build(context(tokens))
            .text_color(tokens.destructive),
        ),
      )
      .when(Boolean(hint) && !error, (element) => element.child(muted(tokens, hint, "caption")))
  );
}

/**
 * A titled group of ticket fields, separated from the one before it by a rule.
 *
 * Grouping by task rather than by nesting a card: an order ticket asks two
 * different questions -- what is being traded, and how long the order stands
 * -- and evenly spaced rows say those are equal decisions. A heading and a
 * hairline cost less than a container and say more.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} title
 * @param {boolean} [first] Whether this is the first group, which draws no rule.
 */
export function ticketGroup(tokens, title, first = false) {
  return v_flex()
    .gap(style().spacing.sm)
    .when(!first, (element) => element.child(rule(tokens)))
    .child(smallCaps(tokens, title));
}

/**
 * A ticket's heading: what is about to be done, to what.
 *
 * The direction is the loudest thing on the surface and it is coloured,
 * because the one mistake this dialog exists to prevent is buying when you
 * meant to sell.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} side @param {string} symbol @param {string} name
 */
export function ticketHeading(tokens, side, symbol, name) {
  const cx = context(tokens);
  return h_flex()
    .items_baseline()
    .gap(style().spacing.sm)
    .child(
      new Label(String(side).toUpperCase())
        .size("title")
        .strong()
        .build(cx)
        .text_color(tradeSideTone(tokens, side)),
    )
    .child(new Label(String(symbol)).size("title").strong().build(cx))
    .when(Boolean(name), (element) => element.child(muted(tokens, name)));
}

/**
 * The confirmation screen: the order as a sentence, and nothing to type.
 *
 * Read-only on purpose. A confirmation with editable fields is a second
 * ticket, and what it confirms is then whatever was in the boxes at the moment
 * the button was pressed rather than what was read.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {ReturnType<typeof import("./trade.js").ticketSummary>} summary
 */
export function orderConfirmSummary(tokens, summary) {
  const cx = context(tokens);
  const line = (caption, value) =>
    h_flex()
      .items_center()
      .justify_between()
      .gap(style().spacing.md)
      .child(muted(tokens, caption))
      .child(new Label(String(value)).strong().build(cx));
  return (
    v_flex()
      .id("order-confirm-summary")
      .gap(style().spacing.xs)
      .p(style().spacing.sm)
      .bg(tokens.background)
      .child(
        h_flex()
          .items_baseline()
          .gap(style().spacing.xs)
          .child(
            new Label(summary.side.toUpperCase())
              .strong()
              .build(cx)
              .text_color(tradeSideTone(tokens, summary.side)),
          )
          .child(new Label(String(summary.quantity)).strong().build(cx))
          .child(new Label(String(summary.symbol)).strong().build(cx))
          .when(Boolean(summary.name), (element) => element.child(muted(tokens, summary.name))),
      )
      .child(rule(tokens))
      .child(line("Type", summary.type))
      .child(line("Price", summary.price))
      // What an amount was divided by to reach the share count above. Only a
      // market order shows it: a limit order was sized against the price on the
      // line before, and repeating it would be the same number twice.
      .when(Boolean(summary.sizedAt), (element) => element.child(line("Sized at", summary.sizedAt)))
      .child(line("Valid", summary.timeInForce))
      .when(Boolean(summary.sessions), (element) =>
        element.child(line("Sessions", summary.sessions)),
      )
      .child(rule(tokens))
      // The sum the reader typed, above what it actually buys. Shares are whole
      // and lots are whole, so the two differ by the remainder -- showing only
      // the budget would claim all of it was spent.
      .when(Boolean(summary.budget), (element) => element.child(line("Amount", summary.budget)))
      .child(line(summary.amountLabel, summary.amount))
  );
}

/**
 * The device code, as the thing the sign-in screen is actually about.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} code
 */
export function deviceCodeBox(tokens, code) {
  return new CodeBlock("device-code").value(code).build(context(tokens));
}

/**
 * A numbered step. Sign-in is a three-place errand — open a page, type a code,
 * approve — and the screen says so rather than leaving it to be inferred from
 * the order of the controls.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {number} index
 * @param {string} title
 */
export function step(tokens, index, title) {
  return new Step(index).title(title).build(context(tokens));
}

/** @param {import("gpui-base").Theme} tokens @param {string} title @param {string} detail */
export function emptyPanel(tokens, title, detail) {
  return new EmptyState().heading(title).hint(detail).build(context(tokens));
}

/** @param {import("gpui-base").Theme} tokens @param {string} value */
export function errorMessage(tokens, value) {
  return new Alert("error-message").message(value).build(context(tokens));
}

/**
 * The single-letter badge that opens a watchlist row.
 *
 * One letter, from the ticker rather than from the market. Every row of a
 * market's block carried the same two letters, so the column was a stripe that
 * said what the Session column already says. The ticker's own initial differs
 * row to row, which is what makes it a mark you can find a row by rather than
 * a label repeated down the page.
 *
 * A leading `.` is an index -- `.SPX.US` -- and a leading digit is a Hong Kong
 * or A-share board number; neither is a letter to lead with, so the first
 * character that is one wins, and a code with none keeps its first.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} code
 * @param {number} [size]
 */
export function marketAvatar(tokens, code, size = 26) {
  const bare = String(code || "").replace(/^\.+/, "");
  const letter = bare.match(/[A-Za-z]/)?.[0] ?? bare[0] ?? "-";
  const initials = letter.toUpperCase();
  return new Avatar()
    .initials(initials)
    .tint(avatarColor(tokens, initials, 0.6))
    .extent(size)
    .build(context(tokens));
}

/**
 * The session menu's trigger: an avatar with no picture behind it.
 *
 * The counterpart of `marketAvatar` — both fill the fallback slot, because
 * this application knows no faces. A read-only terminal is signed in to an
 * account, not to a person with a portrait, and the product mark is already in
 * the header two elements to the left; putting it in a circle here would repeat
 * it and crop its bars against the mask.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 * @param {string} hint
 * @param {boolean} [open]
 */
export function sessionAvatar(tokens, id, hint, open = false) {
  return new AvatarButton(id)
    .icon("assets/user.svg")
    .description(hint)
    .selected(open)
    .quiet()
    .size("small")
    .build(context(tokens));
}

/**
 * One collapsible section of the stock-detail pane.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {{
 *   id: string,
 *   title: string,
 *   detail?: string,
 *   open: boolean,
 *   level?: number,
 *   keepMounted?: boolean,
 *   inset?: number,
 *   onToggle: (open: boolean, cx: import("gpui-kit").Context) => void,
 *   body: import("gpui-kit").Element,
 * }} options
 */
export function accordionSection(tokens, options) {
  const {
    id,
    title,
    detail = "",
    open,
    level = 3,
    keepMounted = false,
    inset = style().spacing.md,
    onToggle,
    body,
  } = options;
  const section = new AccordionSection(id)
    .title(title)
    .open(open)
    .level(level)
    .keepMounted(keepMounted)
    .inset(inset)
    .onToggle(onToggle)
    .body(body);
  if (detail) section.detail(detail);
  return section.build(context(tokens));
}

/**
 * The accordion group the sections above sit in.
 *
 * Built empty and returned as an element, so a caller adds its sections the
 * way it adds any other child.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} id
 */
export function accordionGroup(tokens, id) {
  return new AccordionGroup(id).build(context(tokens));
}

/** The weekday headings the grid's columns line up under. */
const WEEKDAYS = Object.freeze(["S", "M", "T", "W", "T", "F", "S"]);

/**
 * A month grid drawn from a retained `CalendarState`.
 *
 * Base's `Calendar` element is not bound — it would cross into JavaScript once
 * per cell from inside the layout pass — so the state answers the grid and the
 * cells are ordinary buttons. `month_days()` is the part a script cannot work
 * out for itself: which days fall in which week, and which of them belong to
 * the neighbouring months.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {import("gpui-base").CalendarStateHandle} calendar
 * @param {{
 *   selected: string | null,
 *   latest: string,
 *   onPick: (day: string, cx: import("gpui-kit").Context) => void,
 *   onMonth: (delta: number, cx: import("gpui-kit").Context) => void,
 * }} options
 */
export function calendarGrid(tokens, calendar, options) {
  const cx = context(tokens);
  const { selected, latest, onPick, onMonth } = options;
  const weeks = calendar.month_days()[0] ?? [];
  const year = calendar.year();
  const month = calendar.month();
  const monthLabel = `${year}-${String(month).padStart(2, "0")}`;
  const inMonth = (day) => day.slice(0, 7) === monthLabel;
  const stepper = (id, caption, delta) =>
    new GlyphButton(id)
      .glyph(delta < 0 ? "‹" : "›")
      .description(caption)
      .size("small")
      .onClick((_event, cx) => onMonth(delta, cx))
      .build(cx);

  return v_flex()
    .gap(style().spacing.xs)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .child(stepper("calendar-prev", "Previous month", -1))
        .child(label(tokens, monthLabel))
        .child(stepper("calendar-next", "Next month", 1)),
    )
    .child(
      h_flex()
        .w_full()
        .children(
          WEEKDAYS.map((day, index) =>
            div()
              .flex()
              .flex_1()
              .justify_center()
              .id(`calendar-weekday-${index}`)
              .child(muted(tokens, day, "caption")),
          ),
        ),
    )
    .children(
      weeks.map((week, weekIndex) =>
        h_flex()
          .w_full()
          .gap(1)
          .id(`calendar-week-${weekIndex}`)
          .children(
            week.map((day) => {
              const current = day === selected;
              const future = day > latest;
              return new Button(`calendar-day-${day}`)
                .label(String(Number(day.slice(8))))
                .accent(current)
                .selected(current)
                .disabled(future)
                .size("small")
                .onClick(future ? undefined : (_event, cx) => onPick(day, cx))
                .build(cx)
                .flex_1()
                .px(0)
                .accessibility_label(day)
                .opacity(future ? 0.35 : inMonth(day) ? 1 : 0.6);
            }),
          ),
      ),
    );
}

/**
 * One chord, drawn as a key.
 *
 * `KeyEvent.keystroke` arrives already unparsed — the whole chord, spelled the
 * same on every platform — so this is a label rather than a reconstruction.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} keystroke
 * @param {{ down?: boolean, held?: boolean }} [state] Whether the key is still
 *   down, and whether the platform is repeating it.
 */
export function kbd(tokens, keystroke, state = {}) {
  const { down = false, held = false } = state;
  return new Keycap(held ? `${keystroke} (held)` : keystroke)
    .pressed(down)
    .quiet(!down)
    .build(context(tokens));
}

/**
 * The page inset: the gap between the window's four edges and the Panels
 * inside them, top included -- the title bar is the window's top edge, so the
 * room under it is this gap and not a separate decision.
 *
 * It is `spacing.sm`, the same gap the Panels keep from each other, so the
 * window edge and every seam between panes sit on one grid. Written as a
 * number rather than read from the scale because it is also arithmetic:
 * `dockWidth` subtracts it from the viewport to size the docks.
 */
export const PANE_INSET = 8;
export const WATCHLIST_MIN_WIDTH = 400;

/**
 * A plain titled Panel with an optional compact TitleBar accessory.
 *
 * `grow` is how the content is sized. A pane whose content fills whatever it
 * is given -- a table, a plot, a tape -- grows into the panel; a pane that is
 * a fixed block of readings takes its own height instead, because a block of
 * readings stretched to fill a tall window is a band of empty panel under the
 * last row of it.
 *
 * `note` is what the title alone cannot say: a count, a currency, a window of
 * days. It sits with the heading rather than across the row from it, because
 * it says how much of *this* is here; opposite the title it read as a second
 * control.
 *
 * @param {import("gpui-base").Theme} tokens
 * @param {string} title
 * @param {import("gpui-kit").Element} content
 * @param {import("gpui-kit").Element | null} [accessory]
 * @param {{ grow?: boolean, note?: string, id?: string }} [options]
 */
export function workspacePanel(tokens, title, content, accessory = null, options = {}) {
  const { grow = true, note = "", id = "" } = options;
  const built = new Panel(id || `workspace-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)
    .title(title)
    .grow(grow)
    .content(content.border(0));
  if (note) built.note(note);
  if (accessory) built.accessory(accessory);
  return built.build(context(tokens));
}
