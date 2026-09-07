use std::{
    fs,
    ops::Deref as _,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use gpui_kit::{IntoElement as _, TestAppContext, VisualTestContext};
use gpui_shell::ShellRuntime;

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app")
}

fn grant_app_capabilities() {
    let root = app_dir();
    let manifest = gpui_shell::plugin::PluginManifest::read(&root).expect("application manifest");
    gpui_shell::set_capabilities(manifest.capabilities(&root, &std::env::temp_dir()));
}

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct ApplicationFixture {
    root: PathBuf,
}

impl ApplicationFixture {
    fn new(entry: &str) -> Self {
        let ordinal = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "gpui-shell-longbridge-{}-{ordinal}",
            std::process::id()
        ));
        copy_tree(&app_dir(), &root);
        let manifest_path = root.join("gpui-shell.json");
        let manifest = fs::read_to_string(&manifest_path).expect("copied application manifest");
        let manifest = manifest.replacen(
            r#""entry": "main.js""#,
            &format!(r#""entry": "{entry}""#),
            1,
        );
        fs::write(manifest_path, manifest).expect("select test application entry");
        Self { root }
    }
}

impl Drop for ApplicationFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("create application fixture directory");
    for entry in fs::read_dir(source).expect("read application fixture source") {
        let entry = entry.expect("application fixture entry");
        // Resolved dependencies are the host's to materialize, not this
        // fixture's to carry. The shell links a script dependency into
        // `app/node_modules` when it loads one, so as soon as the application
        // has been run once there is a link to a directory sitting in the tree
        // these fixtures copy -- which `fs::copy` refuses, being neither a
        // directory to recurse into nor a regular file. Copying what it points
        // at instead puts a real directory where the host expects to place its
        // own link, so the fixture is left without one and the host fills it
        // in exactly as it does for the application itself.
        if entry.file_name() == "node_modules" {
            continue;
        }
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .expect("application fixture file type")
            .is_dir()
        {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy application fixture file");
        }
    }
}

fn load_test_view(
    runtime: &std::rc::Rc<ShellRuntime>,
    fixture: &ApplicationFixture,
    window: &mut gpui_kit::Window,
    cx: &mut gpui_kit::App,
) -> (
    gpui_kit::Entity<gpui_shell::ShellRoot>,
    gpui_kit::Entity<gpui_shell::ScriptView>,
) {
    let root = runtime
        .try_load(&fixture.root, window, cx)
        .expect("load test application through the public host facade");
    let view = root
        .read(cx)
        .content()
        .clone()
        .downcast::<gpui_shell::ScriptView>()
        .expect("test application content is a script view");
    (root, view)
}

/// The modifier this application binds its commands to.
///
/// The keymap picks it from `process.platform`: `cmd` on macOS, `ctrl`
/// everywhere else. A test that hard-codes one of them passes on the platform
/// it was written on and, on the other, presses a chord nothing is bound to --
/// which looks like a broken keymap and is a broken test.
const PRIMARY_MODIFIER: &str = if cfg!(target_os = "macos") {
    "cmd"
} else {
    "ctrl"
};

/// The same modifier as `chordLabel` writes it for a reader.
const PRIMARY_MODIFIER_LABEL: &str = if cfg!(target_os = "macos") {
    "Cmd"
} else {
    "Ctrl"
};

/// The same modifier as a held key rather than as part of a chord. GPUI names
/// the macOS one `platform`, and the workspace reads whichever its own
/// platform means.
fn primary_modifiers() -> gpui_kit::Modifiers {
    if cfg!(target_os = "macos") {
        gpui_kit::Modifiers {
            platform: true,
            ..Default::default()
        }
    } else {
        gpui_kit::Modifiers {
            control: true,
            ..Default::default()
        }
    }
}

#[gpui_kit::test]
fn omarchy_application_follows_system_appearance(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("main.js");
    let main_path = fixture.root.join("main.js");
    let main = fs::read_to_string(&main_path)
        .expect("copied main.js")
        // What this test is about is an Omarchy desktop, and the application
        // asks `process.platform` three times before it will read one: the two
        // theme readers and the sync itself all return early off it. Pinning
        // the import is one replacement covering all three -- otherwise the
        // whole path short-circuits on any host that is not Linux and the test
        // passes its first assertion, fails its second, and exercises none of
        // the behaviour it names.
        .replace(
            "import { exit, platform } from \"process\";",
            "import { exit } from \"process\";\nconst platform = \"linux\";",
        )
        .replace(
            "this.syncSystemTheme(cx);",
            "this.statusBarVisible = true;\n      this.syncSystemTheme(cx);",
        )
        .replace(
            "let themes = null;",
            r##"let fixtureThemes = [
  'mode = "light"\nbackground = "#eeeeee"\nforeground = "#111111"',
  'mode = "dark"\nbackground = "#111111"\nforeground = "#eeeeee"',
];
function nextFixtureTheme() {
  return fixtureThemes.shift() ?? fixtureThemes[1];
}
let themes = null;"##,
        )
        .replace(
            "const { current_colors } = await import(\"omarchy-theme\");\n    return current_colors();",
            "return nextFixtureTheme();",
        );
    fs::write(main_path, main).expect("install changing appearance fixture");
    let manifest =
        gpui_shell::plugin::PluginManifest::read(&fixture.root).expect("fixture manifest");
    gpui_shell::set_capabilities(manifest.capabilities(&fixture.root, &std::env::temp_dir()));
    gpui_shell::set_storage_path(fixture.root.join("storage.json"));

    let fixture_root = fixture.root.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime
                .try_load(&fixture_root, window, cx)
                .expect("load Omarchy application fixture"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.run_until_parked();
    context.update(|_, cx| {
        assert_eq!(
            gpui_kit::base::Theme::global(cx).appearance,
            gpui_kit::base::ThemeAppearance::Light
        );
    });

    context.executor().advance_clock(Duration::from_secs(1));
    context.run_until_parked();
    context.update(|_, cx| {
        assert_eq!(
            gpui_kit::base::Theme::global(cx).appearance,
            gpui_kit::base::ThemeAppearance::Dark,
            "the Omarchy clock must apply a changed system appearance"
        );
    });

    let view = window
        .root(&mut context)
        .expect("Omarchy application root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("Omarchy script view")
        });
    context.update(|window, cx| window.draw(cx).clear(cx));
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        !rendered.contains("theme-toggle"),
        "manual theme controls must not be advertised while following Omarchy:\n{rendered}"
    );
    assert!(
        !rendered.contains("text \"Cmd + T\""),
        "the Omarchy shortcut rail must not advertise manual theme switching:\n{rendered}"
    );
}

#[gpui_kit::test]
fn non_omarchy_application_keeps_manual_theme_switching(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("main.js");
    let main_path = fixture.root.join("main.js");
    let main = fs::read_to_string(&main_path)
        .expect("copied main.js")
        .replace(
            "const fallback = themes[window.appearance()];",
            "const fallback = themes.dark;",
        )
        .replace(
            "this.syncSystemTheme(cx);",
            "this.syncSystemTheme(cx);\n      window.dispatch_action(\"workspace::toggle-theme\");",
        );
    fs::write(main_path, main).expect("install manual theme action fixture");
    let manifest =
        gpui_shell::plugin::PluginManifest::read(&fixture.root).expect("fixture manifest");
    gpui_shell::set_capabilities(manifest.capabilities(&fixture.root, &std::env::temp_dir()));
    gpui_shell::set_storage_path(fixture.root.join("storage.json"));

    let fixture_root = fixture.root.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime
                .try_load(&fixture_root, window, cx)
                .expect("load non-Omarchy application fixture"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.run_until_parked();
    context.update(|_, cx| {
        assert_eq!(
            gpui_kit::base::Theme::global(cx).appearance,
            gpui_kit::base::ThemeAppearance::Dark
        );
    });

    context.executor().advance_clock(Duration::from_secs(1));
    context.run_until_parked();
    context.update(|_, cx| {
        assert_eq!(
            gpui_kit::base::Theme::global(cx).appearance,
            gpui_kit::base::ThemeAppearance::Light,
            "non-Omarchy systems must retain the manual theme shortcut"
        );
    });
}

#[gpui_kit::test]
fn quote_stream_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("quote_stream.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(400.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

/// An order the gateway pushed must survive the read that has not caught up.
///
/// Longbridge accepts an order before this account's list reports one, so the
/// first read after a write comes back without it. A list rebuilt from that
/// read alone drops the order that was just placed -- it appears, and then it
/// vanishes.
#[gpui_kit::test]
fn a_pushed_order_outlives_the_read_that_is_behind_it(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("order_push.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(600.), gpui_kit::px(400.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

#[gpui_kit::test]
fn trade_stream_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("trade_stream.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(400.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

#[gpui_kit::test]
fn auth_and_http_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("auth_http.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(400.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

#[gpui_kit::test]
fn fps_visibility_preference_defaults_off_and_round_trips(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let fixture = ApplicationFixture::new("fps_preference.test.js");
    gpui_shell::set_storage_path(fixture.root.join("fps-preference-store.json"));
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(400.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

#[gpui_kit::test]
fn the_chosen_chart_interval_outlives_the_session(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let fixture = ApplicationFixture::new("chart_mode_preference.test.js");
    gpui_shell::set_storage_path(fixture.root.join("chart-mode-store.json"));
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(400.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(rendered.contains("text \"ok\""), "{rendered}");
}

#[gpui_kit::test]
fn chart_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("chart.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn chart_mode_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("chart_modes.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn candlestick_geometry_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("candlestick_chart.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn chart_mode_state_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("chart_modes_state.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn reconnect_invalidates_the_superseded_chart_request_before_stopping(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("chart_reconnect.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn protocol_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("protocol.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn market_state_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("market.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn market_detail_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("market_detail.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn market_detail_state_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("market_detail_state.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn orders_page_stacks_today_over_history_as_one_filtered_reading(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("orders_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // The open sheet carries what can still be done to that order, so a reader
    // with an order in front of them does not have to go back and right-click
    // its row. This one is filled, so there is nothing left to do to it and
    // the sheet offers nothing -- a control drawn and disabled would be a row
    // of grey saying what the status already says.
    assert!(
        !rendered.contains("Modify") && !rendered.contains("Withdraw"),
        "a finished order must be offered no actions:\n{rendered}"
    );

    // Two panels, Today first: what is working now is the shorter list and the
    // one read first, and the record underneath it is the one worth scrolling.
    assert!(
        rendered.contains(r#":id[Str("today-orders")]"#)
            && rendered.contains(r#":id[Str("history-orders")]"#),
        "{rendered}"
    );
    assert!(
        rendered.find("Today Orders") < rendered.find("History Orders"),
        "{rendered}"
    );
    // A filter each: the two lists answer different questions, and one box for
    // the two of them hid the short list whenever the long one was narrowed.
    assert_eq!(
        rendered
            .lines()
            .filter(|line| line.trim_start().starts_with("Input ."))
            .count(),
        2,
        "each list carries its own filter:\n{rendered}"
    );
    assert!(
        rendered.contains("text \"2 orders\"")
            && rendered.contains("text \"2 orders · last 365 days\""),
        "each table says how much of the account it is showing:\n{rendered}"
    );
    // Today is as tall as the rows it has -- its chrome plus two of them --
    // rather than taking a share of the page and spending it on nothing.
    assert!(
        rendered.contains(
            r#":id[Str("today-orders")] .flex_1 .min_h[Number(0.0)] .h[Number(153.0)] .flex_none"#
        ),
        "Today is sized from its rows:\n{rendered}"
    );

    // Both lists are the virtualized table the rest of the application uses:
    // the rows are built during layout for the range on screen, and the table
    // announces the whole collection rather than the window onto it.
    assert!(
        rendered.contains("v_virtual_list \"today-orders-rows\" \u{00d7}2")
            && rendered.contains("v_virtual_list \"history-orders-rows\" \u{00d7}2")
            && rendered.contains(r#"Table "today-orders-table""#)
            && rendered.contains(r#"Table "history-orders-table""#)
            && rendered.matches(":row_count[Number(3.0)]").count() == 2,
        "{rendered}"
    );

    // The Longbridge terminal's columns, folded in half: a desktop row has two
    // lines where a TUI row has one, so each pair that is only ever read
    // together shares a column instead of taking one of its own.
    for column in [
        "INSTRUMENT",
        "SIDE",
        "STATUS",
        "FILLED",
        "PRICE",
        "SUBMITTED",
    ] {
        assert!(
            rendered.contains(column),
            "missing {column} column:\n{rendered}"
        );
    }

    // What one row draws, read off the probe's directly-built table.
    let filled = rendered
        .split_once(r#"TableRow "order-884955210000""#)
        .and_then(|(_, rows)| rows.split_once(r#"TableRow "order-884955209000""#))
        .map(|(row, _)| row)
        .unwrap_or_else(|| panic!("the filled order's row:\n{rendered}"));
    for reading in [
        "AAPL.US",
        "Apple Inc.",
        "Filled",
        "LO",
        "of 10",
        "188.500",
        "188.480",
        // Market-local wall clock over the market's own calendar date, never
        // UTC and never the reader's zone.
        "17:13:20",
        "2023-11-14",
    ] {
        assert!(filled.contains(reading), "missing {reading}:\n{filled}");
    }

    // A market order named no price, and zero is not one.
    let working = rendered
        .split_once(r#"TableRow "order-884955210001""#)
        .and_then(|(_, rows)| rows.split_once(r#"TableRow "order-884955210000""#))
        .map(|(row, _)| row)
        .unwrap_or_else(|| panic!("the working order's row:\n{rendered}"));
    assert!(
        working.contains("MO")
            && working.contains("Working at the exchange")
            && working.contains("text \"--\""),
        "an order with no price shows none:\n{working}"
    );

    // Rows are keyed by order, not by instrument: an account holds several
    // orders on one symbol, and an instrument key would collapse them.
    for order in [
        "order-884955210000",
        "order-884955210001",
        "order-884955209000",
        "order-884955209001",
    ] {
        assert!(
            rendered.contains(&format!("TableRow \"{order}\"")),
            "missing row {order}:\n{rendered}"
        );
    }
    assert!(
        rendered.contains("Rejected")
            && rendered.contains("Insufficient buying power")
            && rendered.contains("Cancelled"),
        "an order that never filled says why:\n{rendered}"
    );

    // A click on a row is answered beside the lists: one order in full, with
    // the way out of it and the way through to its instrument.
    assert!(
        rendered.contains(
            r#":id[Str("orders-page-split")] .flex_1 .min_h[Number(0.0)] .items_stretch"#
        ) && rendered.contains(r#":id[Str("order-detail-panel")]"#)
            && rendered.contains(r#":id[Str("order-detail-884955210000")]"#),
        "the selected order opens a sheet on the right:\n{rendered}"
    );
    // Quiet icon controls rather than captioned buttons: a panel title row has
    // room for the mark and not for the word. Both are the kit's small compact
    // command -- one square extent, one icon step -- rather than a size this
    // panel picked for itself.
    assert!(
        rendered.contains(r#"Button "order-detail-close""#)
            && rendered.contains(r#"Button "order-detail-quote""#)
            && rendered.contains(r#"svg "assets/x.svg" .size[Number(11.0)]"#)
            && rendered.contains(r#"svg "assets/chart-line.svg" .size[Number(11.0)]"#)
            && rendered.contains(r#".flex_none .size[Number(24.0)]"#),
        "the sheet carries its own way out, and the way through to the quote:\n{rendered}"
    );
    assert!(
        rendered.contains(r#":tooltip[Str("Close order detail")]"#)
            && rendered.contains(r#":accessibility_label[Str("Open this instrument")]"#),
        "an icon control says what it does in its tooltip and its label:\n{rendered}"
    );
    let sheet = rendered
        .split_once(r#":id[Str("order-detail-884955210000")]"#)
        .and_then(|(_, section)| {
            section
                .split_once(r#"Table "probe-orders""#)
                .map(|(section, _)| section)
        })
        .unwrap_or_else(|| panic!("the open sheet:\n{rendered}"));
    for reading in [
        "ORDER",
        "EXECUTION",
        "TIMING",
        "Time in force",
        "Filled price",
        "188.480 USD",
        "Last done",
        "2023-11-14 17:13:20",
        "Order ID",
        "884955210000",
        "desk ticket",
    ] {
        assert!(sheet.contains(reading), "missing {reading}:\n{sheet}");
    }
    // A row whose value the API never sent is left out, rather than drawn as a
    // dash: a sheet of dashes reads as missing data, when what is true is that
    // this order has no trigger and was never amended.
    assert!(
        sheet.contains("Updated") && sheet.contains("2023-11-14 17:13:50"),
        "an order that was amended says when:\n{sheet}"
    );
    assert!(
        !sheet.contains("Trigger price") && !sheet.contains("Outside RTH"),
        "the sheet states what the order has, not what it lacks:\n{sheet}"
    );
}

#[gpui_kit::test]
fn an_empty_today_gives_its_height_back_to_the_history(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("orders_empty_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    let today = rendered
        .split_once(r#":id[Str("today-orders")]"#)
        .and_then(|(_, section)| {
            section
                .split_once(r#":id[Str("history-orders")]"#)
                .map(|(section, _)| section)
        })
        .unwrap_or_else(|| panic!("the Today panel:\n{rendered}"));

    // Most days there is nothing working, so an empty Today is the ordinary
    // case: it keeps its heading and its filter, says one line, and claims no
    // height for the rows it does not have.
    // The panel's own line, so the assertion reads its box and not the boxes
    // of the controls inside it.
    let today_box = today.lines().next().unwrap_or_default();
    assert!(
        today_box.contains(".flex_none") && !today_box.contains(".h[Number("),
        "an empty Today must not reserve a table's height:\n{today_box}"
    );
    assert!(
        today.contains(r#":id[Str("today-orders-state")]"#) && today.contains("No orders today."),
        "{today}"
    );
    assert!(
        !today.contains(r#"TableHeader "today-orders-header""#)
            && !today.contains("v_virtual_list \"today-orders-rows\"")
            && !today.contains("Nothing to show"),
        "no column heads and no empty card over no rows:\n{today}"
    );
    assert!(
        today.contains("Today Orders") && today.contains("0 orders") && today.contains("Input ."),
        "the heading still carries the count and the filter:\n{today}"
    );

    // The list that does have rows is unchanged, and now has the page to
    // itself.
    let history = rendered
        .split_once(r#":id[Str("history-orders")]"#)
        .map(|(_, section)| section)
        .expect("the History panel");
    assert!(
        history.contains(".flex_1 .min_h[Number(200.0)]")
            && history.contains("v_virtual_list \"history-orders-rows\" \u{00d7}2")
            && history.contains(r#"TableHeader "history-orders-header""#),
        "{history}"
    );
    assert_eq!(
        rendered
            .lines()
            .filter(|line| line.trim_start().starts_with("Input ."))
            .count(),
        2,
        "both lists keep a filter of their own, empty or not:\n{rendered}"
    );
}

#[gpui_kit::test]
fn watchlist_edit_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("watchlist_edit.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn order_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("orders.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

/// A dialog the shell dismissed by itself must be openable again.
///
/// `DialogOptions` has no close callback, so `escape_dismissable` and
/// `backdrop_dismissable` leave the application's own "is it open?" field
/// saying yes about a surface that is gone. Every `open...` guard reads that
/// field, so the ticket could otherwise be opened exactly once per run.
#[gpui_kit::test]
fn a_dialog_dismissed_by_the_shell_can_be_opened_again(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("dialog_reopen.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("dialogs reopen after the shell dismisses them"),
        "{rendered}"
    );
}

/// The ticket can be filled in without a pointer.
///
/// This application is driven from the keyboard and the ticket is reached by
/// one, so a form that can only be completed by clicking is a form half of it
/// cannot use.
#[gpui_kit::test]
fn the_order_ticket_can_be_filled_in_from_the_keyboard(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("ticket_keyboard.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("the ticket is fillable from the keyboard"),
        "{rendered}"
    );
    // Every control the ticket is filled in with is walked in the order it is
    // read in, and that order is the order it is built in.
    //
    // Nothing here names an index. A base `Tab` owns that part of its own
    // focus and refuses one written onto it, so the segmented runs could not
    // be numbered even if the rest were -- and an explicit index is walked
    // after everything that has none, so numbering the fields around them
    // would have walked the fields last and the choices first.
    let mut at = 0usize;
    // Labels and controls together, so this says what is read as well as what
    // is focused -- including that the sizing switch sits in the caption row
    // of the field it changes, and so is reached before that field rather
    // than after it.
    for marker in [
        "Type",
        "ButtonGroup \"ticket-type\"",
        "Price",
        "USD",
        "Quantity",
        "Use amount",
        "shares",
        "Valid",
        "ButtonGroup \"ticket-tif\"",
        "Sessions",
        "ButtonGroup \"ticket-rth\"",
        "Cancel",
        "Review",
    ] {
        let found = rendered[at..].find(marker).unwrap_or_else(|| {
            panic!("the ticket must offer {marker}, after what precedes it:\n{rendered}")
        });
        at += found + marker.len();
    }
    let stops: Vec<usize> = rendered
        .match_indices(":tab_index[Number(")
        .map(|(at, _)| {
            rendered[at..]
                .split_once('(')
                .and_then(|(_, rest)| rest.split_once('.'))
                .and_then(|(digits, _)| digits.parse().ok())
                .unwrap_or(0)
        })
        .filter(|index| *index > 0)
        .collect();
    // Whatever the library does inside one run of choices is its own business;
    // what must not appear is an index this application chose, which is any
    // number bigger than a run is long.
    assert!(
        stops.iter().all(|index| *index <= 2),
        "the ticket must not name tab indices of its own: {stops:?}\n{rendered}"
    );
}

#[gpui_kit::test]
fn the_order_ticket_states_what_it_will_send(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("trade_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // The form names every field that decides what is sent, and groups them by
    // the question they answer: what is being traded, and how long the order
    // stands. Six evenly spaced rows would say those are six equal decisions.
    assert!(
        rendered.contains(r#":id[Str("order-ticket-dialog")]"#)
            && rendered.contains("Type")
            && rendered.contains("Price")
            && rendered.contains("Quantity")
            && rendered.contains("Valid"),
        "the ticket must state its fields:\n{rendered}"
    );
    assert!(
        rendered.contains("ORDER") && rendered.contains("DURATION"),
        "the ticket's fields must be grouped by the question they answer:\n{rendered}"
    );
    assert!(
        rendered.find("ORDER") < rendered.find("DURATION"),
        "what is traded comes before how long it stands:\n{rendered}"
    );
    // The unit belongs to the value, so it is inside the field rather than
    // hung beside it -- `TextField.suffix`, drawn over the field's own right
    // edge with the padding to keep the digits clear of it.
    assert!(
        rendered.contains("text \"USD\"") && rendered.contains("text \"shares\""),
        "a field whose value is in something must carry that unit:\n{rendered}"
    );
    // A US instrument can be traded outside regular hours, so the choice is
    // offered rather than decided silently.
    assert!(
        rendered.contains("Sessions") && rendered.contains("Pre/post"),
        "a US ticket must offer its sessions:\n{rendered}"
    );
    // Selling states the position it may not exceed.
    assert!(
        rendered.contains("25 available to sell"),
        "a sale must state what is available:\n{rendered}"
    );

    // The confirmation restates the order, including what it is expected to
    // cost -- grouped in thousands, which `Intl` does not do in this runtime.
    assert!(
        rendered.contains(r#":id[Str("order-confirm-summary")]"#)
            && rendered.contains("1,885.00 USD"),
        "the confirmation must state the estimate:\n{rendered}"
    );
    // A market order has no price and no estimate, and says so rather than
    // showing a zero it does not promise.
    assert!(
        rendered.contains("Market price") && rendered.contains("text \"--\""),
        "a market order must not claim an estimate:\n{rendered}"
    );
    // Selling more than is held is refused in the form, before anything is
    // sent -- the ticket stays on its fields rather than reaching a
    // confirmation.
    assert!(
        rendered.contains("This account holds 25."),
        "an oversized sale must be refused locally:\n{rendered}"
    );
    // Sizing by amount. 1500 USD at 214.07 is 7 shares -- rounded down, since
    // a share is whole -- and the ticket previews that while the amount is
    // still editable rather than only at the confirmation.
    // One control naming the mode it switches to, beside a field whose label
    // already says which mode is in force -- not two buttons competing for a
    // selected state in a caption row.
    assert!(
        rendered.contains("Use shares") && rendered.contains("Amount"),
        "a purchase must offer to be sized by amount:\n{rendered}"
    );
    // 1500 USD at 214.07 in the regular session, where fractional shares
    // match: the division to four places rather than the seven whole shares
    // that would leave the budget an odd hair short.
    assert!(
        rendered.contains("Buys 7.0071 shares"),
        "the form must preview what the amount buys:\n{rendered}"
    );
    // The confirmation shows the sum asked for beside what it actually buys.
    // They differ by the remainder, and showing only the budget would claim
    // the whole of it was spent.
    assert!(
        rendered.contains("1,500.00 USD") && rendered.contains("1,500.00 USD"),
        "the confirmation must show the budget and its cost:\n{rendered}"
    );
    // A market order sized by amount has no price of its own, so it names what
    // it divided by -- a share count nobody can check is an assertion.
    assert!(
        rendered.contains("Sized at") && rendered.contains("214.07 USD last"),
        "a market order sized by amount must name its basis:\n{rendered}"
    );
    assert!(
        rendered.contains("Not enough for one share."),
        "an amount below one share must be refused locally:\n{rendered}"
    );

    // A Hong Kong ticket states its board lot up front, and refuses a part lot
    // locally -- the exchange would refuse it anyway, a round trip later.
    assert!(
        rendered.contains("In multiples of 100"),
        "a board lot must be stated before it is typed against:\n{rendered}"
    );
    assert!(
        rendered.contains("Board lot is 100."),
        "a part lot must be refused locally:\n{rendered}"
    );

    // Withdrawing confirms which order, and offers no fields.
    assert!(
        rendered.contains("This order will be withdrawn.")
            && rendered.contains("Order 884955210001"),
        "a withdrawal must name its order:\n{rendered}"
    );

    // Buying and selling are told apart by colour, not only by the word, in
    // every menu that offers them. The probe's theme draws every colour as
    // #000000, so what is asserted is that a tone was applied at all -- the
    // two menu items carry an explicit text colour where a plain item, `Copy
    // symbol`, does not.
    for menu in ["Buy", "Sell"] {
        assert!(
            rendered.contains(menu),
            "the menus must offer {menu}:\n{rendered}"
        );
    }
    // A holding is not necessarily on a watchlist, so its menu does not offer
    // to take it off one.
    // Counting the drawn caption rather than every occurrence of the word: an
    // Omarchy UI menu item also carries it as an accessibility label, and an
    // assertion that counts both breaks whenever the library adds a mention.
    assert_eq!(
        rendered.matches(r#"text "Remove""#).count(),
        1,
        "only the watchlist menu removes from a watchlist:\n{rendered}"
    );
    // An order's menu acts on the order, not on the instrument.
    assert!(
        rendered.contains("Modify order\u{2026}") && rendered.contains("Withdraw order"),
        "an order menu must offer to change and withdraw it:\n{rendered}"
    );
}

#[gpui_kit::test]
fn trade_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("trade.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn portfolio_vectors_run_against_this_application(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("portfolio.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let _loaded = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
}

#[gpui_kit::test]
fn watchlist_row_renders_scannable_market_columns(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("watchlist_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(900.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    for expected in [
        // The column heads, folded to terminal small-caps on their way to the
        // screen. `COLUMN_HINTS` is still keyed by the title as written, which
        // the tooltip assertion further down reads.
        "INSTRUMENT",
        "LAST",
        "CHANGE",
        "VOLUME",
        "SESSION",
        "Apple",
        "text \"AAPL\"",
        "188.00",
        "+4.44%",
        "8.59B",
        "Trading",
        // Field labels beside their values, which stay sentence case. The
        // last six are the folded half of the pane, drawn because the probe
        // renders the disclosure open.
        "Previous close",
        "Open",
        "High",
        "Low",
        "Volume",
        "Turnover",
        "More detail",
        "Day range",
        "Amplitude",
        "Average price",
        "From open",
        "Last market update",
        "Data health",
        "181.00 — 190.25",
        "1.59B",
        "Live · 5s ago",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected}:\n{rendered}"
        );
    }
    assert!(!rendered.contains("text \"US · AAPL\""), "{rendered}");
    // The row opens with an `Avatar` that has only its fallback filled: there
    // is no per-market artwork in the application directory, and an image that
    // never resolves is the case the fallback exists for.
    assert!(
        rendered.contains("Avatar") && rendered.contains("AvatarFallback"),
        "the row must carry a market badge:\n{rendered}"
    );
    assert!(!rendered.contains("AvatarImage"), "{rendered}");
    // The row's figures are monospaced because the whole window is, from the
    // application root down -- which this probe deliberately does not render,
    // so the half it can prove is that nothing here overrides that family.
    // `a_bound_chord_reaches_the_action_that_switches_page` renders the real
    // root and asserts the other half: that exactly one element sets one.
    assert!(
        !rendered.contains(".font_family["),
        "a figure must inherit the root's family, not restate one:\n{rendered}"
    );

    // A TableHead is a semantic table part, not an interactive shell element.
    // Its tooltip must live on the full-size div it contains, otherwise the
    // shell cannot wire the hover listeners and emits a warning instead.
    let instrument_head = rendered
        .lines()
        .find(|line| line.contains(r#"TableHead "watchlist-head-1" #1"#))
        .expect("instrument table header");
    assert!(
        !instrument_head.contains(":tooltip"),
        "the table part cannot own the tooltip: {instrument_head}"
    );
    let instrument_header_children = rendered
        .split_once(r#"TableHead "watchlist-head-1" #1"#)
        .and_then(|(_, following)| following.split_once(r#"TableHead "watchlist-head-2" #2"#))
        .map(|(children, _)| children)
        .expect("instrument header's descendant range");
    let instrument_tooltip = instrument_header_children
        .lines()
        .find(|line| line.contains(r#":tooltip[Str("Ticker and security name")]"#))
        .expect("instrument tooltip on a table-header descendant");
    assert!(
        instrument_tooltip.trim_start().starts_with("div "),
        "a shell-owned div must carry the header tooltip: {instrument_tooltip}"
    );

    // A popup trigger draws its own open state. Styling it from focus alone
    // reads backwards: the surface holds the keyboard while it is up, so the
    // trigger would go flat exactly while the menu is showing.
    let closed = rendered
        .lines()
        .find(|line| line.contains("probe-menu-closed"))
        .expect("closed trigger");
    let open = rendered
        .lines()
        .find(|line| line.contains("probe-menu-open"))
        .expect("open trigger");
    // Asserted structurally rather than by comparing painted colour: the
    // palette moved out of the Rust host into the application, and a probe is
    // not the application -- it has no filesystem grant to load `theme.json`,
    // so every token here resolves to #000000 and any colour would equal any
    // other. These two are what the bug actually broke.
    assert!(!closed.contains(":selected[Bool(true)]"), "{closed}");
    assert!(open.contains(":selected[Bool(true)]"), "{open}");

    // The row a menu is open for wears a ring; the selected row a fill and no
    // ring, so the two read apart when they are different rows.
    let menu_row = rendered
        .split(r#"TableRow "quote-MSFT.US""#)
        .nth(1)
        .and_then(|rest| rest.split("TableRow ").next())
        .expect("the probe draws the row a menu is open for");
    assert!(
        menu_row.contains(".absolute") && menu_row.contains(".border[Number(1"),
        "the menu's row carries a ring:\n{menu_row}"
    );
    let selected_row = rendered
        .split(r#"TableRow "quote-AAPL.US""#)
        .nth(1)
        .and_then(|rest| rest.split("TableRow ").next())
        .expect("the probe draws the selected row");
    assert!(
        !selected_row.contains(".absolute"),
        "the selected row carries no ring:\n{selected_row}"
    );
    let compact = rendered
        .split_once(r#"Table "probe-watchlist-compact""#)
        .map(|(_, compact)| compact)
        .expect("compact watchlist table");
    for expected in ["INSTRUMENT", "LAST", "AAPL.US", "Apple", "188.00", "+4.44%"] {
        assert!(
            compact.contains(expected),
            "missing compact {expected}:\n{compact}"
        );
    }
    for hidden in ["CHANGE", "VOLUME", "SESSION", "8.59B", "Trading", "Avatar"] {
        assert!(
            !compact.contains(hidden),
            "compact row must hide {hidden}:\n{compact}"
        );
    }
    assert!(
        compact.contains(".truncate") && compact.contains(".min_w[Number(0.0)]"),
        "compact lanes must shrink and truncate rather than overlap:\n{compact}"
    );
    assert!(
        compact.contains(".w[Str(\"60%\")]")
            && compact.contains(".w[Str(\"40%\")]")
            && compact.contains(".h[Number(44.0)]"),
        "the minimum Watchlist layout keeps symbol/name and last/change in two aligned stacked lanes:\n{compact}"
    );

    // And focus must not paint like open. A Popover hands the keyboard back to
    // its trigger when it dismisses, so a focused-but-closed trigger that
    // said the same thing an open one says would leave a closed menu looking
    // open.
    //
    // The two are told apart by which chrome they take: focus draws the ring,
    // open draws the selection. Asserted as the ring rather than as a colour,
    // for the reason the selection assertions above give -- a probe has no
    // palette, so every token here resolves to the same value and comparing
    // two of them proves nothing.
    let focus = closed
        .split(":focus(")
        .nth(1)
        .expect("closed trigger has a focus style");
    assert!(
        focus.contains(".border_color["),
        "focus has to draw the ring: {focus}"
    );
    assert!(
        open.contains(":focus("),
        "an open trigger keeps a focus style of its own:\n{open}"
    );
}

#[gpui_kit::test]
fn authenticated_workspace_materializes_a_scrollable_watchlist(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("workspace_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1120.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        assert_eq!(view.read(cx).build_error(), None);
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    assert!(
        rendered.contains(r#":id[Str("watchlist-panels")]"#)
            && rendered.contains(r#":id[Str("watchlist-pane")]"#)
            && rendered.contains(r#":id[Str("quote-details-panel")]"#)
            && rendered.contains(r#":id[Str("chart-panel")]"#)
            && rendered.contains(r#":id[Str("market-detail-panel")]"#)
            // The interval run is the library's `Tabs` now; the id is the
            // caller's and the component appends each choice's value to it.
            && rendered.contains("TabList \"chart-mode\"")
            && !rendered.contains("dock_area"),
        "the responsive page must materialize four plain Panels in priority order: {rendered}"
    );
}

/// The panes still draw what they always drew; they simply draw it inside a
/// panel now. This probe renders one of them directly, which is the only way to
/// read a panel's own description from here.
#[gpui_kit::test]
fn the_watchlist_pane_still_virtualizes_its_rows(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("watchlist_click.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1120.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // The rows are not in this tree, and that is the point: a virtual list
    // describes itself and its item count, and its rows are built during layout
    // for the range on screen. `watchlist_ui.test.js` covers what one row draws.
    assert!(
        rendered.contains("v_virtual_list \"watchlist-rows\" \u{00d7}12"),
        "{rendered}"
    );
    assert!(
        rendered.contains("Scrollbar \"watchlist-rows\""),
        "{rendered}"
    );
    assert!(!rendered.contains("Test security 12"), "{rendered}");
    assert!(rendered.contains("watchlist-pane"), "{rendered}");
    // Column tooltips remain on shell-owned descendants.
    assert!(rendered.contains(":tooltip"), "{rendered}");
}

#[gpui_kit::test]
fn retained_price_chart_owns_its_indicator_and_dated_tooltip(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("price_chart_view.test.js");
    let fixture_root = fixture.root.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime
                .try_load(&fixture_root, window, cx)
                .expect("load retained price-chart probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("price-chart root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("price-chart content is a script view")
        });
    let tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            assert_eq!(
                view.read(cx).build_error(),
                None,
                "workspace must build before checking its actions"
            );
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };
    let initial = tree(&mut context);
    assert!(!initial.contains("5D intraday"), "{initial}");
    assert!(
        initial.contains("Button \"probe-chart-mode-5D\" .flex_1 :selected[Bool(true)]"),
        "the retained chart starts in its default 5D mode:\n{initial}"
    );
    assert!(initial.contains("price-chart-5D"), "{initial}");
    assert!(initial.contains(":on_mouse_move(fn)"), "{initial}");
    assert!(initial.contains(":on_hover(fn)"), "{initial}");

    context.simulate_mouse_move(
        gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(80.)),
        None,
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let hovered = tree(&mut context);
    assert!(hovered.contains("2026-03-09 09:30"), "{hovered}");
    assert!(!hovered.contains("UTC"), "{hovered}");
    assert!(!hovered.contains("undefined"), "{hovered}");
    assert!(
        hovered.matches("path fill").count() > initial.matches("path fill").count()
            && hovered.matches("path stroke").count() > initial.matches("path stroke").count(),
        "the child must draw its marker and indicator after pointer movement:\n{hovered}"
    );

    // Move out only after the pointer callback replaced the script snapshot.
    // This exercises the current snapshot's genuine `on_hover(false)` path,
    // rather than clearing hover by directly invoking child state.
    context.simulate_mouse_move(
        gpui_kit::point(gpui_kit::px(700.), gpui_kit::px(300.)),
        None,
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let left = tree(&mut context);
    assert!(!left.contains("2026-03-09"), "{left}");
    assert_eq!(
        left.matches("path fill").count(),
        initial.matches("path fill").count(),
        "leaving the replaced child snapshot must remove its marker:\n{left}"
    );
    assert_eq!(
        left.matches("path stroke").count(),
        initial.matches("path stroke").count(),
        "leaving the replaced child snapshot must remove its indicator:\n{left}"
    );

    context.simulate_click(
        gpui_kit::point(gpui_kit::px(400.), gpui_kit::px(14.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.simulate_mouse_move(
        gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(100.)),
        None,
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let candles = tree(&mut context);
    assert!(!candles.contains("1m candles"), "{candles}");
    assert!(
        candles.contains("O 100  H 104") && candles.contains("Volume 42"),
        "{candles}"
    );
    assert!(candles.contains("price-chart-candles"), "{candles}");
    assert!(
        candles.contains("03-09 09:30") && candles.contains("03-09 09:31"),
        "candlestick charts need market-local date/time references along the bottom axis:\n{candles}"
    );
    assert!(
        candles.contains("2026-03-09 09:30"),
        "candlestick tooltips need a full market-local date and time:\n{candles}"
    );
    assert!(
        candles.contains("candlestick-axis-tick-")
            && candles.contains(r#".left[Number(-40.0)]"#)
            && candles.contains(r#".w[Number(80.0)]"#),
        "candlestick labels must stay centred on their wick without overlapping in a narrow Right Dock:\n{candles}"
    );

    context.simulate_click(
        gpui_kit::point(gpui_kit::px(75.), gpui_kit::px(14.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let intraday = tree(&mut context);
    assert!(intraday.contains("Intraday"), "{intraday}");
    assert!(
        intraday.contains("Overnight")
            && intraday.contains("Pre-market")
            && intraday.contains("Regular")
            && intraday.contains("Post-market"),
        "the full-session line names every provider-labelled session:\n{intraday}"
    );
    assert!(intraday.contains("Previous close 98.5"), "{intraday}");
    assert!(
        intraday.contains("intraday-current-marker"),
        "the current price must remain visible even before the pointer enters the plot:\n{intraday}"
    );
    for (x, session) in [
        (75., "Overnight"),
        (220., "Pre-market"),
        (350., "Regular"),
        (460., "Post-market"),
    ] {
        context.simulate_mouse_move(
            gpui_kit::point(gpui_kit::px(x), gpui_kit::px(100.)),
            None,
            gpui_kit::Modifiers::default(),
        );
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
        let tooltip = tree(&mut context);
        assert!(
            tooltip.contains(&format!("Session {session}")),
            "the Intraday tooltip must retain the provider session name {session}:\n{tooltip}"
        );
    }
}

#[gpui_kit::test]
fn retained_price_chart_hover_rebuilds_the_child_without_the_parent(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("price_chart_retained.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_window = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_window
                .try_load(&fixture_root, window, cx)
                .expect("load retained parent/price-chart probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));

    let parent = window
        .root(&mut context)
        .expect("price-chart parent root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("price-chart parent content is a script view")
        });
    let parent_tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            parent
                .read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };
    assert!(
        parent_tree(&mut context).contains("Parent renders: 1"),
        "the parent must start with one published snapshot"
    );

    let drive_child_only = |context: &mut VisualTestContext,
                            point: gpui_kit::Point<gpui_kit::Pixels>,
                            operation: &str| {
        let before = runtime.read_metrics();
        context.simulate_click(point, gpui_kit::Modifiers::default());
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(
            runtime.read_metrics().since(&before).script_renders(),
            1,
            "{operation} must rebuild exactly the retained child"
        );
        let tree = parent_tree(context);
        assert!(
            tree.contains("Parent renders: 1"),
            "{operation} rebuilt the parent:\n{tree}"
        );
    };

    drive_child_only(
        &mut context,
        gpui_kit::point(gpui_kit::px(75.), gpui_kit::px(20.)),
        "loading props",
    );
    drive_child_only(
        &mut context,
        gpui_kit::point(gpui_kit::px(225.), gpui_kit::px(20.)),
        "error props",
    );
    drive_child_only(
        &mut context,
        gpui_kit::point(gpui_kit::px(375.), gpui_kit::px(20.)),
        "ready props",
    );

    let before_hover = runtime.read_metrics();
    context.simulate_mouse_move(
        gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(100.)),
        None,
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(
        runtime.read_metrics().since(&before_hover).script_renders(),
        1,
        "hover must rebuild exactly the retained chart child"
    );
    let tree = parent_tree(&mut context);
    assert!(
        tree.contains("Parent renders: 1"),
        "hover rebuilt the parent:\n{tree}"
    );
}

#[gpui_kit::test]
fn a_large_candlestick_publication_does_not_overflow_nested_view_rollback(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("price_chart_large.test.js");
    let fixture_root = fixture.root.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime
                .try_load(&fixture_root, window, cx)
                .expect("load large price-chart probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(160.), gpui_kit::px(20.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let root = window.root(&mut context).expect("large-chart root");
    let rendered = root.read_with(&context, |root, cx| {
        root.0
            .read(cx)
            .content()
            .clone()
            .downcast::<gpui_shell::ScriptView>()
            .expect("large-chart script view")
            .read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("Publish 12,000 candles · published")
            && !rendered.contains("rollback limit"),
        "publishing a full minute window must not cross the nested-view rollback limit:\n{rendered}"
    );
}

#[gpui_kit::test]
fn unrelated_quote_updates_do_not_rebuild_the_price_chart_child(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("price_chart_updates.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_window = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_window
                .try_load(&fixture_root, window, cx)
                .expect("load price-chart update probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));
    let before = runtime.read_metrics();

    context.simulate_click(
        gpui_kit::point(gpui_kit::px(20.), gpui_kit::px(20.)),
        gpui_kit::Modifiers::default(),
    );
    // Quotes no longer repaint as they land. They arrive in bursts and a
    // repaint on a restored layout is a whole-window refresh, so the burst is
    // coalesced into one; the clock this advances past is that coalescing
    // window, not a delay anybody waits on.
    context.executor().advance_clock(Duration::from_millis(200));
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let delta = runtime.read_metrics().since(&before);

    assert_eq!(
        delta.script_renders(),
        1,
        "the unrelated quote should rebuild only the root, not its chart child"
    );
}

#[gpui_kit::test]
fn clicking_a_watchlist_row_selects_that_instruments_details(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("watchlist_click.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load authenticated watchlist click probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.update(|window, cx| window.draw(cx).clear(cx));

    // The table header occupies the first 44px after the Watchlist's title
    // bar. The second uniform 44px item is therefore at y=130 in this fixed
    // probe layout. Clicking it exercises the native virtual-list hit box,
    // rather than invoking selection directly.
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(130.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("Selected TEST01.US"),
        "clicking the second visible row must select its stock details:\n{rendered}"
    );
}

#[gpui_kit::test]
fn allocation_donut_folds_past_the_available_theme_palette(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("allocation_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(640.), gpui_kit::px(400.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // Seven priced positions, six wedges: the two smallest are one remainder.
    // Twice over, because the probe draws the ring at rest and again with a
    // wedge under the pointer.
    assert_eq!(
        rendered.matches("path fill").count(),
        12,
        "expected six wedges per ring:\n{rendered}"
    );
    assert!(
        rendered.contains("Other (2 positions)"),
        "the folded tail is named:\n{rendered}"
    );
    assert!(rendered.contains("Alpha"), "{rendered}");
    assert!(
        !rendered.contains("Zeta") && !rendered.contains("Eta"),
        "folded holdings leave the legend:\n{rendered}"
    );

    // Pointing at a legend row lights its wedge and fades the others back. A
    // wedge cannot be pointed at directly -- every one of them is painted into
    // the same square -- so the row is the handle, and it carries the handler.
    // The handler is on a plain element covering the row rather than on the
    // row: a table part carries its click and its hover styles, and an
    // `on_hover` written on one is dropped on the way through.
    assert!(
        rendered.contains(
            r#"div :id[Str("allocation-hover-USD-A.US")] .absolute .inset_0 :on_hover(fn)"#
        ),
        "a legend row is the wedge's handle:\n{rendered}"
    );
    // The ring is a handle too, and the only one that can answer for a wedge:
    // every wedge is painted into this same box, so what the box reports is
    // where the pointer is, and `allocationSliceAt` says which wedge that is.
    assert!(
        rendered.contains(r#":id[Str("allocation-ring-USD")]"#)
            && rendered.contains(":on_mouse_move(fn)"),
        "the ring answers the pointer directly:\n{rendered}"
    );
    assert_eq!(
        rendered.matches(".opacity[Number(0.4)]").count(),
        5,
        "one wedge lit leaves the other five faded back:\n{rendered}"
    );
    assert!(
        rendered.contains(":transition(opacity, 150ms, 0ms, ease-out)"),
        "the fade is animated rather than switched:\n{rendered}"
    );

    // Color origin is covered by palette.test.js; this host-level vector owns
    // chart geometry and folding, not a particular installed Omarchy theme.
}

#[gpui_kit::test]
fn portfolio_renders_pnl_summary_and_position_columns(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("portfolio_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(900.), gpui_kit::px(600.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    for expected in [
        "Portfolio summary",
        // What the account holds, beside what of it is the holder's. The
        // endpoint reports only the second -- `net_assets` is net of what was
        // borrowed -- and on a margin account the two are different questions:
        // the probe's holding is worth 1,880 against 5,000 of cash, and its
        // `net_assets` says 25,000. The total is added up here, so it must be
        // the sum of the positions and the cash and not the endpoint's figure.
        "Total assets",
        "6880.00 USD",
        "Net assets",
        "25000.00 USD",
        "Today's P/L",
        "Total P/L",
        "Asset allocation",
        // The ring's own heading and the Holdings column head, both drawn as
        // terminal small-caps.
        "ALLOCATION",
        "Apple",
        "100.0%",
        "+30.00 USD",
        "+80.00 USD",
        "LAST / COST",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected}:\n{rendered}"
        );
    }
    // Portfolio figures are monospaced because the window is, set once at the
    // application root -- which this probe renders the page without. So what
    // it proves is that no figure here overrides that family; the root's own
    // half is asserted in `a_bound_chord_reaches_the_action_that_switches_page`.
    assert!(
        !rendered.contains(".font_family["),
        "a figure must inherit the root's family, not restate one:\n{rendered}"
    );
    assert!(rendered.contains("Table \"allocation-USD\""), "{rendered}");
    assert!(rendered.contains("path fill"), "{rendered}");

    // The page itself does not scroll. Holdings takes the leftover height and
    // scrolls inside its own virtualized list, so the window never grows a
    // scrollbar around the whole column -- and a page that scrolled would put a
    // second scroll outside the table's, which is how Holdings used to end up
    // unreachable.
    assert_eq!(
        rendered.matches(":overflow_y_scroll[]").count(),
        0,
        "the portfolio page must not scroll as a whole:\n{rendered}"
    );
    assert!(
        !rendered.contains(":overflow_y_scrollbar"),
        "no panel scrolls inside the page scroll:\n{rendered}"
    );
    // The explanatory Popover beside the chart, distinct from the Watchlist menu.
    assert!(
        rendered.contains("Popover \"allocation-help\""),
        "{rendered}"
    );
    assert!(rendered.contains("allocation-help-trigger"), "{rendered}");

    // Holdings virtualizes too, so its rows are built during layout and are not
    // in this tree — `watchlist_ui.test.js` covers what one row draws. What is
    // here is the table around them, announcing a size the body never renders.
    assert!(
        rendered.contains("Table \"holdings-table\"")
            && rendered.contains(":row_count[Number(2.0)]"),
        "holdings must be a table that announces its full size:\n{rendered}"
    );
    assert!(
        rendered.contains("v_virtual_list \"holdings-rows\" \u{00d7}1"),
        "{rendered}"
    );
    assert!(!rendered.contains("+4.44%"), "{rendered}");

    // And a filter for it.
    assert!(rendered.contains("Input"), "{rendered}");
}

struct Empty;

impl gpui_kit::Render for Empty {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        gpui_kit::div()
    }
}

struct WorkspaceRoot(gpui_kit::Entity<gpui_shell::ShellRoot>);

impl gpui_kit::Render for WorkspaceRoot {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        self.0.clone().into_any_element()
    }
}

#[gpui_kit::test]
fn stock_details_lead_with_the_price_and_fold_their_secondary_readings(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("detail_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(520.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // Each reading is its own responsive panel. Quote is always expanded and
    // the redundant subtitle is gone.
    assert!(
        rendered.contains("quote-details-panel")
            && rendered.contains("chart-panel")
            && rendered.contains("market-detail-panel"),
        "{rendered}"
    );
    assert!(
        !rendered.contains("detail-quote-trigger") && !rendered.contains("Real-time quote"),
        "Quote Details must be permanently expanded without duplicated copy:\n{rendered}"
    );

    // The identity and the price are one row, and the price is the largest
    // figure in the pane, set against its right edge.
    let heading = rendered
        .split_once(r#":id[Str("quote-detail-heading")]"#)
        .and_then(|(_, section)| {
            section
                .split_once(r#":id[Str("quote-detail-stats")]"#)
                .map(|(section, _)| section)
        })
        .expect("quote heading");
    assert!(
        heading.contains("Apple Inc.")
            && heading.contains("US · AAPL.US · USD")
            // The display step of the shared type scale: the largest figure
            // the pane draws, and the only one that leaves body sizes behind.
            && heading.contains(".text_size[Number(24.0)]")
            && heading.contains("+3.00 · +1.62%"),
        "the quote heading carries the instrument and its price:\n{heading}"
    );

    // The session figures are a wrapping grid of label-over-value readings, so
    // a 320px pane shows two columns of them and a wider one shows more.
    let stats = rendered
        .split_once(r#":id[Str("quote-detail-stats")]"#)
        .and_then(|(_, section)| section.split_once("Accordion").map(|(section, _)| section))
        .expect("quote stat grid");
    assert!(
        stats.contains(".flex_wrap") && stats.contains(".flex_basis[Number(104.0)]"),
        "{stats}"
    );
    for reading in [
        "Previous close",
        "Open",
        "High",
        "Low",
        "Volume",
        "Turnover",
    ] {
        assert!(
            stats.contains(reading),
            "missing {reading} reading:\n{stats}"
        );
    }

    // Everything a reader consults rather than watches is behind one
    // disclosure, closed by default, and the pane never repeats a reading it
    // already shows: the session is on the trigger row, not in the panel.
    let more = rendered
        .split_once(r#"AccordionTrigger "quote-detail-more-trigger""#)
        .map(|(_, section)| section)
        .expect("quote disclosure");
    assert!(
        rendered.contains("AccordionItem :open[Bool(false)]") && more.contains("More detail"),
        "{rendered}"
    );
    for reading in [
        "Day range",
        "Amplitude",
        "Average price",
        "From open",
        "Last market update",
        "Data health",
        "Stream sequence",
    ] {
        assert!(more.contains(reading), "missing {reading} reading:\n{more}");
    }
    assert_eq!(
        rendered.matches("Trading").count(),
        1,
        "the session reads once, on the disclosure it summarizes:\n{rendered}"
    );

    // The chart is permanent content, not a disclosure with a title row.
    assert!(!rendered.contains("detail-chart-trigger"), "{rendered}");
    assert!(!rendered.contains("text \"Price chart\""), "{rendered}");
    assert!(rendered.contains("price-chart-wheel"), "{rendered}");
    assert!(
        !rendered.contains("chart-mode-selector"),
        "the selector belongs to the Chart Panel TitleBar, not its content:\n{rendered}"
    );
    assert!(!rendered.contains("About this instrument"), "{rendered}");

    // Date picking chrome is intentionally absent; the bottom axis and hover
    // tooltip carry the chart's time references instead.
    assert!(!rendered.contains("chart-calendar-surface"), "{rendered}");
    assert!(
        rendered.contains("div :id[Str(\"price-chart-wheel\")]")
            && rendered.contains(":on_scroll_wheel(fn)"),
        "{rendered}"
    );
    // A new interval or a new instrument replaces every point at once, so the
    // plot fades between them rather than switching: held back while the
    // request is out, brought up when it lands, on the one curve.
    let plot = rendered
        .split_once("div :id[Str(\"price-chart-wheel\")]")
        .map(|(_, section)| section.lines().next().unwrap_or_default())
        .expect("the plot");
    assert!(
        plot.contains(".opacity[Number(1.0)]")
            && plot.contains(":transition(opacity, 150ms, 0ms, ease-out)"),
        "a settled plot is drawn at full strength, and animates:\n{plot}"
    );

    // The retained chart child is still a child, and still not rebuilt here.
    assert!(rendered.contains("child_view #"), "{rendered}");

    // Market Detail owns the one tape/order-book scroll and follows Chart.
    // These assertions are intentionally written before the panel exists: the
    // fixture contains two levels and 21 trades, so a correct UI must reverse
    // asks, retain the best prices beside the ratio, and cap the rendered
    // tape at 20 rows.
    assert!(rendered.contains("Order Book"), "{rendered}");
    assert!(rendered.contains("Time & Sales"), "{rendered}");
    assert!(
        rendered.find("Order Book") > rendered.find("child_view #"),
        "{rendered}"
    );
    assert!(
        rendered.find("Time & Sales") > rendered.find("Order Book"),
        "{rendered}"
    );
    assert!(
        rendered.contains("188.20") && rendered.contains("188.10"),
        "{rendered}"
    );
    assert!(
        rendered.contains("Bid 59%") && rendered.contains("Ask 41%"),
        "{rendered}"
    );
    assert!(
        rendered.contains("↑") && rendered.contains("↓") && rendered.contains("•"),
        "{rendered}"
    );
    let first_trade = rendered
        .split_once(r#"time-sales-row-1700000000|188.00|100|T|0|0"#)
        .map(|(_, row)| row)
        .expect("first time-and-sales row");
    assert!(
        first_trade.contains("• Neutral"),
        "Longbridge direction 0 must be neutral:\n{first_trade}"
    );
    let down_trade = rendered
        .split_once(r#"time-sales-row-1699999999|188.01|200|T|1|0"#)
        .map(|(_, row)| row)
        .expect("down time-and-sales row");
    assert!(
        down_trade.contains("↓ Down"),
        "Longbridge direction 1 must be down:\n{down_trade}"
    );
    let up_trade = rendered
        .split_once(r#"time-sales-row-1699999998|188.02|300|T|2|0"#)
        .map(|(_, row)| row)
        .expect("up time-and-sales row");
    assert!(
        up_trade.contains("↑ Up"),
        "Longbridge direction 2 must be up:\n{up_trade}"
    );
    for trade in [first_trade, down_trade, up_trade] {
        assert!(
            trade.contains(".bg[") && trade.contains(".opacity[Number("),
            "each textual direction must also have a semantic, intensity-scaled volume marker:\n{trade}"
        );
    }
    assert!(
        rendered.contains("17:13:20"),
        "Time & Sales must show selected market-local time, not UTC/browser local time:\n{rendered}"
    );
    assert_eq!(
        rendered.matches("time-sales-row-").count(),
        20,
        "{rendered}"
    );
    // One scroll owns the whole detail column. Quote Details, Chart and Market
    // Detail expand inside it rather than nesting competing scroll regions.
    assert_eq!(
        rendered.matches(":overflow_y_scrollbar").count(),
        0,
        "{rendered}"
    );
    assert!(
        !rendered.contains(":overflow_x_scroll"),
        "Chart interval controls must use the compact menu before they need horizontal scrolling:\n{rendered}"
    );
    assert!(
        rendered.contains("order-book-ask-level-1")
            && rendered.contains("order-book-bid-level-1")
            && rendered.contains("time-sales-row-")
            && rendered.contains(".truncate"),
        "market-detail rows keep domain identities and shrink instead of overlapping:\n{rendered}"
    );
    assert!(
        !rendered.contains("order-book-ask-slot") && !rendered.contains("order-book-bid-slot"),
        "missing depth must not reserve placeholder rows:\n{rendered}"
    );
    let order_book = rendered
        .split_once(r#":id[Str("order-book-panel")]"#)
        .and_then(|(_, section)| {
            section
                .split_once(r#":id[Str("time-sales-panel")]"#)
                .map(|(section, _)| section)
        })
        .expect("order-book section");
    assert!(
        !order_book.contains(".border[") && !order_book.contains(".rounded["),
        "detail sections must use hairlines inside the one detail panel, not nested cards:\n{order_book}"
    );
}

#[gpui_kit::test]
fn market_detail_panels_name_loading_empty_and_error_states(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("detail_ui_states.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(360.), gpui_kit::px(480.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    for expected in [
        "Loading live market data…",
        "Depth entitlement unavailable",
        "No recent trades",
        "Trade feed unavailable",
        "Loading",
        "Empty",
        "Error",
        "2 trades",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected}:\n{rendered}"
        );
    }
    assert!(
        !rendered.contains("No order book data")
            && !rendered.contains("order-book-ask-level-1")
            && !rendered.contains("order-book-bid-level-1"),
        "a ready book without valid price/volume levels should collapse instead of drawing fake rows or explanatory filler:\n{rendered}"
    );
}

#[gpui_kit::test]
fn sparse_order_book_keeps_best_levels_next_to_the_spread(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("detail_ui_sparse.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(360.), gpui_kit::px(300.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    assert!(rendered.contains("order-book-ask-level-1"), "{rendered}");
    assert!(rendered.contains("order-book-bid-level-1"), "{rendered}");
    assert!(!rendered.contains("order-book-ask-slot"), "{rendered}");
    for row in ["order-book-ask-level-1", "order-book-bid-level-1"] {
        let row = rendered
            .split_once(row)
            .map(|(_, row)| row.split("h_flex :id").next().unwrap_or(row))
            .expect("depth row");
        for lane in [r#".w[Str("28%")]"#, r#".w[Str("36%")]"#] {
            assert!(
                row.contains(lane),
                "Ask and Bid must share the same level/price/volume lanes:\n{row}"
            );
        }
        assert!(row.contains(r#".h[Number(22.0)]"#), "{row}");
    }
    let divider = rendered
        .split_once(r#"order-book-ratio-divider"#)
        .and_then(|(_, divider)| {
            divider
                .split_once("order-book-bid-level-1")
                .map(|(divider, _)| divider)
        })
        .expect("single ratio divider");
    assert!(
        divider.contains(r#".h[Number(22.0)]"#)
            && divider.matches(r#".w[Str("28%")]"#).count() == 2
            && divider.contains("Bid 46%")
            && divider.contains("Ask 54%"),
        "ratio labels and bar must share one symmetric compact row:\n{divider}"
    );
    assert!(
        rendered.find("140.30") < rendered.find("Bid 46%")
            && rendered.find("Bid 46%") < rendered.find("140.20"),
        "Ask 1 must hug the divider above and Bid 1 below it:\n{rendered}"
    );
}

#[gpui_kit::test]
fn holdings_scroll_as_one_virtualized_collection_without_pagination(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("holdings_pager.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(900.), gpui_kit::px(900.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    assert!(!rendered.contains("Pagination"), "{rendered}");
    assert!(
        rendered.contains("v_virtual_list \"holdings-rows\" \u{00d7}80"),
        "the table must own all holdings in one virtualized collection:\n{rendered}"
    );
}

#[gpui_kit::test]
fn a_bound_chord_reaches_the_action_that_switches_page(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            assert_eq!(
                view.read(cx).build_error(),
                None,
                "workspace must build before checking its actions"
            );
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };

    let before = tree(&mut context);
    assert!(
        before.contains("div :id[Str(\"workspace-root\")] :key_context[Str(\"Workspace\")]"),
        "the root must declare the context the keymap is written against:\n{before}"
    );

    assert!(
        !before.contains(".font_family["),
        "the application must inherit the platform font without an override:\n{before}"
    );

    context.simulate_keystrokes(&format!("{PRIMARY_MODIFIER}-k"));
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let shortcuts = tree(&mut context);
    assert!(
        shortcuts.contains(r#":id[Str("keyboard-shortcuts-overlay")]"#)
            && shortcuts.contains(r#":key_context[Str("ShortcutHelp")]"#)
            && shortcuts.contains(":track_focus[")
            && shortcuts.contains("Keyboard shortcuts")
            && shortcuts.contains(&format!("{PRIMARY_MODIFIER_LABEL} + K"))
            && shortcuts.contains("Arrow Up / K")
            && shortcuts.contains("Home / G G")
            && !shortcuts.contains("Shift + F10"),
        "ctrl-k must open help generated from the application keymap:\n{shortcuts}"
    );

    context.simulate_keystrokes("escape");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    assert!(
        !tree(&mut context).contains(r#":id[Str("keyboard-shortcuts-overlay")]"#),
        "escape must close keyboard help"
    );

    context.simulate_keystrokes(&format!("{PRIMARY_MODIFIER}-2"));
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let after = tree(&mut context);
    assert!(
        after.contains("workspace-page"),
        "ctrl-2 must reach `workspace::portfolio`:\n{after}"
    );
    // A chord the keymap claims becomes an action and is not also delivered as
    // a key press, so the footer's readout stays empty for it. An unbound one
    // reaches `on_key_down`, and arrives already unparsed as the whole chord —
    // spelled `cmd` on every platform, this one included.
    assert!(
        !after.contains(&format!("text \"{PRIMARY_MODIFIER}-2\"")),
        "{after}"
    );

    context.simulate_keystrokes("end enter");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let holding_opened = tree(&mut context);
    assert!(
        holding_opened.contains("watchlist-pane") && holding_opened.contains("Microsoft Corp."),
        "Holdings must support last-row selection and keyboard activation:\n{holding_opened}"
    );

    context.simulate_keystrokes(&format!("{PRIMARY_MODIFIER}-3"));
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let orders = tree(&mut context);
    assert!(
        orders.contains("Today Orders") && orders.contains("History Orders"),
        "ctrl-3 must reach `workspace::orders`:\n{orders}"
    );

    context.simulate_keystrokes("enter");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let no_order_selected = tree(&mut context);
    assert!(
        !no_order_selected.contains(r#":id[Str("order-detail-panel")]"#),
        "Enter must not open an Orders row before one is selected:\n{no_order_selected}"
    );

    context.simulate_keystrokes("down");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let selected_order = tree(&mut context);
    assert!(
        !selected_order.contains(r#":id[Str("order-detail-panel")]"#),
        "moving through Orders must select without opening detail:\n{selected_order}"
    );

    context.simulate_keystrokes("o");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let opened_order = tree(&mut context);
    assert!(
        opened_order.contains(r#":id[Str("order-detail-panel")]"#)
            && opened_order.contains("884955210000"),
        "O must open the selected Orders row like Enter:\n{opened_order}"
    );

    context.simulate_keystrokes("ctrl-alt-y");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let typed = tree(&mut context);
    // The chord still arrives as the whole unparsed `ctrl-alt-y`; what changed
    // is how it is *written* for a reader. Modifiers in a fixed order, a space
    // either side of every `+`, one name per key — the same grammar the footer's
    // shortcut rail uses, because a chord that just happened and a chord that is
    // available are the same kind of thing said in the same kind of cap.
    assert!(
        typed.contains("text \"Ctrl + Alt + Y\""),
        "an unbound chord must reach on_key_down:\n{typed}"
    );

    context.simulate_keystrokes(&format!("{PRIMARY_MODIFIER}-1"));
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let back = tree(&mut context);
    assert!(
        back.contains("watchlist-pane"),
        "ctrl-1 must reach `workspace::watchlist`:\n{back}"
    );

    context.simulate_keystrokes("home");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let next = tree(&mut context);
    assert!(
        next.contains("US · MSFT.US · USD"),
        "Home must select without opening the first Watchlist row:\n{next}"
    );

    context.simulate_keystrokes("enter");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let next_opened = tree(&mut context);
    assert!(
        next_opened.contains("US · AAPL.US · USD"),
        "Enter must open the selected Watchlist row:\n{next_opened}"
    );

    context.simulate_keystrokes("k");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let previous = tree(&mut context);
    assert!(
        previous.contains("Apple Inc.") && previous.contains("text \"188.00\""),
        "k must move to the previous visible Watchlist row:\n{previous}"
    );

    context.simulate_keystrokes("end home");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let first = tree(&mut context);
    assert!(
        first.contains("Apple Inc.") && first.contains("text \"188.00\""),
        "home must move to the first visible row:\n{first}"
    );
}

#[gpui_kit::test]
fn modifier_hold_reveals_workspace_tab_shortcuts_until_release(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };

    let before = tree(&mut context);
    assert!(!before.contains("page-watchlist-shortcut"), "{before}");

    context.simulate_modifiers_change(primary_modifiers());
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let held = tree(&mut context);
    for (page, number) in [("watchlist", "1"), ("portfolio", "2"), ("orders", "3")] {
        assert!(
            held.contains(&format!("page-{page}-shortcut"))
                && held.contains(&format!("text \"{number}\"")),
            "holding the platform modifier must reveal {number} on {page}:\n{held}"
        );
    }

    context.simulate_modifiers_change(gpui_kit::Modifiers::default());
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let released = tree(&mut context);
    assert!(!released.contains("page-watchlist-shortcut"), "{released}");
    assert!(!released.contains("page-portfolio-shortcut"), "{released}");
    assert!(!released.contains("page-orders-shortcut"), "{released}");
}

#[gpui_kit::test]
fn tab_reaches_the_watchlist_filter_and_text_editing_stays_in_the_input(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keyboard_navigation_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keyboard navigation probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });

    // Walk one complete focus cycle until real text insertion identifies the
    // Watchlist filter without relying on a private focus-handle ID.
    let mut reached_filter = false;
    for _ in 0..24 {
        context.simulate_keystrokes("tab");
        context.simulate_input("z");
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
        let rendered = context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        });
        if rendered.contains("No matches") {
            reached_filter = true;
            break;
        }
    }
    assert!(reached_filter, "Tab must reach the Watchlist filter");

    // Clear the filter while keeping its editor focused. K would then select
    // Apple if the workspace binding leaked through the focused Input.
    context.simulate_keystrokes("ctrl-a backspace");
    context.simulate_keystrokes("k");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("Microsoft Corp.") && rendered.contains("text \"420.00\""),
        "K in the focused Watchlist filter must not move the selected row:\n{rendered}"
    );
}

#[gpui_kit::test]
fn keyboard_selection_scrolls_a_virtualized_row_into_view(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keyboard_scroll_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keyboard scroll probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });

    context.simulate_keystrokes("end");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(130.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("US · KEY18.US · USD"),
        "End must scroll to the bottom before the next visible-row hit test:\n{rendered}"
    );

    context.simulate_keystrokes("home");
    for _ in 0..25 {
        context.simulate_keystrokes("down");
    }
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(130.)),
        gpui_kit::Modifiers::default(),
    );
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });
    assert!(
        rendered.contains("US · KEY04.US · USD"),
        "repeated Down must minimally scroll the target into view rather than centering it:\n{rendered}"
    );
}

#[gpui_kit::test]
fn the_window_readout_follows_the_window_it_is_measuring(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    // A resize is not an invalidation — a script view renders when it is
    // notified, and the runtime reports no resize event — so each measurement
    // is taken on the first render after one. An unbound chord is the cheapest
    // notification there is: it reaches `on_key_down` and nothing else.
    let redraw = |context: &mut VisualTestContext, width: f32, chord: &str| {
        context.simulate_resize(gpui_kit::size(gpui_kit::px(width), gpui_kit::px(800.)));
        context.run_until_parked();
        context.simulate_keystrokes(chord);
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
        context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };

    // Where the panes sit is the dock's business now, and the user's. What is
    // still this view's is the readout: it measures the window on every render,
    // and a resize is not an invalidation, so the value has to follow the
    // notification rather than the resize.
    let wide = redraw(&mut context, 1400., "ctrl-alt-y");
    assert!(wide.contains("1400\u{d7}800"), "{wide}");
    assert!(!wide.contains("narrow"), "{wide}");

    let narrow = redraw(&mut context, 700., "ctrl-alt-u");
    let appearance = context.update(|_, cx| match gpui_kit::base::Theme::global(cx).appearance {
        gpui_kit::base::ThemeAppearance::Light => "light",
        gpui_kit::base::ThemeAppearance::Dark => "dark",
    });
    assert!(
        narrow.contains(&format!(
            "700\u{d7}800 \u{b7} 16px/rem \u{b7} {appearance} \u{b7} background \u{b7} narrow"
        )),
        "the readout must follow the window:\n{narrow}"
    );
}

#[gpui_kit::test]
fn escape_puts_away_what_the_workspace_opened_and_then_carries_on(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };

    let opened = tree(&mut context);
    assert!(!opened.contains("chart-calendar-surface"), "{opened}");
    // Every avatar in the application is a fallback: it knows no faces, and
    // the product mark is already in the header rather than in a circle.
    // `avatar_slots.test.js` is where the image slot is checked.
    assert!(opened.contains("AvatarFallback"), "{opened}");
    assert!(!opened.contains("AvatarImage"), "{opened}");

    context.simulate_keystrokes("escape");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let dismissed = tree(&mut context);
    assert!(
        !dismissed.contains("chart-calendar-surface"),
        "escape must put the picker away:\n{dismissed}"
    );

    // With nothing left to dismiss the workspace hands the action back with
    // `cx.propagate()`, so a second press is a no-op rather than an error.
    context.simulate_keystrokes("escape");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let again = tree(&mut context);
    assert!(again.contains("workspace-root"), "{again}");
    assert!(!again.contains("chart-calendar-surface"), "{again}");
}

#[gpui_kit::test]
fn a_right_press_on_a_watchlist_row_opens_a_menu_for_that_row_and_leaves_the_selection(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let render = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };
    // A press, not a click: a context menu opens on the press, and the list
    // reports which row it landed on through `on_item_secondary_click`.
    let press = |context: &mut VisualTestContext, y: f32| {
        context.simulate_mouse_move(
            gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(y)),
            gpui_kit::MouseButton::Right,
            gpui_kit::Modifiers::default(),
        );
        context.simulate_mouse_down(
            gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(y)),
            gpui_kit::MouseButton::Right,
            gpui_kit::Modifiers::default(),
        );
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
    };

    // AAPL is selected; MSFT is the other row. Walk down the pane until a
    // press lands on MSFT -- the rows' exact y depends on the chrome above
    // them, which is not what this test is about.
    let mut found = None;
    let mut y = 90.;
    while y < 600. && found.is_none() {
        press(&mut context, y);
        let rendered = render(&mut context);
        if rendered.contains(r#"Button "row-menu-copy""#) && rendered.contains("text \"MSFT.US\"") {
            found = Some(rendered);
        }
        y += 11.;
    }
    let rendered = found.expect("a right press on the MSFT row must open a menu naming MSFT");

    // The menu is for the row that was pressed, and offers what the Watchlist
    // offers.
    assert!(
        rendered.contains(r#"Button "row-menu-copy""#)
            && rendered.contains(r#"Button "row-menu-drop""#)
            && rendered.contains("Copy symbol")
            && rendered.contains("text \"Remove\""),
        "a right press must open the Watchlist menu for the pressed row:\n{rendered}"
    );
    assert!(
        rendered.contains(".absolute .left[Number(") && rendered.contains(":on_mouse_down_out(fn)"),
        "the menu is placed at the pointer and closes on a press outside it:\n{rendered}"
    );
    // Opening a menu on a row is not the same as looking at it: the details
    // still show AAPL, and the two rows are drawn apart -- the selected one as
    // a fill, the pressed one as a ring.
    let heading = rendered
        .split_once(r#":id[Str("quote-detail-heading")]"#)
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.split_once(r#":id[Str("quote-detail-stats")]"#))
        .map(|(heading, _)| heading)
        .expect("the quote details keep their heading");
    assert!(
        heading.contains("Apple Inc.") && !heading.contains("Microsoft"),
        "the selection must not move to the pressed row:\n{heading}"
    );
}

#[gpui_kit::test]
fn the_diagnostics_popover_answers_every_window_measurement(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(1120.), gpui_kit::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // Every read the window answers, taken as the popover draws -- all of them
    // legal from `render`, which is the half of the window API a script can
    // reach from there.
    for reading in [
        "Viewport",
        "Bounds",
        "Rem size",
        "Line height",
        "Pointer",
        "Appearance",
        "Active",
        "State",
    ] {
        assert!(
            rendered.contains(&format!("text \"{reading}\"")),
            "missing window reading {reading}:\n{rendered}"
        );
    }
    assert!(rendered.contains("text \"1920\u{d7}1080\""), "{rendered}");
    assert!(rendered.contains("text \"16px\""), "{rendered}");
    assert!(rendered.contains("text \"normal\""), "{rendered}");

    // And every change, on a button rather than in the pass that draws --
    // which is the other half, and refused from `render`.
    // The rem-size commands are the type scale's body, title and heading steps
    // now; 18 was not on it, and a control offering a size the interface never
    // draws in is offering one nothing was measured against.
    for command in [
        "12px",
        "14px",
        "16px",
        "Focus next",
        "Focus previous",
        "Bring to front",
        "Redraw window",
    ] {
        assert!(
            rendered
                .split("Button :label(registered)")
                .skip(1)
                .any(|button| {
                    button
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .contains(":on_click(fn)")
                        && button.contains(&format!("text \"{command}\""))
                }),
            "missing window command {command}:\n{rendered}"
        );
    }
}

#[gpui_kit::test]
fn a_dispatched_action_reaches_the_handler_a_chord_would(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("keymap_ui.test.js");
    let fixture_root = fixture.root.clone();
    let runtime_for_view = runtime.clone();
    let window = cx.add_window(move |window, cx| {
        WorkspaceRoot(
            runtime_for_view
                .try_load(&fixture_root, window, cx)
                .expect("load keymap probe"),
        )
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));

    let view = window
        .root(&mut context)
        .expect("workspace root")
        .read_with(&context, |root, cx| {
            root.0
                .read(cx)
                .content()
                .clone()
                .downcast::<gpui_shell::ScriptView>()
                .expect("workspace content is a script view")
        });
    let tree = |context: &mut VisualTestContext| {
        context.update(|_, cx| {
            view.read(cx)
                .snapshot()
                .map(gpui_shell::RenderSnapshot::debug_tree)
                .unwrap_or_default()
        })
    };

    let before = tree(&mut context);
    assert!(!before.contains("Restoring session"), "{before}");

    // The chord is bound to nothing. What carries it is the probe calling
    // `window.dispatch_action`, the way the session menu's Reconnect item does.
    context.simulate_keystrokes("ctrl-alt-d");
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
    let after = tree(&mut context);
    assert!(
        after.contains("Restoring session"),
        "a dispatched action must reach the same handler a chord would:\n{after}"
    );
}

#[gpui_kit::test]
fn an_avatar_draws_its_image_when_it_has_one_and_its_fallback_otherwise(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("avatar_slots.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(200.), gpui_kit::px(100.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    // The slot is chosen by the avatar, so both are described and only the
    // image is drawn where there is one.
    assert!(
        rendered.contains("AvatarImage \"assets/logo-light.svg\""),
        "the image slot must carry the application-relative path:\n{rendered}"
    );
    assert!(rendered.contains("AvatarFallback"), "{rendered}");
    assert!(
        rendered.contains("text \"LB\"") && rendered.contains("text \"US\""),
        "{rendered}"
    );
}

#[gpui_kit::test]
fn title_bar_draws_the_themed_official_svg_mark(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    grant_app_capabilities();
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let fixture = ApplicationFixture::new("title_bar_ui.test.js");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let (_root, view) = context.update(|window, cx| load_test_view(&runtime, &fixture, window, cx));
    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui_kit::Point::default(),
        gpui_kit::size(gpui_kit::px(640.), gpui_kit::px(48.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    assert!(
        [
            ("assets/logo-foreground.svg", "#f4f7ff"),
            ("assets/logo-info-cyan.svg", "#20d9ff"),
            ("assets/logo-warning.svg", "#f5c76d"),
            ("assets/logo-danger.svg", "#ff758f"),
        ]
        .iter()
        .all(|(asset, color)| {
            rendered.contains(&format!(
                "svg \"{asset}\" .absolute .inset_0 .text_color[Str(\"{color}\")]"
            ))
        }) && !rendered.contains(".absolute .left[Number(1.0)]"),
        "the title bar must layer the semantic official SVG marks rather than reconstructing bars:\n{rendered}"
    );
}
