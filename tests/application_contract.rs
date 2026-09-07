use std::{fs, path::PathBuf};

fn app_dir() -> PathBuf {
    std::env::var_os("LONGBRIDGE_CONTRACT_APP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app"))
}

#[test]
fn application_uses_the_system_font_instead_of_bundling_one() {
    let root = app_dir();
    let host = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs"),
    )
    .expect("host main.rs");
    let script = fs::read_to_string(root.join("main.js")).expect("application main.js");

    assert!(
        !root.join("assets/fonts").exists(),
        "font assets must not ship with the app"
    );
    assert!(
        !host.contains("include_bytes!") && !host.contains("add_fonts("),
        "the host must not embed or register an application font"
    );
    assert!(
        !script.contains(".font_family("),
        "the application must inherit the system font"
    );
}

#[test]
fn manifest_grants_longbridge_network_access() {
    let root = app_dir();
    let manifest = gpui_shell::plugin::PluginManifest::read(&root).expect("plugin manifest");
    let capabilities = manifest.capabilities(&root, &std::env::temp_dir());

    assert!(capabilities.may_reach("openapi.longbridge.com"));
    assert!(capabilities.may_reach("openapi-quote.longbridge.com"));
    assert!(capabilities.may_request("https", "openapi.longbridge.com", None, "POST", "/any/path"));
    assert!(!capabilities.may_run("longbridge"));
    assert!(
        !fs::read_to_string(root.join("gpui-shell.json"))
            .expect("manifest source")
            .contains("/etc"),
        "Omarchy colors replace the old operating-system identity probe"
    );
}

#[test]
fn host_reads_only_the_materialized_omarchy_palette() {
    let host = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs"),
    )
    .expect("host main.rs");
    // The path is assembled once and joined twice now -- `colors.toml` for the
    // palette, `shell.toml` for the density, type scale and rounding a theme
    // also carries -- so the whole string no longer appears anywhere. What the
    // host must still do is root both at the materialized theme directory and
    // read nothing else.
    assert!(
        host.contains(".local/state/omarchy/current/theme")
            && host.contains("colors.toml")
            && host.contains("shell.toml")
    );
    assert!(host.contains("HostModule::new(\"omarchy-theme\")"));
    assert!(
        host.contains("gpui-shell/plugins"),
        "existing login storage must remain stable"
    );
}

#[test]
fn debug_builds_watch_application_sources() {
    let host = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs"),
    )
    .expect("host main.rs");
    assert!(host.contains("#[cfg(debug_assertions)]"));
    assert!(host.contains("runtime.watch(&root, window, cx)"));
    assert!(host.contains("watcher.forget()"));
}

#[test]
fn the_writable_surface_is_the_watchlist_and_an_account_s_orders() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    let market = fs::read_to_string(app_dir().join("market.js")).expect("market.js");
    let orders = fs::read_to_string(app_dir().join("orders.js")).expect("orders.js");
    let http = fs::read_to_string(app_dir().join("http.js")).expect("http.js");

    assert!(
        main.contains("/v1/watchlist/groups"),
        "watchlist must load from the API"
    );
    assert!(
        main.contains("/v1/trade/order/today") && main.contains("/v1/trade/order/history"),
        "the Orders page must read both order lists from the read-only API"
    );
    assert!(
        market.contains("sortLikeTerminal"),
        "watchlist must use terminal-compatible sorting"
    );
    // Each Dock tile names its own reading because a one-tab group hides its
    // tab strip. The names must remain stable across layout restoration.
    for expected in [
        "Watchlist",
        "Quote Details",
        "Chart",
        "Market Detail",
        "Portfolio",
        "Holdings",
        "Orders",
        "Today Orders",
        "History Orders",
    ] {
        assert!(
            main.contains(expected) || ui.contains(expected),
            "missing view copy {expected}"
        );
    }
    assert!(
        main.contains("priceChart") && main.contains("allocationChart"),
        "read-only market and allocation charts must remain wired"
    );
    // The application changes two things about an account: which securities it
    // watches, and its orders. What makes that a boundary rather than a habit
    // is that both are a *list* -- path and method together -- and the list is
    // in one place. A third path, or a fourth method on one of these two, has
    // to be added here before it can be added there.
    // The whole map, not two lines of it: a third entry has to change this
    // assertion, which is the point of writing the boundary down.
    assert!(
        http.contains(
            r#"const WRITABLE = new Map([
  ["/v1/watchlist/groups", new Set(["PUT"])],
  [TRADE_ORDER_PATH, new Set(["POST", "PUT", "DELETE"])],
]);"#
        ),
        "the writable surface is a list of two paths and the methods each allows"
    );
    assert!(
        http.contains("assertWritable(method, path);")
            && http.matches("assertWritable(").count() == 2,
        "every write goes through the one guard, and the guard takes the method"
    );
    // An order is composed here and nowhere else. `orders.js` reads one back;
    // `trade.js` decides what may be sent, and does it without a socket, which
    // is what makes that decision checkable.
    assert!(
        !orders.contains("fetch(") && !orders.contains("POST"),
        "the order reader normalizes an answer and never sends one"
    );
    let trade = fs::read_to_string(app_dir().join("trade.js")).expect("trade.js");
    assert!(
        !trade.contains("fetch(") && !trade.contains("await "),
        "what may be sent must be decidable without reaching the network"
    );
    assert!(
        trade.contains("export function validateTicket")
            && trade.contains("export function submitOrderBody")
            && trade.contains("export function replaceOrderBody")
            && trade.contains("export function cancelOrderBody"),
        "the three things that can be done to an order are shaped in one module"
    );
    // A submit carries an idempotency key. Without one a retried request after
    // a lost response places a second order, which is the failure this whole
    // surface exists to avoid.
    assert!(
        trade.contains("client_request_id") && main.contains("randomUUID()"),
        "a submitted order must carry an idempotency key"
    );
    // The read that follows a write is owned by the session, not by the ticket.
    //
    // This assertion used to say the opposite -- that the read must be awaited
    // in the writing task, because a task started inside another is not
    // guaranteed to outlive it. That is true, and it is not the whole rule:
    // the writing task here is spawned from the order ticket, and the ticket
    // is a dialog with a view of its own that the same task then closes. So
    // awaiting anything after `close_dialog` waits on a view being taken down,
    // and the continuation never runs -- the read is issued, the panel says
    // "Loading orders", and it says it for the rest of the session, holding no
    // rows. The gateway's push for the order that was just placed is dropped
    // along with it, because a list that never loaded has nothing to merge
    // into, so a placed order simply did not appear until the reader switched
    // pages and the workspace asked again.
    //
    // What the rule protects is therefore the lifetime, not the awaiting:
    // whatever runs the read has to still be there when the answer comes.
    let confirm = main
        .split("  confirmTicket(cx) {")
        .nth(1)
        .and_then(|source| source.split("\n  /**").next())
        .expect("confirmTicket method");
    assert!(
        confirm.contains("this.refreshOrdersAfterAction(cx)") && !confirm.contains("await this.r"),
        "the read after a write must be owned by something that outlives the ticket"
    );
    assert!(
        main.contains("const cx = this.sessionContext ?? fallbackContext;"),
        "and the session's context is what it is handed to"
    );
    // Longbridge accepts an order before its list reports one, so the read
    // after a write does not contain it. What closes that gap is the trade
    // gateway's push channel rather than reading again and again: the order
    // arrives because the gateway says it exists. The two are then reconciled,
    // because the read that is behind must not put the list back as it was.
    let trade_stream =
        fs::read_to_string(app_dir().join("trade_stream.js")).expect("trade_stream.js");
    assert!(
        trade_stream.contains("encodeTradeSubscribeRequest([TRADE_TOPIC_PRIVATE])")
            && trade_stream.contains("TRADE_COMMAND.PUSH_NOTIFICATION"),
        "orders must be learned from the gateway's own topic"
    );
    // The transport is the shell's module, not a browser global.
    assert!(
        trade_stream.contains(r#"import { WebSocket } from "websocket""#),
        "the push channel's transport is the shell's, not a global"
    );
    assert!(
        main.contains("this.startTradeStream(token, generation, cx)")
            && main.contains("receiveOrderChange(pushed, cx)")
            && main.contains("applyPushedOrders(today)"),
        "a pushed order must reach the list, and survive a read that is behind it"
    );
    // The channel is a second socket to a second host, and the manifest has to
    // say so or it cannot open at all.
    let manifest = fs::read_to_string(app_dir().join("gpui-shell.json")).expect("manifest");
    assert!(
        manifest.contains("openapi-trade.longbridge.com"),
        "the trade gateway is its own host and must be declared"
    );
    // Retained text state is the four list filters, the field that names a
    // security to add, and the three an order is composed in.
    assert!(
        main.matches("InputState.new({ placeholder:").count() == 8
            && main.contains("Filter watchlist")
            && main.contains("Filter holdings")
            && main.matches("Filter orders").count() == 2
            && main.contains(r#"placeholder: "AAPL.US""#),
        "the only retained text state may be the list filters, the symbol to add, and the ticket"
    );
    assert!(
        market.contains("export function filterRows"),
        "filtering must stay a pure function outside the render path"
    );

    // Both lists are real tables: `row_count` describes the whole collection so
    // a window onto it still announces its size.
    assert!(
        main.contains("Table.new(`${id}-table`)") && main.contains(".row_count(rows.length + 1)"),
        "both lists must be virtualized tables that announce their full size"
    );
    // Still table parts, now the library's: a row and a header row announce
    // themselves as such, and a cell that stacks two readings is one cell
    // rather than two. What matters is the semantics reaching the tree, not
    // which module the constructor came from.
    assert!(
        ui.contains("new TableHeaderRow(")
            && ui.contains("new TableRow(")
            && ui.contains("new CellStack("),
        "rows and headers must be table parts rather than styled flex containers"
    );
    assert!(main.contains("const tokens = cx.theme()"));
    assert!(!main.contains(".text_color(\"") && !ui.contains(".text_color(\""));
    assert!(!main.contains("rgb(") && !ui.contains("rgb("));
    // Each page owns its scrolling now, and each does it the way its content
    // needs. Neither scrolls as a page: both put the scroll inside the table
    // that has more rows than room, which is the virtualized one, so the window
    // never grows a bar around a whole column and no page nests one scroll
    // inside another. Neither paints a window bar either.
    assert!(
        !main.contains(".overflow_y_scroll()"),
        "no page may scroll as a whole; the table inside it does"
    );
    // Both lists go through one virtualized table, so the list and the bar are
    // named from the same id and cannot drift apart.
    assert!(
        main.contains("v_virtual_list(")
            && main.contains("`${id}-rows`,")
            && main.contains("Scrollbar.vertical(`${id}-rows`)"),
        "both lists must virtualize their rows and pair a scrollbar with them by name"
    );
    assert!(
        main.contains(".id(\"watchlist-panels\")")
            && main.contains("workspacePanel(tokens, \"Watchlist\"")
            && main.contains("workspacePanel(tokens, \"Quote Details\"")
            && main.contains("const chart = workspacePanel(")
            && main.contains("      \"Chart\",")
            && main.contains("workspacePanel(tokens, \"Market Detail\"")
            && !main.contains("DockArea")
            && !main.contains("dock_area("),
        "Watchlist and detail readings must be four plain responsive Panels without Dock state"
    );

    // A row inside a virtual list cannot register a handler: it is rebuilt on
    // every scrolled frame, so selection belongs to the list.
    assert!(
        main.contains(".on_item_click(") && !ui.contains(".on_click(onSelect)"),
        "watchlist selection must come from the list's on_item_click"
    );

    // Both bound anchored surfaces are exercised, and the pointer affordances
    // with them.
    assert!(
        main.contains("Popover.new(\"user-menu\")")
            && main.contains("Popover.new(\"allocation-help\")"),
        "both Popover scenarios must stay wired"
    );
    // The surface says it is a menu; its rows say they are menu items by being
    // the library's `MenuItem`, which carries that role. The role reaching the
    // tree is asserted where a tree exists -- `workspace_ui.test.js` -- rather
    // than by looking for the string here.
    assert!(
        ui.contains("new MenuItem(") && ui.contains(".role(\"menu\")"),
        "the popup menu must announce itself as a menu"
    );
    // The hint is now what an icon control is *given* -- `description(hint)` --
    // and the library turns it into both the tooltip and the accessible name.
    // Asserting the caller passes one keeps the hint mandatory without pinning
    // how the library draws it.
    assert!(
        ui.contains(".description(hint)"),
        "pointer hints must stay wired"
    );

    // Authorization opens the page itself. The address is only known once the
    // device code exists, and it is not one anyone reads.
    assert!(
        main.contains("open_url(authorization.verificationUri)")
            && main.contains("cx.open_url(\"https://longbridge.com\")")
            && main.contains("cx.open_url(\"https://github.com/longbridge/longbridge-lite\")")
            && main.contains("\"user-menu-sign-out\"")
            && main.contains("\"Sign out\"")
            && !main.contains("user-menu-switch-account")
            && main.contains("Button.new(\"longbridge-home-link\")")
            && !main.contains("device.verificationUri,\n              device.verificationUri,"),
        "sign-in must open the authorization page rather than print its URL"
    );
}

#[test]
fn price_chart_is_a_retained_child_view() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let chart =
        fs::read_to_string(app_dir().join("price_chart_view.js")).expect("price_chart_view.js");

    assert!(
        main.contains("cx.new(PriceChartView")
            && main.contains(".child(this.priceChart)")
            && main.contains("this.priceChart.set_props(")
            && main.contains("this.priceChart.release()"),
        "the root must create, update, mount, and release one retained price-chart child"
    );
    assert!(
        chart.contains("export default class PriceChartView extends View"),
        "the retained child must own the price-chart view lifecycle"
    );
    for root_owned_hover_state in ["chartPointer", "chartHoverFramePending", "chartHover"] {
        assert!(
            !main.contains(root_owned_hover_state),
            "root still owns chart-local state {root_owned_hover_state}"
        );
    }
}

#[test]
fn responsive_panels_preserve_watchlist_and_detail_priorities() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    let watchlist = main
        .split("  watchlist(tokens) {")
        .nth(1)
        .and_then(|source| source.split("  /**\n   * A virtualized table").next())
        .expect("watchlist render method");
    let detail = main
        .split("  marketDetailPanel(tokens) {")
        .nth(1)
        .and_then(|source| source.split("  /**\n   * The chart").next())
        .expect("detail section render method");

    assert!(!detail.contains("this.isNarrow()"));
    assert!(
        watchlist.contains("const compact = this.isWatchlistCompact()")
            && watchlist.contains("watchlistHeader(tokens, compact)"),
        "Watchlist must keep full columns when wide and primary lanes when compact"
    );
    assert!(
        watchlist.contains("quoteRow(")
            && watchlist.contains("this.lastTick,")
            && watchlist.contains("compact,"),
        "virtual Watchlist rows must reuse the pane sizing decision without a host call"
    );
    assert_eq!(
        watchlist.matches("this.isNarrow()").count(),
        0,
        "virtual rows must make zero QuickJS-to-host viewport calls"
    );
    assert!(
        detail.contains("orderBookPanel(tokens, this.depthState, depthRatio(this.depthState))")
            && detail.contains("timeSalesPanel(tokens, this.tradesState, {")
            && !detail.contains("compact"),
        "detail lanes must be pane-safe by construction rather than switch from viewport compactness"
    );
    assert!(
        ui.contains("export const WATCHLIST_MIN_WIDTH = 400")
            && main.contains("watchlist.flex_basis(0).flex_grow(6).min_w(WATCHLIST_MIN_WIDTH)")
            && main.contains(".flex_grow(4)")
            && main.contains(".id(\"watchlist-panels-stacked\")")
            && main.find("workspacePanel(tokens, \"Watchlist\"")
                < main.find("workspacePanel(tokens, \"Quote Details\"")
            && main.find("workspacePanel(tokens, \"Quote Details\"")
                < main.find("const chart = workspacePanel(")
            && main.find("const chart = workspacePanel(")
                < main.find("workspacePanel(tokens, \"Market Detail\""),
        "plain Panels must use 6:4 when wide and stack in Watchlist, Quote, Chart, Market priority"
    );
}

#[test]
fn minimum_watchlist_keeps_symbol_name_last_and_change() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");

    assert!(
        main.contains("const COMPACT_WATCHLIST_WIDTH = 440")
            // The width is a cell's own property now rather than a style call
            // on it, but the two shares are the same: the instrument keeps the
            // majority and the reading keeps the rest.
            && ui.contains("{ width: compact ? \"60%\" : \"31%\" }")
            && ui.contains("width: compact ? \"40%\" : \"19%\"")
            && ui.contains("quote.symbol")
            && ui.contains("quote.name")
            && ui.contains("quote.last")
            && ui.contains("quote.changePercent"),
        "compact Watchlist must keep Symbol + Name and Last + Chg"
    );
}

#[test]
fn responsive_breakpoints_use_the_same_gap_and_min_width_math_as_the_panels() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    assert!(
        main.contains("function responsivePanelWidths(viewportWidth)")
            && main.contains("const content = available - WORKSPACE_PANEL_GAP")
            && main.contains("content - WATCHLIST_MIN_WIDTH")
            && main.contains("responsivePanelWidths(window.viewport_size().width).watchlist")
            && main.contains("responsivePanelWidths(window.viewport_size().width).detail")
            && main.matches(".gap(WORKSPACE_PANEL_GAP)").count() == 3,
        "Watchlist columns and Chart controls must use the exact widths produced by the 6:4 Panel layout"
    );
}

#[test]
fn minimum_chart_keeps_a_real_plot_below_compact_interval_tabs() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    // The interval run is `intervalTabs` now, which is the library's underline
    // shape. What this file used to assert -- the centring, the type size, the
    // 2px rule under the current one -- is the component's, and asserted where
    // the component lives; a run of tabs that reserves its underline on every
    // tab and colours one is exactly what it was written to guarantee. What is
    // still this application's is that the Chart Panel has a run of intervals
    // at all, and a plot with room to be one under it.
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    assert!(
        main.contains("intervalTabs(")
            && main.contains("\"Chart interval\"")
            && ui.contains("export function intervalTabs(")
            && main.contains(".id(\"price-chart-wheel\")")
            && main.contains(".min_h(244)")
            && main.contains(".child(this.priceChart)"),
        "the minimum Chart Panel must retain compact underline tabs and a visible plot"
    );
    assert!(
        main.contains("if (chartWidth < 440)")
            && main.contains("Popover.new(\"chart-mode-menu\")")
            && main.contains("Button.new(\"chart-mode-menu-trigger\")"),
        "a narrow Chart TitleBar must replace the tabs with a compact interval dropdown"
    );
}

#[test]
fn title_bar_has_no_obsolete_detail_dock_toggle() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    assert!(
        !main.contains("detailToggle") && !main.contains("workspaceDock"),
        "plain responsive Panels must not leave a Dock toggle in the TitleBar"
    );
}

#[test]
fn panel_layout_has_no_resize_or_persistence_hot_path() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");

    assert!(
        !main.contains("WORKSPACE_LAYOUT_KEY")
            && !main.contains("localStorage.setItem(WORKSPACE_LAYOUT_KEY")
            && !ui.contains("resize_dock("),
        "responsive Panels must not persist or resize a Dock"
    );
}

#[test]
fn workspace_outer_gap_is_not_double_padded() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let render = main
        .split("  render(cx) {")
        .nth(1)
        .expect("application render method");

    assert!(
        render.contains(".p(PANE_INSET)")
            && !render.contains(".pt(0)")
            && !render.contains(".px(PANE_INSET)")
            && !render.contains(".pb(PANE_INSET)"),
        "the shell keeps one PANE_INSET gap on all four sides, the TitleBar edge included, \
         and never pads a side twice"
    );
}

#[test]
fn retained_chart_props_do_not_duplicate_the_large_series() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let chart_props = main
        .split("  chartProps() {")
        .nth(1)
        .and_then(|source| source.split("  nextPriceChartProps() {").next())
        .expect("chartProps method");

    assert!(
        !chart_props.contains("series:") && !main.contains("previous?.series === next.series"),
        "the retained chart must receive one mode-specific series, not a duplicate five-day graph"
    );

    // Deriving it is the expensive thing this view does, so it happens once
    // per set of candles rather than on every publish check. The candles are
    // the key *and* the answer is cached: recomputing produced a new array
    // every time, so the identity check below could never be true and every
    // check published.
    let derive = main
        .split("  chartSeriesFor(symbol, mode, candles) {")
        .nth(1)
        .and_then(|source| source.split("\n  /**").next())
        .expect("chartSeriesFor method");
    assert!(
        derive.contains("compactIntradaySeriesForView")
            && derive.contains("cached.candles === candles")
            && derive.contains("return cached.series")
            && chart_props.contains("this.chartSeriesFor(symbol, mode, candles)")
            && main.contains("previous?.chartSeries === next.chartSeries"),
        "the plotted series must be derived once per set of candles and answered by identity"
    );
}

#[test]
fn window_declares_a_minimum_workbench_size() {
    let host = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs"),
    )
    .expect("src/main.rs");
    assert!(
        host.contains("window_min_size: Some(size(px(720.), px(600.)))"),
        "the native window must preserve the Watchlist and Right Dock minimum widths"
    );
}

#[test]
fn time_sales_volume_markers_use_directional_semantic_tones_and_intensity() {
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");

    assert!(
        ui.contains("bg(direction.tone)") && ui.contains("opacity(volumeIntensity(ratio))"),
        "trade volume fills must use semantic direction tone and bounded depth intensity"
    );
    assert!(
        ui.contains("statusColors(tokens).up")
            && ui.contains("statusColors(tokens).down")
            && ui.contains("tokens.muted_foreground"),
        "up, down, and neutral trade directions require separate semantic tones"
    );
}

#[test]
fn depth_and_trade_pushes_invalidate_only_the_market_detail_panel() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    for method in [
        "receiveDetailError(detail, cx)",
        "receiveDepth(depth, cx, generation)",
        "receiveTrades(payload, cx, generation)",
    ] {
        let body = main
            .split(method)
            .nth(1)
            .and_then(|source| source.split("\n  /**").next())
            .expect("detail market mutation method");
        assert!(
            body.contains("this.scheduleRedraw(cx, PANE_MARKET);"),
            "{method} must coalesce publication to Market Detail"
        );
        assert!(
            !body.contains("PANE_DETAIL"),
            "{method} must not notify Quote or the retained Chart"
        );
    }
}

#[test]
fn responsive_workspace_uses_plain_panel_chrome() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    assert!(
        ui.contains(
            "export function workspacePanel(tokens, title, content, accessory = null, options = {})",
        )
            && main.matches("workspacePanel(").count() >= 4
            && !main.contains("dockFrame")
            && !main.contains("dockTabBar"),
        "all four readings must use the same plain Panel title/content frame"
    );
}

#[test]
fn plain_panels_have_no_tile_hit_geometry() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    assert!(
        !main.contains("bounds: { x: tile.x")
            && !main.contains(".move_tile(")
            && !main.contains(".resize_tile("),
        "production must not use tile geometry or tile interactions"
    );
}

#[test]
fn responsive_layout_has_no_saved_dock_or_tile_tree() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    assert!(
        !main.contains("workspaceDock")
            && !main.contains("tabState(")
            && !main.contains("detailStackState")
            && !main.contains("info: { tiles:"),
        "plain responsive Panels must have no retained Dock or Tile layout tree"
    );
}

#[test]
fn details_column_prioritizes_quote_chart_then_market() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    assert!(
        main.contains(".id(\"detail-panels\")")
            // Quote Details is sized for what it now holds -- a heading, a
            // grid of readings and a disclosure -- rather than for the three
            // metric columns it used to be.
            && main.matches(".child(quote.flex_none())").count() == 2
            && main.contains(".child(chart.min_h(290).flex_none())")
            && main.contains(".child(market.min_h(200).flex_none())"),
        "the 6:4 layout must keep Quote, Chart and Market as ordered independent Panels"
    );
    assert!(
        main.contains("marketDetailPanel(tokens)")
            && main.matches("overflow_y_scrollbar()").count() == 4
            && main.contains(".child(this.priceChart)"),
        "only page and collection owners may scroll; detail panels delegate to their outer column"
    );
}

#[test]
fn plain_panel_title_has_one_title_and_one_content_region() {
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");

    // A Panel is the library's now, so the regions are named rather than
    // assembled: a title, an optional note beside it, an optional accessory,
    // and one content region. The content still arrives with its own border
    // dropped -- the Panel draws the edge, and two would be two.
    assert!(
        ui.contains(
            "export function workspacePanel(tokens, title, content, accessory = null, options = {})",
        ) && ui.contains(".title(title)")
            && ui.contains("if (note) built.note(note);")
            && ui.contains("if (accessory) built.accessory(accessory);")
            && ui.contains(".content(content.border(0))")
            && ui.contains(".grow(grow)")
            && !ui.contains("drag_tab("),
        "plain Panel must contain one title region and one content region"
    );
}

#[test]
fn responsive_panels_own_one_consistent_omarchy_gap_and_the_title_bar_has_no_rule() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    let title_bar = main
        .split("  titleBar(tokens) {")
        .nth(1)
        .and_then(|source| source.split("  /**\n   * The session menu").next())
        .expect("title bar method");

    assert!(
        !title_bar.contains(".border_b(1)"),
        "the application TitleBar must not add a rule above the first Panel gap"
    );
    assert!(
        ui.contains("export const PANE_INSET = 8")
            && main.contains(".gap(tokens.spacing.sm)")
            && main.contains(".p(PANE_INSET)"),
        "all four plain Panels must use the same 8px peer gap, and the shell must hold \
         the window's four edges at that same 8px"
    );
}

#[test]
fn title_mark_preserves_official_multicolor_roles_with_live_semantic_tokens() {
    let root = app_dir();
    let main = fs::read_to_string(root.join("main.js")).expect("main.js");
    let official =
        fs::read_to_string(root.join("assets/logo-light.svg")).expect("official light logo");
    let layers: [(&str, &str, &[&str]); 4] = [
        (
            "logo-foreground.svg",
            "tokens.foreground",
            &[
                "x=\"0\" y=\"0\" width=\"3\" height=\"69\"",
                "x=\"33\" y=\"60\" width=\"3\" height=\"9\"",
                "x=\"53\" y=\"43\" width=\"9\" height=\"26\"",
            ],
        ),
        (
            "logo-info-cyan.svg",
            "status.info",
            &["x=\"7\" y=\"0\" width=\"10\" height=\"69\""],
        ),
        (
            "logo-warning.svg",
            "status.warning",
            &["x=\"21\" y=\"60\" width=\"9\" height=\"9\""],
        ),
        (
            "logo-danger.svg",
            "status.down",
            &[
                "x=\"40\" y=\"52\" width=\"10\" height=\"17\"",
                "x=\"66\" y=\"26\" width=\"3\" height=\"43\"",
            ],
        ),
    ];

    assert!(
        layers.iter().all(|(asset, token, _)| {
            main.contains(&format!("svg(\"assets/{asset}\")"))
                && main.contains(&format!(".text_color({token})"))
        }) && main.contains("const status = statusColors(tokens);")
            && !main.contains("assets/logo-info.svg")
            && main.contains("this.titleBar(tokens)")
            && !main.contains(".child(div().absolute().left(1)")
            && !main.contains("assets/logo-dark.svg")
            && !main.contains("assets/logo-light.svg"),
        "the title mark must resolve semantic layer colours from the current render theme, rather than a hand-built or fixed-palette glyph"
    );

    assert!(
        official.contains("width=\"69px\" height=\"69px\" viewBox=\"0 0 69 69\"")
            && layers.iter().all(|(asset, _, rects)| {
                let layer = fs::read_to_string(root.join("assets").join(asset))
                    .unwrap_or_else(|_| panic!("themed title logo layer {asset}"));
                layer.contains("width=\"69px\" height=\"69px\" viewBox=\"0 0 69 69\"")
                    && layer.matches("<rect").count() == rects.len()
                    && layer.matches("fill=\"currentColor\"").count() == rects.len()
                    && rects.iter().all(|rect| layer.contains(rect))
                    && !layer.contains("#00")
                    && !layer.contains("#FC")
                    && !layer.contains("#FF")
            }),
        "every logo layer must preserve the official 69x69 frame and inherit its semantic colour"
    );

    let all_layer_rects = layers
        .iter()
        .flat_map(|(asset, _, _)| {
            let layer =
                fs::read_to_string(root.join("assets").join(asset)).expect("title logo layer");
            [
                "x=\"0\" y=\"0\" width=\"3\" height=\"69\"",
                "x=\"21\" y=\"60\" width=\"9\" height=\"9\"",
                "x=\"33\" y=\"60\" width=\"3\" height=\"9\"",
                "x=\"53\" y=\"43\" width=\"9\" height=\"26\"",
                "x=\"66\" y=\"26\" width=\"3\" height=\"43\"",
                "x=\"40\" y=\"52\" width=\"10\" height=\"17\"",
                "x=\"7\" y=\"0\" width=\"10\" height=\"69\"",
            ]
            .into_iter()
            .filter(move |rect| layer.contains(rect))
            .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        all_layer_rects.len(),
        7,
        "the seven official rectangles must be distributed across the themed layers exactly once"
    );
    for rect in [
        "x=\"0\" y=\"0\" width=\"3\" height=\"69\"",
        "x=\"21\" y=\"60\" width=\"9\" height=\"9\"",
        "x=\"33\" y=\"60\" width=\"3\" height=\"9\"",
        "x=\"53\" y=\"43\" width=\"9\" height=\"26\"",
        "x=\"66\" y=\"26\" width=\"3\" height=\"43\"",
        "x=\"40\" y=\"52\" width=\"10\" height=\"17\"",
        "x=\"7\" y=\"0\" width=\"10\" height=\"69\"",
    ] {
        assert_eq!(
            all_layer_rects
                .iter()
                .filter(|candidate| candidate.as_str() == rect)
                .count(),
            1,
            "official rectangle {rect} must appear in exactly one semantic layer"
        );
    }
}

#[test]
fn workspace_repaints_do_not_checkpoint_the_market_model() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    assert!(
        main.contains("this.repaint = cx.timer.after(100")
            && !main.contains("cx.notify(this.watchlistPanel)")
            && !main.contains("cx.notify(this.marketDetailDockPanel)"),
        "inline responsive panels must coalesce feed repaints without nested panel checkpoints"
    );
    assert!(
        !main.contains("workspaceRevision") && !main.contains("const props = { revision:"),
        "pane repaint must not manufacture props only to cross the nested-view update path"
    );
}

#[test]
fn responsive_panels_do_not_create_nested_application_views() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");
    assert!(
        !app_dir().join("workspace.js").exists()
            && !main.contains("holdWorkspaceApp")
            && !main.contains("paneRevisions"),
        "plain Panels must stay in the root tree without nested views retaining the market graph"
    );
}

#[test]
fn chart_publication_yields_to_interaction_and_is_rate_limited() {
    let main = fs::read_to_string(app_dir().join("main.js")).expect("main.js");

    assert!(
        main.contains("const CHART_PUBLISH_INTERVAL_MS = 500")
            && main.contains("Date.now() - this.chartPublishedAt >= CHART_PUBLISH_INTERVAL_MS"),
        "live quotes must not publish the complete five-day chart on every feed repaint"
    );
    assert!(
        main.contains("this.chartPublish = cx.timer.after(0")
            && main.contains("this.publishChart(cx)"),
        "selection and load handlers must defer the large chart update so their first frame can paint"
    );

    let select_quote = main
        .split("selectQuote(symbol, cx) {")
        .nth(1)
        .and_then(|source| source.split("\n  }").next())
        .expect("selectQuote source");
    let redraw = select_quote
        .find("this.redraw(cx)")
        .expect("selection redraw");
    let load = select_quote
        .find("this.loadSelectedChart(cx)")
        .expect("chart load");
    assert!(
        redraw < load,
        "the selected Watchlist row must be submitted for paint before chart loading/publishing starts"
    );
}

#[test]
fn release_build_resolves_packaged_application_resources() {
    let manifest = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .expect("Cargo.toml");
    let host = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))
        .expect("src/main.rs");

    assert!(
        manifest.contains("name = \"longbridge-lite\""),
        "the Cargo package and executable must use the release product name"
    );
    assert!(
        host.contains("LONGBRIDGE_LITE_APP_DIR")
            && host.contains("Resources").then_some(()).is_some()
            && host.contains("share").then_some(()).is_some(),
        "the host must resolve explicit, macOS, and portable application resource locations"
    );
    let resolver = host
        .split("fn application_dir()")
        .nth(1)
        .and_then(|source| source.split("\nfn ").next())
        .expect("application_dir resolver");
    let override_position = resolver
        .find("LONGBRIDGE_LITE_APP_DIR")
        .expect("environment override");
    let development_position = resolver
        .find("CARGO_MANIFEST_DIR")
        .expect("development fallback");
    assert!(
        override_position < development_position,
        "the source checkout may only be the final development fallback"
    );
}

/// The shell is not a browser, and reaching for a name it does not have is a
/// `ReferenceError` rather than a feature that quietly does nothing.
///
/// Three of these shipped in one afternoon. `TextDecoder` was caught before it
/// ran; `WebSocket` unwound the whole connect path and put "WebSocket is not
/// defined" over a window whose only problem was a missing import; `setTimeout`
/// turned every reconnect into a reconnect that also failed. Each was found by
/// running the application and reading a warning, which is one at a time and
/// only for the paths that happened to be taken.
///
/// So the class is named here rather than its members being fixed one by one.
/// The shell offers each of these under a name of its own -- `websocket` for
/// the transport, `cx.timer` for delays, `decodeUtf8` in `protocol.js` for
/// bytes -- and a module that wants one imports it.
/// Nothing is awaited after the dialog it was spawned from is closed.
///
/// A dialog is its own view: `open_dialog` is handed a function the shell
/// calls when *it* renders, so the context a dialog's button is given belongs
/// to the dialog. A task spawned from one and awaited across `close_dialog`
/// is waiting on a view that is being taken down, and its continuation never
/// runs. That is not visible as a failure -- the request is issued and the
/// panel is put into whatever "loading" it shows to say so, and then simply
/// stays there for the life of the session.
///
/// `addSymbol` is the shape that works: every await it does happens before it
/// closes its dialog. `confirmTicket` was the shape that did not -- it closed
/// the ticket and then awaited the order read, which is why the order list sat
/// empty behind a placed order until the reader switched pages. This is what
/// stops either of them drifting back.
#[test]
fn no_dialog_task_awaits_across_the_dialog_it_closes() {
    let mut offences = Vec::new();
    for entry in fs::read_dir(app_dir()).expect("application directory") {
        let path = entry.expect("application entry").path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        if !name.ends_with(".js") || name.ends_with(".test.js") {
            continue;
        }
        let source = fs::read_to_string(&path).expect("application module");
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if !line.contains("window.close_dialog()") {
                continue;
            }
            // Follow the rest of the block the close sits in, by brace depth
            // rather than by a line count: the continuation of a handler is
            // routinely a multi-line call -- a toast, an object literal -- and
            // stopping at the first `});` would stop inside one. Depth going
            // negative is the enclosing block ending, which is where the task
            // ends and the question stops mattering.
            let mut depth: i32 = 0;
            for following in lines.iter().skip(index + 1) {
                let code = following.trim_start();
                // Prose is how a module explains what it deliberately does not
                // do, and a comment cannot await anything.
                if !(code.starts_with("//") || code.starts_with('*')) {
                    if code.contains("await ") {
                        offences.push(format!(
                            "{name}:{} awaits after the dialog closed at line {}",
                            offset_of(&lines, following),
                            index + 1
                        ));
                        break;
                    }
                    depth += following.matches('{').count() as i32;
                    depth -= following.matches('}').count() as i32;
                }
                if depth < 0 {
                    break;
                }
            }
        }
    }
    assert!(
        offences.is_empty(),
        "a task that closes its dialog must not await afterwards: {offences:#?}"
    );
}

/// The 1-based line number of a borrowed line within its file.
fn offset_of(lines: &[&str], needle: &&str) -> usize {
    lines
        .iter()
        .position(|line| std::ptr::eq(*line, *needle))
        .map(|at| at + 1)
        .unwrap_or_default()
}

#[test]
fn the_application_uses_only_names_this_runtime_has() {
    const ABSENT: [&str; 6] = [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "TextDecoder",
        "TextEncoder",
    ];
    let mut offences = Vec::new();
    for entry in fs::read_dir(app_dir()).expect("application directory") {
        let path = entry.expect("application entry").path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        // Test probes drive the modules they exercise with stand-ins of their
        // own, and a stand-in is allowed to be whatever the module will accept.
        if !name.ends_with(".js") || name.ends_with(".test.js") {
            continue;
        }
        let source = fs::read_to_string(&path).expect("application module");
        for absent in ABSENT {
            // A mention in prose is how a module explains why it does not use
            // one. What must not appear is a call.
            if source.contains(&format!("{absent}(")) {
                offences.push(format!("{name} calls {absent}"));
            }
        }
        // `WebSocket` is a module here. Named in prose is how these modules
        // describe the protocol they speak; what must not appear without the
        // import is a use of the global that is not there.
        let uses_transport = source.contains("?? WebSocket")
            || source.contains("new WebSocket")
            || source.contains("WebSocket.connect");
        if uses_transport && !source.contains(r#"from "websocket""#) {
            offences.push(format!("{name} uses WebSocket without importing it"));
        }
    }
    assert!(
        offences.is_empty(),
        "the shell has none of these; import the shell's own: {offences:?}"
    );
}

/// The desktop's `shell.toml` layers over the terminal's scale; it does not
/// replace it.
///
/// A stock Omarchy `shell.toml` ships with every `[spacing]` key commented
/// out, so choosing between the two sources rather than composing them handed
/// the window Omarchy UI's general-desktop defaults and moved every gap in the
/// interface at once -- `sm` 8 -> 4 and `md` 12 -> 6 on one side,
/// `row-padding-x` 8 -> 12 and `panel-padding` 12 -> 18 on the other. Parsing
/// is last-key-wins, so the terminal's scale has to come first and the
/// desktop's source after it.
#[test]
fn the_desktop_shell_layers_over_the_terminal_scale() {
    let style = fs::read_to_string(app_dir().join("style.js")).expect("style.js");

    assert!(
        style.contains("applyOmarchyStyle(`${TERMINAL_SHELL}\\n${shellSource}`"),
        "applyTerminalStyle must compose the terminal scale with the desktop's source"
    );
    assert!(
        !style.contains("shellSource || TERMINAL_SHELL"),
        "the desktop's file must not replace the terminal scale wholesale"
    );
}

/// The one text input a toolbar carries sits on the same control ramp as the
/// buttons beside it. At `medium` it stood taller than them and set the height
/// of the whole row.
#[test]
fn the_filter_field_is_on_the_toolbar_control_ramp() {
    let ui = fs::read_to_string(app_dir().join("ui.js")).expect("ui.js");
    let filter = ui
        .split("export function filterInput(")
        .nth(1)
        .and_then(|source| source.split("\n}").next())
        .expect("filterInput function");

    assert!(
        filter.contains(".h(style().space(24))"),
        "filterInput must be small, like the iconAction and menuTrigger it shares a row with"
    );
}
