use gpui_kit::{Entity, Render, TestAppContext, VisualTestContext};
use std::ops::Deref as _;

struct Host(Entity<gpui_shell::ScriptView>);

struct ProbeDirectory(std::path::PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn mount_probe(
    cx: &mut TestAppContext,
    name: &str,
    source: &str,
) -> (
    VisualTestContext,
    Entity<gpui_shell::ScriptView>,
    ProbeDirectory,
) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).unwrap();
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("longbridge-{name}-{}", std::process::id())),
    );
    std::fs::create_dir_all(&directory.0).unwrap();
    gpui_omarchy_shell::write_javascript(directory.0.join("gpui-omarchy")).unwrap();
    std::fs::write(directory.0.join("main.js"), source).unwrap();
    let loaded = runtime.load_application(&directory.0, "main.js").unwrap();
    let window = cx.add_window(move |window, cx| {
        Host(runtime.mount_application(&loaded, window, cx).unwrap())
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let view = window
        .root(&mut context)
        .unwrap()
        .read_with(&context, |host, _| host.0.clone());
    (context, view, directory)
}

fn draw_probe(context: &mut VisualTestContext) {
    context.run_until_parked();
    context.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui_kit::test]
fn native_choice_groups_commit_keyboard_selection_and_skip_disabled_items(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-choice",
        r#"
import { View, div } from "gpui-kit";
import { ButtonGroup, TabList, ChoiceItem } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() { this.values = ["a", "a"]; this.changes = []; }
  render() {
    return div().size_full().children([ButtonGroup, TabList].map((Group, index) =>
      new Group(`group-${index}`, this.values[index]).absolute().left(0).top(index * 80)
        .accessibility_label(`Choice ${index}`)
        .children([
          new ChoiceItem("a", "A"),
          new ChoiceItem("b", "B").disabled(true),
          new ChoiceItem("c", "C"),
        ])
        .on_change((value, cx) => { this.values[index] = value; this.changes.push(`${index}:${value}`); cx.notify(); })
    )).child(this.changes.join("|"));
  }
}
"#,
    );
    draw_probe(&mut context);
    for index in 0..2 {
        context.simulate_click(
            gpui_kit::point(gpui_kit::px(15.), gpui_kit::px(index as f32 * 80. + 15.)),
            Default::default(),
        );
        draw_probe(&mut context);
        context.simulate_keystrokes("right");
        draw_probe(&mut context);
        context.update(|_, cx| {
            let tree = view.read(cx).snapshot().unwrap().debug_tree();
            assert!(
                !tree.contains(&format!("{index}:c")),
                "arrows must not commit: {tree}"
            );
        });
        context.simulate_keystrokes("enter");
        draw_probe(&mut context);
        context.simulate_keystrokes("left enter");
        draw_probe(&mut context);
    }
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("0:c|0:a|1:c|1:a"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_calendar_selection_reaches_the_script_subscription(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-calendar",
        r#"
import { View, div } from "gpui-kit";
import { Calendar, CalendarState } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() {
    this.calendar = CalendarState.new();
    this.calendar.set_value("2026-01-15");
    this.picks = 0;
    this.calendar.on("change", (value, cx) => { this.picks++; this.chosen = value; cx.notify(); });
  }
  render() {
    return div().size_full().child(new Calendar(this.calendar).absolute().left(0).top(0))
      .child(`picked:${this.picks}:${this.chosen ?? "none"}`);
  }
}
"#,
    );
    draw_probe(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(100.)),
        Default::default(),
    );
    draw_probe(&mut context);
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("picked:1:"), "{tree}");
        assert!(!tree.contains("picked:1:none"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_slider_and_otp_edit_shared_state_and_honor_disabled(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-retained",
        r#"
import { View, div } from "gpui-kit";
import { Slider, SliderState, OtpInput, OtpState, Calendar, CalendarState } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() {
    this.level = SliderState.new({ min: 0, max: 100, step: 5, value: 50 });
    this.inert = SliderState.new({ min: 0, max: 100, value: 50 });
    this.code = OtpState.new(4); this.inertCode = OtpState.new(4);
    this.calendar = CalendarState.new();
    this.level.on("change", (_value, cx) => cx.notify());
    this.code.on("change", (_value, cx) => cx.notify());
  }
  render() {
    return div().size_full().children([
      new Slider(this.level).absolute().left(0).top(0).w(200),
      new Slider(this.inert).disabled(true).absolute().left(0).top(40).w(200),
      new OtpInput(this.code).absolute().left(0).top(90),
      new OtpInput(this.inertCode).disabled(true).absolute().left(0).top(140),
      new Calendar(this.calendar).absolute().left(250).top(0),
      `${this.level.value()}|${this.inert.value()}|${this.code.value()}|${this.inertCode.value()}`,
    ]);
  }
}
"#,
    );
    draw_probe(&mut context);
    // The initial thumb sits halfway along the 200px control.
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(14.)),
        Default::default(),
    );
    draw_probe(&mut context);
    context.simulate_keystrokes("right");
    draw_probe(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(170.), gpui_kit::px(54.)),
        Default::default(),
    );
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(15.), gpui_kit::px(105.)),
        Default::default(),
    );
    context.simulate_keystrokes("1 2 a 3 4 5");
    draw_probe(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(15.), gpui_kit::px(155.)),
        Default::default(),
    );
    context.simulate_keystrokes("9");
    draw_probe(&mut context);
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("55|50|1234|"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_editors_reuse_script_state_and_change_subscriptions(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-editors",
        r#"
import { View, div } from "gpui-kit";
import { Input, InputState, Textarea, TextareaState, NumberInput, Button } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() {
    this.input = InputState.new({ value: "seed" });
    this.area = TextareaState.new({ value: "notes", rows: 3 });
    this.number = InputState.new({ value: "3" });
    this.changes = 0;
    this.input.on("change", (_event, cx) => { this.changes++; cx.notify(); });
  }
  render() {
    return div().size_full().children([
      new Input(this.input).absolute().left(0).top(0).w(200).h(40),
      new Textarea(this.area).absolute().left(0).top(60).w(200).h(100),
      new NumberInput(this.number).absolute().left(0).top(180),
      new Button("replace").label("Replace").absolute().left(250).top(0).w(100).h(40)
        .on_click((_event, cx) => { this.input.set_value("updated"); this.area.set_value("new notes"); cx.notify(); }),
      `${this.input.value()}|${this.area.value()}|${this.number.value()}|${this.changes}`,
    ]);
  }
}
"#,
    );
    draw_probe(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(260.), gpui_kit::px(20.)),
        Default::default(),
    );
    draw_probe(&mut context);
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        // Programmatic assignment preserves the shell's non-emitting contract.
        assert!(tree.contains("updated|new notes|3|0"), "{tree}");
    });
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(30.), gpui_kit::px(20.)),
        Default::default(),
    );
    context.simulate_keystrokes("end");
    context.simulate_input("x");
    draw_probe(&mut context);
    context.update(|_, cx| {
        let tree = view.read(cx).snapshot().unwrap().debug_tree();
        assert!(tree.contains("updatedx|new notes|3|1"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_navigation_preserves_activation_and_focus_traversal(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-navigation",
        r#"
import { View } from "gpui-kit";
import { FocusScope, Button, Tabs, Tab, ToggleGroup, Toggle, Tooltip } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() { this.activations = []; this.selected = false; }
  render() {
    const activated = (name, cx) => { this.activations.push(name); cx.notify(); };
    return new FocusScope("scope").size_full().children([
      new Button("first").label("First").absolute().left(0).top(0).w(100).h(40)
        .on_click((_event, cx) => activated("first", cx)),
      new Button("second").label("Second").absolute().left(120).top(0).w(100).h(40)
        .on_click((_event, cx) => activated("second", cx)),
      new Tabs("tabs").absolute().left(0).top(60).children([
        new Tab("tab", "Tab", this.selected).w(100).h(40)
          .on_click((_event, cx) => { this.selected = true; activated("tab", cx); }),
        new Tab("disabled", "Disabled", false).disabled(true).w(100).h(40)
          .on_click((_event, cx) => activated("disabled", cx)),
      ]),
      new ToggleGroup("toggles").absolute().top(120).child(new Toggle("toggle", "Toggle", false)),
      new Tooltip("Native tooltip").absolute().top(180),
      `${this.selected}|${this.activations.join(",")}`,
    ]);
  }
}
"#,
    );
    draw_probe(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(20.)),
        Default::default(),
    );
    draw_probe(&mut context);
    for key in ["tab", "enter", "shift-tab", "enter"] {
        let keystroke = gpui_kit::Keystroke::parse(key).unwrap();
        context.simulate_event(gpui_kit::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        });
        context.simulate_event(gpui_kit::KeyUpEvent { keystroke });
        draw_probe(&mut context);
    }
    for x in [120., 10.] {
        context.simulate_click(
            gpui_kit::point(gpui_kit::px(x), gpui_kit::px(80.)),
            Default::default(),
        );
        draw_probe(&mut context);
    }
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("true|first,second,first,tab"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_controlled_inputs_report_state_and_ignore_disabled_activation(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-inputs",
        r#"
import { View, div } from "gpui-kit";
import { Checkbox, Switch, Radio, Toggle } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() { this.values = ["indeterminate", false, false, false]; this.changes = 0; this.disabledChanges = 0; }
  render() {
    const controls = [Checkbox, Switch, Radio, Toggle];
    return div().size_full().children(controls.flatMap((Control, i) => [
      new Control(`control-${i}`, `Control ${i}`, this.values[i])
        .absolute().left(0).top(i * 50).w(200).h(40)
        .on_change((value, cx) => { this.values[i] = value; this.changes++; cx.notify(); }),
      new Control(`disabled-${i}`, `Disabled ${i}`, this.values[i]).disabled(true)
        .absolute().left(250).top(i * 50).w(200).h(40)
        .on_change((_value, cx) => { this.disabledChanges++; cx.notify(); }),
    ])).child(`${this.values.join("|")}|${this.changes}|${this.disabledChanges}`);
  }
}
"#,
    );
    draw_probe(&mut context);
    for i in 0..4 {
        for x in [260., 10.] {
            context.simulate_click(
                gpui_kit::point(gpui_kit::px(x), gpui_kit::px(i as f32 * 50. + 20.)),
                Default::default(),
            );
            draw_probe(&mut context);
        }
    }
    // A full press/release is required: native controls activate on key up.
    let keystroke = gpui_kit::Keystroke::parse("space").unwrap();
    context.simulate_event(gpui_kit::KeyDownEvent {
        keystroke: keystroke.clone(),
        is_held: false,
        prefer_character_input: false,
    });
    context.simulate_event(gpui_kit::KeyUpEvent { keystroke });
    draw_probe(&mut context);
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("checked|true|true|false|5|0"), "{tree}");
    });
}

#[gpui_kit::test]
fn native_surfaces_compose_through_the_bundled_package(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-surfaces",
        r#"
import { View, div } from "gpui-kit";
import * as ui from "./gpui-omarchy/index.js";
export default class Probe extends View {
  render() {
    return div().flex().flex_col().size_full().children([
      new ui.Panel("Overview").child("panel-content"),
      new ui.Separator(), new ui.VerticalSeparator(), new ui.Keycap("Enter"),
      new ui.Avatar("JL"), new ui.Icon("check"),
      new ui.Markdown("markdown", "**Native Markdown**"), new ui.Html("html", "<b>Native HTML</b>"),
      new ui.Badge("Ready", "success"), new ui.EmptyState("No records", "Create a record"),
      new ui.Progress("progress", 42), new ui.Toast("notice").child("notification-content"),
      new ui.Table("table").child(new ui.TableRow("row", 1).children([
        new ui.TableHead("head", 1).child("header-content"),
        new ui.TableCell("cell", 2).child("cell-content"),
      ])),
      new ui.DialogBackdrop().relative().h(10),
      new ui.DialogPopup().children([
        new ui.DialogTitle("Decision"), new ui.DialogDescription("Review the record"),
      ]),
      new ui.SheetSurface().relative().h(40).child("sheet-content"),
      new ui.PopoverSurface().child("popover-content"),
      new ui.AccordionPanel().child("accordion-content"),
    ]);
  }
}
"#,
    );
    draw_probe(&mut context);
    context.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        for content in [
            "panel-content",
            "cell-content",
            "header-content",
            "notification-content",
            "sheet-content",
            "popover-content",
            "accordion-content",
        ] {
            assert_eq!(tree.matches(content).count(), 1, "{tree}");
        }
    });
}

#[gpui_kit::test]
fn native_table_rejects_zero_based_accessibility_indices(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-index",
        r#"
import { View } from "gpui-kit";
import { TableCell } from "./gpui-omarchy/index.js";
export default class Probe extends View { render() { return new TableCell("cell", 0); } }
"#,
    );
    draw_probe(&mut context);
    context.update(|_, cx| {
        let error = view
            .read(cx)
            .build_error()
            .expect("invalid index must fail before rendering");
        assert!(error.contains("one-based"), "{error}");
    });
}

#[gpui_kit::test]
fn native_images_reject_paths_outside_the_application_assets(cx: &mut TestAppContext) {
    let (mut context, view, _directory) = mount_probe(
        cx,
        "native-image-path",
        r#"
import { View } from "gpui-kit";
import { AvatarImage } from "./gpui-omarchy/index.js";
export default class Probe extends View { render() { return new AvatarImage("../outside.png"); } }
"#,
    );
    draw_probe(&mut context);
    context.update(|_, cx| {
        let error = view
            .read(cx)
            .build_error()
            .expect("asset traversal must fail before materialization");
        assert!(error.contains("application asset"), "{error}");
    });
}

impl Render for Host {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        self.0.clone()
    }
}

#[gpui_kit::test]
fn native_omarchy_buttons_activate_by_pointer_and_keyboard_and_respect_disabled(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_omarchy_shell::init);
    let runtime = cx.update(gpui_omarchy_shell::new_runtime).unwrap();
    let directory =
        std::env::temp_dir().join(format!("longbridge-native-button-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    gpui_omarchy_shell::write_javascript(directory.join("gpui-omarchy")).unwrap();
    std::fs::write(directory.join("main.js"), r#"
import { View, div } from "gpui-kit";
import { Button } from "./gpui-omarchy/index.js";
export default class Probe extends View {
  init() { this.hits = 0; }
  render() {
    return div().size_full()
      .child(new Button("enabled").label("Activate").absolute().left(0).top(0).w(200).h(40)
        .on_click((_event, cx) => { this.hits++; cx.notify(); }))
      .child(new Button("disabled").label("Unavailable").disabled(true).absolute().left(0).top(50).w(200).h(40)
        .on_click((_event, cx) => { this.hits += 100; cx.notify(); }))
      .child(`hits: ${this.hits}`);
  }
}
"#).unwrap();
    let loaded = runtime.load_application(&directory, "main.js").unwrap();
    let window = cx.add_window(move |window, cx| {
        Host(runtime.mount_application(&loaded, window, cx).unwrap())
    });
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let draw = |context: &mut VisualTestContext| {
        context.run_until_parked();
        context.update(|window, cx| window.draw(cx).clear(cx));
    };
    draw(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(20.)),
        Default::default(),
    );
    draw(&mut context);
    let keystroke = gpui_kit::Keystroke::parse("enter").unwrap();
    context.simulate_event(gpui_kit::KeyDownEvent {
        keystroke: keystroke.clone(),
        is_held: false,
        prefer_character_input: false,
    });
    context.simulate_event(gpui_kit::KeyUpEvent { keystroke });
    draw(&mut context);
    context.simulate_click(
        gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(70.)),
        Default::default(),
    );
    draw(&mut context);
    let host = window.root(&mut context).unwrap();
    host.read_with(&context, |host, cx| {
        let view = host.0.read(cx);
        assert_eq!(view.build_error(), None);
        let tree = view.snapshot().unwrap().debug_tree();
        assert!(tree.contains("hits: 2"), "{tree}");
    });
    std::fs::remove_dir_all(directory).unwrap();
}
