use tauri::{AppHandle, Manager, WebviewWindowBuilder};
#[cfg(all(desktop, not(target_os = "windows")))]
use tauri::{PhysicalSize, Size};
#[cfg(desktop)]
use tauri::{utils::config::WindowEffectsConfig, window::Effect};
use tracing::*;

#[cfg(target_os = "windows")]
const LEGACY_MAXIMIZED_SIZE_TOLERANCE: u32 = 1;
#[cfg(target_os = "windows")]
const CLEARLY_OFFSCREEN_DISTANCE: i64 = 32;

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PhysicalWindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn should_recover_legacy_maximized_state(
    is_maximized: bool,
    window: PhysicalWindowRect,
    monitor: PhysicalWindowRect,
) -> bool {
    if is_maximized
        || window.width.abs_diff(monitor.width) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
        || window.height.abs_diff(monitor.height) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
    {
        return false;
    }

    let window_left = i64::from(window.x);
    let window_top = i64::from(window.y);
    let window_right = window_left + i64::from(window.width);
    let window_bottom = window_top + i64::from(window.height);
    let monitor_left = i64::from(monitor.x);
    let monitor_top = i64::from(monitor.y);
    let monitor_right = monitor_left + i64::from(monitor.width);
    let monitor_bottom = monitor_top + i64::from(monitor.height);

    let largest_overflow = [
        monitor_left - window_left,
        monitor_top - window_top,
        window_right - monitor_right,
        window_bottom - monitor_bottom,
    ]
    .into_iter()
    .max()
    .unwrap_or_default();

    largest_overflow >= CLEARLY_OFFSCREEN_DISTANCE
}

#[cfg(target_os = "windows")]
fn recover_legacy_maximized_state<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    label: &str,
) {
    if label != "main" {
        return;
    }

    let Ok(is_maximized) = window.is_maximized() else {
        return;
    };
    let (Ok(window_position), Ok(window_size), Ok(Some(monitor))) = (
        window.outer_position(),
        window.inner_size(),
        window.current_monitor(),
    ) else {
        return;
    };

    let window_rect = PhysicalWindowRect {
        x: window_position.x,
        y: window_position.y,
        width: window_size.width,
        height: window_size.height,
    };
    let monitor_rect = PhysicalWindowRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    };

    if should_recover_legacy_maximized_state(is_maximized, window_rect, monitor_rect) {
        info!(
            "Recovering legacy maximized window state for {}: {:?} on {:?}",
            label, window_rect, monitor_rect
        );
        if let Err(err) = window.maximize() {
            warn!("Failed to recover maximized window state for {label}: {err}");
        }
    }
}

pub async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let win = WebviewWindowBuilder::new(app, label, url);
    #[cfg(target_os = "windows")]
    let win = win.transparent(true);
    #[cfg(not(desktop))]
    let win = win;

    #[cfg(desktop)]
    let win = win
        .center()
        .inner_size(800.0, 600.0)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Tabbed, Effect::Mica],
            ..Default::default()
        })
        .theme(None)
        .title({
            #[cfg(target_os = "macos")]
            {
                ""
            }
            #[cfg(not(target_os = "macos"))]
            {
                "AMLL Player"
            }
        })
        .visible({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        })
        .decorations({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        });

    #[cfg(target_os = "macos")]
    let win = win.title_bar_style(tauri::TitleBarStyle::Overlay);

    win
}

pub async fn recreate_window(app: &AppHandle, label: &str, path: Option<&str>) {
    info!("Recreating window: {}", label);
    if let Some(win) = app.get_webview_window(label) {
        #[cfg(desktop)]
        {
            let _ = win.show();
            let _ = win.set_focus();
        }
        #[cfg(not(desktop))]
        let _ = win;
        return;
    }
    #[cfg(debug_assertions)]
    let url = {
        tauri::WebviewUrl::External(
            app.config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join(path.unwrap_or(""))
                .expect("Failed to create external URL"),
        )
    };
    #[cfg(not(debug_assertions))]
    let url = tauri::WebviewUrl::App(path.unwrap_or("index.html").into());
    let win = create_common_win(app, url, label).await;

    let win = win.build().expect("can't show original window");

    #[cfg(desktop)]
    {
        #[cfg(target_os = "windows")]
        recover_legacy_maximized_state(&win, label);

        let _ = win.set_focus();

        // On Windows, Tao deliberately clears the maximized flag whenever
        // set_size is called. Running this layout refresh after window-state
        // restored a maximized window therefore turns it into a misplaced
        // normal window with the maximized client-area size.
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(orig_size) = win.inner_size() {
                let _ = win.set_size(Size::Physical(PhysicalSize::new(0, 0)));
                let _ = win.set_size(orig_size);
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = win;

    info!("Created window: {}", label);
}

#[tauri::command]
pub async fn open_screenshot_window(app: AppHandle) {
    recreate_window(&app, "screenshot", Some("screenshot.html")).await;
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_window_always_on_top(enabled: bool, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())
    } else {
        Err("Main window not found.".to_string())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    const PRIMARY_MONITOR: PhysicalWindowRect = PhysicalWindowRect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1600,
    };

    #[test]
    fn recovers_known_auto_hide_taskbar_corruption() {
        let corrupted = PhysicalWindowRect {
            x: -363,
            y: 480,
            width: 2560,
            height: 1599,
        };

        assert!(should_recover_legacy_maximized_state(
            false,
            corrupted,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn does_not_recover_a_window_that_is_already_maximized() {
        let corrupted = PhysicalWindowRect {
            x: -363,
            y: 480,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            true,
            corrupted,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn does_not_recover_normal_or_differently_sized_windows() {
        let normal = PhysicalWindowRect {
            x: 880,
            y: 500,
            width: 800,
            height: 600,
        };
        let taskbar_reduced = PhysicalWindowRect {
            x: -100,
            y: 0,
            width: 2560,
            height: 1520,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            normal,
            PRIMARY_MONITOR,
        ));
        assert!(!should_recover_legacy_maximized_state(
            false,
            taskbar_reduced,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn does_not_recover_near_fullscreen_window_inside_monitor() {
        let inside = PhysicalWindowRect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            inside,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn ignores_small_shadow_or_rounding_overflow() {
        let slightly_outside = PhysicalWindowRect {
            x: -8,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            slightly_outside,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn supports_monitors_with_negative_desktop_coordinates() {
        let monitor = PhysicalWindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let corrupted = PhysicalWindowRect {
            x: -2200,
            y: 300,
            width: 1919,
            height: 1080,
        };

        assert!(should_recover_legacy_maximized_state(
            false, corrupted, monitor,
        ));
    }
}
