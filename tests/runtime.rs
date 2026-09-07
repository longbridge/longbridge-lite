use std::{
    ops::Deref as _,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use gpui_kit::{IntoElement as _, TestAppContext, VisualTestContext};

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app")
}

#[gpui_kit::test]
fn logged_out_application_loads_through_the_public_shell_runtime(cx: &mut TestAppContext) {
    cx.update(gpui_omarchy_shell::init);
    cx.update(|cx| {
        gpui_kit::base::Theme::global_mut(cx).appearance = gpui_kit::base::ThemeAppearance::Dark;
    });
    let root = app_dir();
    let manifest = gpui_shell::plugin::PluginManifest::read(&root).expect("plugin manifest");
    gpui_shell::set_capabilities(manifest.capabilities(&root, &std::env::temp_dir()));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    gpui_shell::set_storage_path(std::env::temp_dir().join(format!(
        "gpui-shell-longbridge-runtime-test-{}-{nonce}.json",
        std::process::id()
    )));

    let runtime = cx.update(gpui_omarchy_shell::new_runtime).expect("runtime");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let shell_root = context
        .update(|window, cx| runtime.try_load(&root, window, cx))
        .expect("load app through the public host facade");
    let view = context.update(|_, cx| {
        shell_root
            .read(cx)
            .content()
            .clone()
            .downcast::<gpui_shell::ScriptView>()
            .expect("loaded application content is a script view")
    });

    context.run_until_parked();
    context.update(|_, cx| {
        assert_eq!(
            gpui_kit::base::Theme::global(cx).appearance,
            gpui_kit::base::ThemeAppearance::Light,
            "without the native Omarchy reader, the isolated runtime uses its fallback palette"
        );
    });
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

    assert!(rendered.contains("Sign in to continue"), "{rendered}");
    assert!(
        rendered.contains("Button :label(registered) :primary(registered)"),
        "the sign-in card must offer the native Omarchy action:\n{rendered}"
    );
    context.update(|_, cx| assert_eq!(view.read(cx).build_error(), None));
    // The window draws its own title bar -- the host opens it without a system
    // one -- and that bar is where the window's identity lives. The card only
    // asks for the session; if the tagline ever reappears it has been put back
    // into content that should not be naming the window.
    assert!(
        rendered.contains("window-title-bar"),
        "the window has to draw its own title bar:\n{rendered}"
    );
    assert_eq!(
        rendered.matches("Read-only market terminal").count(),
        0,
        "{rendered}"
    );
    assert!(!rendered.contains("Stock detail"), "{rendered}");
    assert!(!rendered.contains("Holdings"), "{rendered}");
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
