use std::{path::PathBuf, rc::Rc, time::Duration};

use gpui_kit::{
    App, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowOptions, actions,
    point, px, size, transparent_black,
};
use gpui_shell::{AppAssets, HostModule, HostValue, plugin::PluginManifest};

const PLUGIN_ID: &str = "com.longbridge.desktop-lite";

/// How tall the application draws its own title bar, and where the macOS
/// traffic lights have to sit inside it.
///
/// The number lives here rather than only in the script because the window
/// options are the host's: AppKit places the lights before a single frame is
/// rendered, so the two have to agree by construction. `app/main.js` carries
/// the same constant, and a change to one is a change to both.
const TITLE_BAR_HEIGHT: f32 = 44.;

/// The lights are 14pt tall, so this centers them in the bar above.
const TRAFFIC_LIGHT_INSET: f32 = (TITLE_BAR_HEIGHT - 14.) / 2.;

actions!(
    longbridge,
    [
        /// Leaves the application.
        Quit
    ]
);

fn main() {
    let app_root = application_dir().unwrap_or_else(|error| {
        eprintln!("Longbridge Lite cannot find its application resources: {error}");
        std::process::exit(1);
    });
    if std::env::args_os().any(|argument| argument == "--check-resources") {
        println!("{}", app_root.display());
        return;
    }
    let assets = AppAssets::new(app_root.clone());

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    gpui_kit::application()
        .with_assets(assets)
        .run(move |cx| {
            gpui_omarchy_shell::init(cx);
            gpui_shell::set_bundle_id(PLUGIN_ID).expect("failed to configure application identity");
            // Keep the PluginManager-era location so an upgrade does not make
            // an existing OAuth session look as though it disappeared.
            let data_dir = plugin_data_dir().expect("failed to locate application storage");
            gpui_shell::set_storage_path(data_dir.join("store.json"));
            let manifest = PluginManifest::read(&app_root).expect("failed to read application manifest");
            gpui_shell::set_capabilities(manifest.capabilities(&app_root, &data_dir));
            install_omarchy_theme_reader().expect("failed to install Omarchy theme reader");
            install_quit(cx);
            // The seam between Watchlist and Stock details reads as a gap, not
            // as a line. The two panes are a dock's center and its right dock,
            // and base draws the divider between them from the `resizable`
            // theme -- the `border` color, the same one every panel edge uses --
            // which turned the eight pixels the panes give each other into a
            // rule down the middle of one panel. The script cannot reach it:
            // `set_theme` carries the semantic tokens and nothing else. So the
            // host projects it. `active_handle` stays unset, so a drag still
            // lights up in `ring` -- the one moment the divider is worth
            // seeing.
            gpui_kit::base::Theme::global_mut(cx).resizable.handle = Some(transparent_black());
            // The script's "Exit" asks; what the ask *means* is the host's to
            // decide, and here it means the same as Cmd-Q.
            gpui_shell::on_exit_request(|_request, _window, cx| cx.quit());
            // With the last window gone there is no interface left, and on
            // Linux and Windows no menu bar to quit from either.
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);

            let runtime = gpui_omarchy_shell::new_runtime(cx).expect("failed to start gpui-shell runtime");
            if std::env::var_os("LONGBRIDGE_PROFILE").is_some() {
                // What the shell's own counters cannot see.
                //
                // `script_render_time` and `materialize_time` below measure the
                // runtime's share of a frame; neither is the frame. A window
                // that draws in 8 ms holds 120 FPS and one that draws in 9 ms
                // does not, and the difference between those two lives mostly
                // in GPUI's layout and paint over the description rather than
                // in the runtime that produced it. So the frame itself is
                // reported here, against the 8.33 ms a 120 FPS budget allows.
                //
                // `invalidations` is the other half of the reading: it counts
                // how many notifies were coalesced into one drawn frame, so a
                // number well above one says the window is being asked to
                // redraw faster than it can, which no amount of frame budget
                // fixes.
                gpui_kit::set_trace_enabled(true);
                cx.spawn(async move |cx| {
                    let mut collector = gpui_kit::FrameTimingCollector::new();
                    loop {
                        cx.background_executor().timer(Duration::from_secs(1)).await;
                        let mut draws: Vec<f64> = Vec::new();
                        let mut invalidations: u64 = 0;
                        for event in collector.collect_unseen() {
                            if let gpui_kit::FrameEvent::Draw(timing) = event {
                                draws.push(timing.draw_duration().as_secs_f64() * 1000.0);
                                invalidations += timing.invalidations;
                            }
                        }
                        if draws.is_empty() {
                            eprintln!("frame-profile frames=0 (nothing drawn this second)");
                            continue;
                        }
                        draws.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        let n = draws.len();
                        let mean = draws.iter().sum::<f64>() / n as f64;
                        let p95 = draws[((n as f64 * 0.95) as usize).min(n - 1)];
                        let over = draws.iter().filter(|d| **d > 8.33).count();
                        eprintln!(
                            "frame-profile frames={n} mean_draw={mean:.2}ms median_draw={:.2}ms p95_draw={p95:.2}ms max_draw={:.2}ms over_8.33ms={over} inv_per_frame={:.2}",
                            draws[n / 2],
                            draws[n - 1],
                            invalidations as f64 / n as f64,
                        );
                    }
                })
                .detach();
                let measured = Rc::clone(&runtime);
                cx.spawn(async move |cx| {
                    let mut previous = measured.read_metrics();
                    loop {
                        cx.background_executor().timer(Duration::from_secs(1)).await;
                        let current = measured.read_metrics();
                        let interval = current.since(&previous);
                        previous = current;
                        eprintln!(
                            "shell-profile script={} mean_script={:.3}ms slowest_script={:.3}ms materialize={} mean_materialize={:.3}ms script_total={:.3}ms materialize_total={:.3}ms",
                            interval.script_renders(),
                            interval.mean_script_render().as_secs_f64() * 1_000.0,
                            interval.slowest_script_render().as_secs_f64() * 1_000.0,
                            interval.materializations(),
                            interval.mean_materialize().as_secs_f64() * 1_000.0,
                            interval.script_render_time().as_secs_f64() * 1_000.0,
                            interval.materialize_time().as_secs_f64() * 1_000.0,
                        );
                    }
                })
                .detach();
            }
            let runtime = Rc::clone(&runtime);
            cx.open_window(window_options(cx), move |window, cx| {
                let root = runtime.load(&app_root, window, cx);
                #[cfg(debug_assertions)]
                match runtime.watch(&root, window, cx) {
                    Ok(watcher) => watcher.forget(),
                    Err(error) => eprintln!("failed to watch application sources: {error:#}"),
                }
                root
            })
            .expect("failed to open Longbridge window");
        });
}

/// Exposes exactly two host-owned files instead of granting script code access
/// to the user's home directory. Omarchy atomically replaces them when a theme
/// changes, so every call resolves the current path again.
///
/// `colors.toml` is the palette; `shell.toml` is everything else a theme can
/// influence — the spacing scale, the type scale, and the alphas a control's
/// chrome is built from. Omarchy UI reads both, and a window that read only the
/// first would follow the desktop's colours while ignoring its density.
fn install_omarchy_theme_reader() -> Result<(), gpui_shell::HostError> {
    let theme_dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/state/omarchy/current/theme"));
    let colors = theme_dir.as_ref().map(|dir| dir.join("colors.toml"));
    let shell = theme_dir.as_ref().map(|dir| dir.join("shell.toml"));
    fn read(path: Option<&PathBuf>) -> String {
        path.and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default()
    }
    gpui_shell::export_module(
        HostModule::new("omarchy-theme")
            .declarations(concat!(
                "export function current_colors(): string;\n",
                "export function current_shell(): string;",
            ))
            .function("current_colors", move |_| {
                Ok(HostValue::from(read(colors.as_ref())))
            })
            .function("current_shell", move |_| {
                Ok(HostValue::from(read(shell.as_ref())))
            }),
    )
}

fn plugin_data_dir() -> Result<PathBuf, String> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local/share"))
        })
        .ok_or_else(|| "neither XDG_DATA_HOME nor HOME is set".to_owned())?;
    Ok(data_home.join("gpui-shell/plugins").join(PLUGIN_ID))
}

/// Finds the script application in an installed bundle or the source tree.
///
/// Release packages are relocatable: every candidate is derived from the
/// executable itself. The manifest-directory path is deliberately last and
/// exists only for `cargo run` from a checkout.
fn application_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("LONGBRIDGE_LITE_APP_DIR") {
        let path = PathBuf::from(path);
        return is_application_dir(&path)
            .then_some(path)
            .ok_or_else(|| "LONGBRIDGE_LITE_APP_DIR does not contain gpui-shell.json".to_owned());
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the executable: {error}"))?;
    let binary_dir = executable
        .parent()
        .ok_or_else(|| "the executable has no parent directory".to_owned())?;
    let bundle_root = binary_dir.parent().unwrap_or(binary_dir);
    let candidates = [
        bundle_root.join("Resources").join("app"),
        bundle_root.join("share").join("app"),
        bundle_root.join("app"),
        binary_dir.join("app"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app"),
    ];
    candidates
        .into_iter()
        .find(|path| is_application_dir(path))
        .ok_or_else(|| {
            format!(
                "no app/gpui-shell.json was found beside {} or in the development checkout",
                executable.display()
            )
        })
}

fn is_application_dir(path: &std::path::Path) -> bool {
    path.join("gpui-shell.json").is_file()
}

/// Loads the application and hands back the view to mount, or the reason not to.
fn window_options(cx: &gpui_kit::App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1120.), px(760.)),
            cx,
        ))),
        window_min_size: Some(size(px(720.), px(600.))),
        // No system title bar: the application draws its own, and the script
        // owns what is in it. `appears_transparent` keeps the AppKit title bar
        // in place but empty and see-through, so the window still drags from
        // the top strip and still gets its traffic lights -- which the script
        // cannot ask for, since it can neither move the window nor close it.
        // `app_owns_titlebar_drag` therefore stays false.
        titlebar: Some(TitlebarOptions {
            title: None,
            appears_transparent: true,
            traffic_light_position: Some(point(px(TRAFFIC_LIGHT_INSET), px(TRAFFIC_LIGHT_INSET))),
        }),
        ..Default::default()
    }
}

/// Wires Quit to the gesture each platform expects, and to the macOS app menu.
///
/// The binding comes first on both platforms, and on macOS the menu item is
/// built on top of it rather than instead of it: AppKit takes the accelerator
/// it shows next to a menu item from the bindings registered for that item's
/// action, so a menu with no binding behind it is a menu item with no Cmd-Q.
///
/// Both are dispatched globally, with no context, because leaving is not a
/// view's to own -- whichever pane holds the keyboard, the gesture means the
/// same thing.
fn install_quit(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    if cfg!(target_os = "macos") {
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.set_menus(vec![Menu {
            name: "Longbridge".into(),
            items: vec![MenuItem::action("Quit Longbridge", Quit)],
            disabled: false,
        }]);
    } else {
        cx.bind_keys([KeyBinding::new("alt-f4", Quit, None)]);
    }
}
