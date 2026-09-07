// The one spacing, type and control scale the whole window is drawn on.
//
// Omarchy UI's components read their rhythm from `style()`, a singleton the
// host installs from the desktop's `theme/shell.toml`. This application also
// has a rhythm of its own -- a market terminal is denser than a settings
// window -- and if the two disagreed the gaps inside a Button would be on one
// scale and the gaps between Panels on another.
//
// So there is exactly one install, here, and it happens when this module is
// first imported rather than somewhere in `init`: every entry point in this
// directory draws through `ui.js`, and `ui.js` draws through this module, so a
// probe view that renders a single row lands on the same scale the application
// does.
//
// `TERMINAL_SHELL` is the fallback, not the intent. On an Omarchy desktop the
// host hands over the real `shell.toml` and the window follows the user's
// density, font size and rounding like every other window on that desktop.

import { platform } from "process";
import { applyOmarchyStyle, style as omarchyStyle } from "./gpui-omarchy/composition.js";

/**
 * This terminal's own rhythm, written in the format `shell.toml` uses so that
 * the desktop's file and this fallback go through one parser.
 *
 * The numbers are not new: they are the spacing scale `theme.json` already
 * carried, plus the row and panel insets the interface was already drawn with,
 * moved to where a component can read them.
 */
export const TERMINAL_SHELL = `
[font]
base-size = 12
# A column head is 11px here rather than the scale's 10: a market terminal
# reads its headings as often as its figures, and the step below body is far
# enough down without going two.
caption = 11

[spacing]
xxs = 2
xs = 4
sm = 8
md = 12
lg = 14
xl = 18
xxl = 24
row-gap = 8
row-padding-x = 8
label-gap = 4
panel-gap = 8
panel-padding = 12
popup-padding = 12
control-gap = 8
control-height = 28
control-padding-x = 8
`;


/**
 * Install the scale. Called once on import with the terminal's own rhythm, and
 * again by the application whenever the desktop's theme changes underneath it.
 *
 * The desktop's file layers *over* the terminal scale rather than replacing it.
 * An `||` here read as "the desktop knows better", but a stock `shell.toml`
 * ships with every `[spacing]` key commented out, so what it actually did was
 * throw the terminal's rhythm away and land on Omarchy UI's general-desktop
 * defaults: half the gaps this interface is drawn on (`sm` 8 -> 4, `md`
 * 12 -> 6, `lg` 14 -> 8) and half again too much room inside a row and a panel
 * (`row-padding-x` 8 -> 12, `panel-padding` 12 -> 18). Every spacing in the
 * window moved, in both directions at once.
 *
 * Parsing is last-key-wins, so appending the desktop's source keeps whatever
 * the user actually set -- which is the point of reading their theme at all --
 * while the terminal's density survives every key they left alone.
 *
 * @param {string} [shellSource] the desktop's `shell.toml`, when there is one
 * @param {{ fontFamily?: string }} [host]
 */
export function applyTerminalStyle(shellSource = "", host = {}) {
  return applyOmarchyStyle(`${TERMINAL_SHELL}\n${shellSource}`, {
    fontFamily: host.fontFamily,
    // The kit reserves the leading edge for the host's own window buttons, and
    // it can only do that if it is told whose host this is. Without it the
    // inset is zero and macOS draws its traffic lights over the mark.
    platform,
  });
}

applyTerminalStyle();

/** The live scale. Views ask this for a token instead of writing a pixel. */
export function style() {
  return omarchyStyle();
}
