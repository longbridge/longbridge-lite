# Longbridge Lite — Special for Omarchy

Longbridge Lite is a market-reading Longbridge desktop client made especially for
[Omarchy](https://omarchy.org/). It follows Omarchy's current system theme,
uses the system font, and adopts Omarchy-native spacing and keyboard
conventions. It is also an architecture example showing how a JavaScript
application can run as a native GPUI desktop program through
[GPUI Shell](https://gpui-kit.com/shell/).

The active palette is read from Omarchy's materialized theme state at
`~/.local/state/omarchy/current/theme/colors.toml`, and the spacing, type and
control scales from `shell.toml` beside it. Switching the Omarchy theme updates
Longbridge Lite automatically; the application does not inspect
`/etc/os-release` or bundle its own font.

The interface uses [gpui-omarchy](https://github.com/huacnlee/gpui-omarchy).
The host registers its native component adapter, and the build script bundles
its JavaScript composition and theme helpers into `app/gpui-omarchy/`.
The application no longer fetches the separate Omarchy UI repository.

## Install

Install the latest macOS or Linux release without administrator privileges:

```sh
curl -fsSL https://github.com/longbridge/longbridge-lite/raw/refs/heads/main/install.sh | sh
```

On Linux the installer adds Longbridge Lite to the desktop application menu
and links `longbridge-lite` into `~/.local/bin`. It requires x86_64 glibc 2.35
or newer. On macOS it installs `Longbridge Lite.app` into `~/Applications` and
supports Apple Silicon. These builds are not signed with an Apple
Developer ID and are not notarized. If macOS blocks the first launch, explicitly
remove the downloaded-file quarantine attribute after installation:

```sh
xattr -dr com.apple.quarantine "$HOME/Applications/Longbridge Lite.app"
open "$HOME/Applications/Longbridge Lite.app"
```

Only run this for a package downloaded from the official
`longbridge/longbridge-lite` GitHub Releases page and verified by the installer.

On Windows x86_64, run in PowerShell:

```powershell
irm https://github.com/longbridge/longbridge-lite/raw/refs/heads/main/install.ps1 | iex
```

The PowerShell installer uses `%LOCALAPPDATA%\longbridge-lite`, creates a Start
Menu shortcut, and adds its `bin` directory to the user PATH. To select a
version or uninstall, invoke the downloaded script with `-Version 0.2.0` or
`-Uninstall`. Portable `.tar.gz` and `.zip` packages and `SHA256SUMS` are also
available on each GitHub Release.

- [Longbridge OpenAPI](https://open.longbridge.com/)
- [gpui-kit](https://github.com/longbridge/gpui-kit)

<img width="1232" height="872" alt="image" src="https://github.com/user-attachments/assets/2f79d6ac-0376-4321-afbf-807aca713a6f" />

<img width="1232" height="872" alt="image" src="https://github.com/user-attachments/assets/1d5ab110-e9a4-40a3-8fc3-89225a8cc398" />

<img width="1232" height="872" alt="image" src="https://github.com/user-attachments/assets/b34f0f78-08dd-4513-b017-f17858e26c19" />

<img width="1232" height="872" alt="image" src="https://github.com/user-attachments/assets/1949613e-8090-45c0-8aa0-be378401cfb9" />


## Architecture

```text
Rust host (`src/main.rs`)
├── initializes GPUI and gpui-shell
├── installs application palettes and filesystem assets
├── grants the plugin's capability policy
└── mounts the JavaScript view into a native GPUI window
                         │
                         ▼
gpui-shell runtime (`../gpui-kit/crates/shell`)
├── executes ES modules in QuickJS
├── records declarative element descriptions
├── materializes descriptions as native GPUI elements
├── owns native events, timers, storage, HTTP and WebSocket bridges
└── rebuilds the application snapshot during development hot reload
                         │
                         ▼
JavaScript application (`app/`)
├── OAuth and token lifecycle
├── Longbridge HTTP and WebSocket protocols
├── market and portfolio state, and the watchlist's own edits
└── theme-aware native UI composition
                         │
                         ▼
Longbridge OpenAPI
├── OAuth 2 device authorization and authenticated HTTP APIs
└── binary protobuf quote stream over WebSocket
```

### Host boundary

The Rust executable is deliberately small. It selects the application root,
configures assets, creates `ShellRuntime`, loads the
plugin, and opens `ShellRoot`. Native concerns stay in the host; product state
and rendering stay in JavaScript.

The host currently depends on the sibling [gpui-kit](https://github.com/longbridge/gpui-kit)
checkout, including the native-state adapter interface used by gpui-omarchy.
`gpui-shell` exposes a
constrained ES-module API — one module per crate that provides the capability,
so `"gpui-kit"` holds GPUI's own elements and what the runtime adds,
`"gpui-base"` holds base's layout helpers, components and theme, and
`"gpui-fps"` holds its performance overlay. The application never imports Rust implementation details.

### Render boundary

JavaScript `View.render()` does not directly retain native elements. It records
an immutable element description in QuickJS. Rust materializes that snapshot
into GPUI elements and can repaint it without re-entering the VM. State-changing
callbacks update the JavaScript view and explicitly notify the host to build a
new snapshot.

Theme values cross the same boundary as semantic tokens. Icon SVGs use the
theme-tinted mask path, while brand artwork uses the full-color image path.
Scrollbars and other behavior primitives read the palette projected into
`gpui_base`.

### Data boundary

The application talks directly to [Longbridge OpenAPI](https://open.longbridge.com/):

1. OAuth device authorization obtains and durably stores rotating tokens.
2. Authenticated HTTP loads Watchlist, account, holdings, and order snapshots,
   and is the one boundary that writes: a watchlist group's securities.
3. A WebSocket session authenticates with an OTP, subscribes to quote pushes,
   and requests the initial quote snapshot.
4. Partial protobuf pushes are folded onto the snapshot using sequence and
   timestamp ordering.
5. Market groups are ordered by session (`Trading`, then `Pre`, then other),
   followed by `US → HK → CN → SG`. Items inside each market retain their
   original Watchlist API order.

The plugin manifest grants only the required Longbridge network origins. No
process execution or trading mutation API is exposed to the JavaScript layer.

### Application modules

| Path                  | Responsibility                                             |
| --------------------- | ---------------------------------------------------------- |
| `src/main.rs`         | Native host, palette/assets, plugin mount, debug watcher   |
| `app/main.js`         | View lifecycle and composition                             |
| `app/auth.js`         | OAuth device flow and token rotation                       |
| `app/http.js`         | Authenticated HTTP boundary                                |
| `app/protocol.js`     | Binary frame and protobuf codecs                           |
| `app/quote_stream.js` | WebSocket lifecycle, heartbeat, snapshot and reconnect     |
| `app/market.js`       | Pure Watchlist normalization, quote reduction and ordering |
| `app/watchlist_edit.js` | Pure group selection and typed-symbol rules              |
| `app/orders.js`       | Pure order normalization, statuses and history window      |
| `app/ui.js`           | This terminal's presentation, composed from Omarchy UI      |
| `app/style.js`        | The one spacing, type and control scale the window is drawn on |
| `app/palette.js`      | The colors the semantic token set cannot carry: direction and feed health |

The application changes exactly one thing about an account: which securities it
watches. `PUT /v1/watchlist/groups` is the only write the HTTP boundary can
make — adding a typed symbol, and removing one from a row's context menu — and `app/http.js` refuses any other path or method. Orders reads
`/v1/trade/order/today` and `/v1/trade/order/history` and nothing else in the
trade API: there is no way to submit, change or withdraw an order.

### Script surface under exercise

The repository is a demonstration, so the second job of every screen is to put
a piece of the `gpui-shell` script API on it. Where a binding had no home in a
market terminal it is not used; where the terminal already had the problem the
binding solves, it is what solves it.

| Script API                                                   | Where it is on screen                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cx.bind_keys`, `key_context`, `on_action`                   | `KEY_BINDINGS` in `app/main.js`, answered on the workspace root                       |
| `window.dispatch_action`                                     | The session menu, so an item and a chord reach one handler                            |
| `on_key_down` / `on_key_up`, `KeyEvent`                      | The footer's key readout, filled while the chord is down                              |
| `on_mouse_down` / `on_mouse_up`                              | A right press over the Watchlist opens the selected instrument's menu                 |
| `on_mouse_down_out`                                          | Dismisses the chart's date picker, which is the script's own surface                  |
| `on_scroll_wheel`                                            | A wheel over the price chart walks its window a day at a time                         |
| `cx.stop_propagation` / `cx.propagate`                       | The copy stops at the pane; `escape` carries on when nothing is open                  |
| `Avatar` + `AvatarImage` / `AvatarFallback`                  | The session menu's mark, and the Watchlist rows' market badges                        |
| `Accordion` and its four parts, `aria_level`, `keep_mounted` | The readings Quote Details folds away until they are asked for                        |
| `Pagination`, `pagination_items`                             | The Holdings panel, eight positions to a page                                         |
| `CalendarState`                                              | The month behind the price chart's date picker                                        |
| `window.viewport_size`                                       | Stacks the two panes in a short window, which a resizable group cannot do by wrapping |
| Every other `Window` read and command                        | The diagnostics popover in the footer's right corner                                  |

Linux and Windows use `ctrl` for application commands; macOS uses the
corresponding `cmd` chords. `Super` remains available to Omarchy and the window
manager. Press `ctrl-k` (or `cmd-k`) to open the in-app shortcut reference.

| Chord                            | Action                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `ctrl-1` / `ctrl-2` / `ctrl-3`   | `workspace::watchlist` / `workspace::portfolio` / `workspace::orders` |
| `ctrl-k`              | Open keyboard shortcut help                                        |
| `ctrl-r`              | `workspace::reconnect`                                             |
| `ctrl-t`              | `workspace::toggle-theme`                                          |
| `ctrl-shift-f`        | `workspace::toggle-fullscreen`                                     |
| `up` / `k`            | Select the previous visible row                                    |
| `down` / `j`          | Select the next visible row                                        |
| `home` / `g g`        | Select the first visible row                                       |
| `end` / `shift-g`     | Select the last visible row                                        |
| `enter` / `o`         | Open the selected row's primary view                               |
| `escape`              | `workspace::dismiss`, handed back when there is nothing to dismiss |

Keyboard row navigation scrolls only as needed to reveal the selected virtualized item;
Home and End move the list to its corresponding boundary.

## Uninstall

Uninstall while preserving user data:

```sh
curl -fsSL https://github.com/longbridge/longbridge-lite/raw/refs/heads/main/install.sh | sh -s -- --uninstall
```

## Run

Keep checkouts of `gpui-omarchy` and `gpui-kit` beside this repository. Its `shell` crate
provides the host adapter; this application explicitly enables its `gpui-shell`
feature. Cargo generates `app/gpui-omarchy/` from that crate's bundled sources.

Register an OAuth public client once and set its fixed `CLIENT_ID` in
`app/auth.js`. A public client must not contain a client secret.

```sh
cargo run
```

In debug builds, changes under `app/` are reloaded into the existing window.
The runtime also refreshes the ignored `app/gpui.d.ts` declaration file from
the API it actually exposes.

## Verify

```sh
cargo test --locked
cargo build --locked --release
```

The tests execute application modules through the same QuickJS runtime used by
the desktop host. They cover protocol codecs, stream lifecycle, market-state
reduction, ordering invariants, capability policy, and native GPUI
materialization.

The keyboard-only acceptance probes are in `tests/app_vectors.rs`; run them on
their own with `cargo test --test app_vectors --locked`. They dispatch real
keystrokes through a GPUI window and cover shortcut help, page switching,
collection navigation and activation, row actions, Tab traversal, and text
input isolation.

The surfaces in the table above are covered behaviorally rather than by
inspection: a chord is delivered to a real window and the page changes, a right
press lands and the clipboard holds the symbol, the window is resized and the
panes stack, an action is dispatched and reaches the handler a chord would.
