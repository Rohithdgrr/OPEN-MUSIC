//! Floating desktop card window: toggle, click-through pin, and recovery
//! when the monitor it lives on disappears.

use tauri::Manager;

/// Next state of the card — pure, so the toggle is testable without a window.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum WidgetPlan {
    Show { embed: bool },
    Hide,
}

/// Toggle state machine: visible always hides (detaching first is the
/// caller's job), hidden shows with the placement the caller saved.
pub fn plan_toggle(visible: bool, embed: bool) -> WidgetPlan {
    if visible {
        WidgetPlan::Hide
    } else {
        WidgetPlan::Show { embed }
    }
}

/// Caps+W / tray-free toggle from the frontend: flips card visibility and
/// returns the new state.
#[tauri::command]
pub fn toggle_widget(app: tauri::AppHandle, embed: Option<bool>) -> Result<bool, String> {
    let win = app
        .get_webview_window("widget")
        .ok_or_else(|| "desktop widget window is missing".to_string())?;
    let visible = win.is_visible().unwrap_or(false);
    match plan_toggle(visible, embed.unwrap_or(false)) {
        WidgetPlan::Hide => {
            crate::reparent(&win, false)?;
            win.hide().map_err(|e| e.to_string())?;
            Ok(false)
        }
        WidgetPlan::Show { embed } => {
            rescue_orphaned_monitor(&win);
            crate::reparent(&win, embed)?;
            win.show().map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

/// Pin mode: clicks pass through to whatever is underneath. The pin button
/// itself releases this when the main window regains focus (the widget can
/// no longer receive clicks while it is on).
#[tauri::command]
pub fn set_widget_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("widget")
        .ok_or_else(|| "desktop widget window is missing".to_string())?;
    win.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())
}

/// Tauri 2 has no monitor-removed event, so the orphaned card is rescued on
/// every show and on the Moved/Resized events Windows fires when it
/// relocates a window after an unplug.
/// ponytail: event-driven re-check instead of a monitor-change event (none
/// exists); a periodic poll is the fallback if this ever misses.
fn rescue_orphaned_monitor(win: &tauri::WebviewWindow) {
    if win.current_monitor().ok().flatten().is_some() {
        return;
    }
    let (Ok(Some(primary)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else {
        return;
    };
    let pos = primary.position();
    let msz = primary.size();
    // offsets are u32, monitor coordinates i32; screen dims fit i32 in practice
    let x = pos
        .x
        .saturating_add(msz.width.saturating_sub(size.width) as i32)
        .saturating_sub(24);
    let y = pos
        .y
        .saturating_add(msz.height.saturating_sub(size.height) as i32)
        .saturating_sub(96);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Shared window-event handling: close hides to tray (shortcuts keep
/// working), monitor loss rescues the card.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            if window.label() == "widget" =>
        {
            if let Some(win) = window.app_handle().get_webview_window("widget") {
                rescue_orphaned_monitor(&win);
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {}
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_flips_state_every_call() {
        let mut visible = false;
        for round in 0..6 {
            let want_embed = round % 2 == 0;
            match plan_toggle(visible, want_embed) {
                WidgetPlan::Show { embed } => {
                    assert!(!visible, "show only when hidden");
                    visible = true;
                    assert_eq!(embed, want_embed);
                }
                WidgetPlan::Hide => {
                    assert!(visible, "hide only when visible");
                    visible = false;
                }
            }
        }
        assert!(!visible, "even number of toggles returns to start");
    }

    #[test]
    fn show_carries_the_embed_preference_and_hide_drops_it() {
        assert_eq!(plan_toggle(false, true), WidgetPlan::Show { embed: true });
        assert_eq!(plan_toggle(false, false), WidgetPlan::Show { embed: false });
        assert_eq!(plan_toggle(true, true), WidgetPlan::Hide);
    }
}
