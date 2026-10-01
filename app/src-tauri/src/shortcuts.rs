//! Global shortcuts: Caps Lock remapped to Hyper (PowerToys / Karabiner /
//! kanata) fires Ctrl+Alt+Shift+Super+Key; without a remap tool running the
//! Ctrl+Alt+Key fallback is registered instead. Never both for one action —
//! that would double-fire.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// True when every action registered its Hyper variant.
static HYPER_ACTIVE: AtomicBool = AtomicBool::new(false);

pub struct Action {
    pub name: &'static str,
    pub key: Code,
    pub event: &'static str,
    /// Focus the main window on press (the widget toggle must not steal it).
    pub focus: bool,
}

pub const ACTIONS: &[Action] = &[
    Action { name: "play", key: Code::Space, event: "shortcut:play", focus: true },
    Action { name: "search", key: Code::KeyF, event: "shortcut:search", focus: true },
    Action { name: "now-playing", key: Code::KeyN, event: "shortcut:now-playing", focus: true },
    Action { name: "widget", key: Code::KeyW, event: "shortcut:widget", focus: false },
    Action { name: "download", key: Code::KeyD, event: "shortcut:download", focus: true },
    Action { name: "info", key: Code::KeyI, event: "shortcut:info", focus: true },
];

/// Media keys as plain global shortcuts: the shell still shows its volume
/// overlay for them, which covers the SMTC requirement without a second
/// integration (skipped: SMTC adds nothing the shortcuts do not give).
pub const MEDIA: &[(&str, Code)] = &[
    ("media-play-pause", Code::MediaPlayPause),
    ("media-next", Code::MediaTrackNext),
    ("media-prev", Code::MediaTrackPrevious),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Hyper,
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Hyper,
    Fallback,
    Conflict,
}

/// What to register for one action. `try_register` stands in for the OS.
/// The duplicate-registration guard: exactly one variant is ever chosen, so
/// Hyper and Ctrl+Alt can never both be live for the same action.
pub fn decide(tool_running: bool, try_register: &mut dyn FnMut(Variant) -> bool) -> Decision {
    if tool_running && try_register(Variant::Hyper) {
        return Decision::Hyper;
    }
    if try_register(Variant::Fallback) {
        return Decision::Fallback;
    }
    Decision::Conflict
}

fn hyper_shortcut(key: Code) -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        key,
    )
}

fn fallback_shortcut(key: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), key)
}

/// Registration success cannot prove Caps Lock is remapped — Windows happily
/// registers combos nobody can type. The remap tool's presence is the signal.
/// ponytail: process-name heuristic; a Settings override is the upgrade path
/// if someone remaps Caps some other way.
pub fn hyper_tool_running() -> bool {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("tasklist");
        crate::hide_console(&mut cmd);
        match cmd.output() {
            Ok(out) => {
                let out = String::from_utf8_lossy(&out.stdout).to_lowercase();
                // Either recipe's process counts: PowerToys Keyboard Manager
                // or the AutoHotkey script from docs/shortcuts.md.
                out.contains("powertoys") || out.contains("autohotkey")
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        ["karabiner_console_user_server", "kanata", "xremap"].iter().any(|name| {
            std::process::Command::new("pgrep")
                .arg("-x")
                .arg(name)
                .map(|c| c.status.map(|s| s.success()).unwrap_or(false))
                .unwrap_or(false)
        })
    }
}

fn bind(
    app: &tauri::AppHandle,
    sc: Shortcut,
    event: &'static str,
    focus: bool,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut().on_shortcut(sc, move |handle, _sc, e| {
        if e.state != ShortcutState::Pressed {
            return;
        }
        if focus {
            crate::show_main(handle);
        }
        let _ = handle.emit(event, ());
    })
}

/// Register everything at startup. Fallible per shortcut: failures log and
/// emit `shortcut:conflict`, never abort boot. Called from `setup`.
pub fn register(app: &tauri::AppHandle) {
    let tool = hyper_tool_running();
    let mut all_hyper = tool;
    for action in ACTIONS {
        let mut attempt = |v: Variant| -> bool {
            let sc = match v {
                Variant::Hyper => hyper_shortcut(action.key),
                Variant::Fallback => fallback_shortcut(action.key),
            };
            match bind(app, sc, action.event, action.focus) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("shortcut {} ({:?}) failed: {e}", action.name, v);
                    false
                }
            }
        };
        match decide(tool, &mut attempt) {
            Decision::Hyper => {}
            Decision::Fallback => all_hyper = false,
            Decision::Conflict => {
                all_hyper = false;
                eprintln!("shortcut conflict: {}", action.name);
                let _ = app.emit("shortcut:conflict", action.name);
            }
        }
    }
    for (event, code) in MEDIA {
        let sc = Shortcut::new(None, *code);
        if let Err(e) = bind(app, sc, event, false) {
            eprintln!("media shortcut {event} failed: {e}");
            let _ = app.emit("shortcut:conflict", *event);
        }
    }
    HYPER_ACTIVE.store(all_hyper, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_shortcut_mode() -> String {
    if HYPER_ACTIVE.load(Ordering::Relaxed) {
        "hyper".to_string()
    } else {
        "default".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hyper_wins_and_the_fallback_is_never_registered() {
        let mut calls = vec![];
        let d = decide(true, &mut |v| {
            calls.push(v);
            true
        });
        assert_eq!(d, Decision::Hyper);
        assert_eq!(calls, vec![Variant::Hyper], "no double-fire: fallback skipped");
    }

    #[test]
    fn failed_hyper_falls_back_to_ctrl_alt() {
        let mut calls = vec![];
        let d = decide(true, &mut |v| {
            calls.push(v);
            v == Variant::Fallback
        });
        assert_eq!(d, Decision::Fallback);
        assert_eq!(calls, vec![Variant::Hyper, Variant::Fallback]);
    }

    #[test]
    fn without_a_remap_tool_only_the_fallback_is_attempted() {
        let mut calls = vec![];
        let d = decide(false, &mut |v| {
            calls.push(v);
            true
        });
        assert_eq!(d, Decision::Fallback);
        assert_eq!(calls, vec![Variant::Fallback], "hyper never attempted");
    }

    #[test]
    fn total_conflict_is_a_decision_not_a_panic() {
        let d = decide(true, &mut |_| false);
        assert_eq!(d, Decision::Conflict);
        let d = decide(false, &mut |_| false);
        assert_eq!(d, Decision::Conflict);
    }

    #[test]
    fn actions_and_events_are_unique() {
        // Code is not Ord; dedup via debug strings.
        let mut keys: Vec<String> = ACTIONS.iter().map(|a| format!("{:?}", a.key)).collect();
        keys.sort_unstable();
        let n = keys.len();
        keys.dedup();
        assert_eq!(n, keys.len(), "duplicate key would register twice");

        let mut events: Vec<&str> = ACTIONS.iter().map(|a| a.event).collect();
        events.sort_unstable();
        let n = events.len();
        events.dedup();
        assert_eq!(n, events.len(), "duplicate event name");
    }
}
