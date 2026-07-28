#[cfg(target_os = "windows")]
use tauri::PhysicalPosition;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
#[cfg(target_os = "windows")]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tracing::*;

#[cfg(target_os = "windows")]
const LEGACY_MAXIMIZED_SIZE_TOLERANCE: u32 = 1;
#[cfg(target_os = "windows")]
const CLEARLY_OFFSCREEN_DISTANCE: i64 = 32;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_WIDTH: f64 = 800.0;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_HEIGHT: f64 = 600.0;

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PhysicalWindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug)]
struct RectEdges {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

#[cfg(target_os = "windows")]
impl RectEdges {
    fn from_rect(rect: PhysicalWindowRect) -> Self {
        let left = i64::from(rect.x);
        let top = i64::from(rect.y);
        Self {
            left,
            top,
            right: left + i64::from(rect.width),
            bottom: top + i64::from(rect.height),
        }
    }
}

#[cfg(target_os = "windows")]
fn virtual_desktop_bounds(monitors: &[PhysicalWindowRect]) -> Option<RectEdges> {
    let mut monitors = monitors.iter().copied();
    let mut bounds = RectEdges::from_rect(monitors.next()?);
    for monitor in monitors {
        let monitor = RectEdges::from_rect(monitor);
        bounds.left = bounds.left.min(monitor.left);
        bounds.top = bounds.top.min(monitor.top);
        bounds.right = bounds.right.max(monitor.right);
        bounds.bottom = bounds.bottom.max(monitor.bottom);
    }
    Some(bounds)
}

#[cfg(target_os = "windows")]
fn should_recover_legacy_maximized_state(
    is_maximized: bool,
    window: PhysicalWindowRect,
    current_monitor: PhysicalWindowRect,
    available_monitors: &[PhysicalWindowRect],
) -> bool {
    if is_maximized
        || available_monitors.is_empty()
        || window.width.abs_diff(current_monitor.width) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
        || window.height.abs_diff(current_monitor.height) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
    {
        return false;
    }

    let Some(virtual_desktop) = virtual_desktop_bounds(available_monitors) else {
        return false;
    };
    let window = RectEdges::from_rect(window);
    let tolerated_overflow = CLEARLY_OFFSCREEN_DISTANCE - 1;

    window.left < virtual_desktop.left - tolerated_overflow
        || window.top < virtual_desktop.top - tolerated_overflow
        || window.right > virtual_desktop.right + tolerated_overflow
        || window.bottom > virtual_desktop.bottom + tolerated_overflow
}

#[cfg(target_os = "windows")]
fn centered_restore_rect(monitor: PhysicalWindowRect, scale_factor: f64) -> PhysicalWindowRect {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let desired_width = (DEFAULT_RESTORE_LOGICAL_WIDTH * scale_factor)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    let desired_height = (DEFAULT_RESTORE_LOGICAL_HEIGHT * scale_factor)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    let width = desired_width.min(monitor.width);
    let height = desired_height.min(monitor.height);
    let x_offset = i32::try_from((monitor.width - width) / 2).unwrap_or(i32::MAX);
    let y_offset = i32::try_from((monitor.height - height) / 2).unwrap_or(i32::MAX);

    PhysicalWindowRect {
        x: monitor.x.saturating_add(x_offset),
        y: monitor.y.saturating_add(y_offset),
        width,
        height,
    }
}

#[cfg(target_os = "windows")]
fn recover_legacy_maximized_state<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    label: &str,
) -> bool {
    if label != "main" {
        return false;
    }

    let Ok(is_maximized) = window.is_maximized() else {
        return false;
    };
    let (Ok(window_position), Ok(window_size), Ok(Some(current_monitor)), Ok(monitors)) = (
        window.outer_position(),
        window.inner_size(),
        window.current_monitor(),
        window.available_monitors(),
    ) else {
        return false;
    };

    let window_rect = PhysicalWindowRect {
        x: window_position.x,
        y: window_position.y,
        width: window_size.width,
        height: window_size.height,
    };
    let current_monitor_rect = PhysicalWindowRect {
        x: current_monitor.position().x,
        y: current_monitor.position().y,
        width: current_monitor.size().width,
        height: current_monitor.size().height,
    };
    let available_monitor_rects: Vec<_> = monitors
        .iter()
        .map(|monitor| PhysicalWindowRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    let current_work_area = current_monitor.work_area();
    let current_work_area_rect = PhysicalWindowRect {
        x: current_work_area.position.x,
        y: current_work_area.position.y,
        width: current_work_area.size.width,
        height: current_work_area.size.height,
    };

    if !should_recover_legacy_maximized_state(
        is_maximized,
        window_rect,
        current_monitor_rect,
        &available_monitor_rects,
    ) {
        return false;
    }

    let restore_rect =
        centered_restore_rect(current_work_area_rect, current_monitor.scale_factor());
    info!(
        "Recovering legacy maximized window state for {}: {:?} -> {:?} on {:?}",
        label, window_rect, restore_rect, current_monitor_rect
    );

    if let Err(err) = window.set_size(PhysicalSize::new(restore_rect.width, restore_rect.height)) {
        warn!("Failed to restore normal window size for {label}: {err}");
        return false;
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(restore_rect.x, restore_rect.y)) {
        warn!("Failed to restore normal window position for {label}: {err}");
        return false;
    }

    // Persist the repaired normal bounds before maximizing. A later save while
    // maximized intentionally preserves these values as the restore rectangle.
    if let Err(err) = window
        .app_handle()
        .save_window_state(StateFlags::SIZE | StateFlags::POSITION)
    {
        warn!("Failed to persist repaired normal window bounds for {label}: {err}");
    }

    if let Err(err) = window.maximize() {
        warn!("Failed to recover maximized window state for {label}: {err}");
        return false;
    }

    true
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
        let recovered_legacy_maximized_state = recover_legacy_maximized_state(&win, label);

        // The Windows main window remains hidden until React has painted its
        // first frame. Focusing it here may implicitly expose the blank native
        // host, so the frontend shows and focuses it together when ready.
        #[cfg(target_os = "windows")]
        if label != "main" {
            let _ = win.set_focus();
        }
        #[cfg(not(target_os = "windows"))]
        let _ = win.set_focus();

        // Tao on Windows clears the maximized flag whenever set_size is called.
        // Keep the historical layout refresh for ordinary windows, but never
        // run it after window-state restored (or legacy recovery applied)
        // maximization.
        #[cfg(target_os = "windows")]
        let should_refresh_layout =
            !recovered_legacy_maximized_state && matches!(win.is_maximized(), Ok(false));
        #[cfg(not(target_os = "windows"))]
        let should_refresh_layout = true;

        if should_refresh_layout {
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
            &[PRIMARY_MONITOR],
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
            &[PRIMARY_MONITOR],
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
            &[PRIMARY_MONITOR],
        ));
        assert!(!should_recover_legacy_maximized_state(
            false,
            taskbar_reduced,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
        assert!(!should_recover_legacy_maximized_state(
            false,
            PhysicalWindowRect {
                x: -363,
                y: 480,
                width: 2560,
                height: 1599,
            },
            PRIMARY_MONITOR,
            &[],
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
            &[PRIMARY_MONITOR],
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
            &[PRIMARY_MONITOR],
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
            false,
            corrupted,
            monitor,
            &[monitor],
        ));
    }

    #[test]
    fn does_not_recover_a_valid_window_spanning_two_monitors() {
        let left_monitor = PhysicalWindowRect {
            x: -2560,
            y: 32,
            width: 2560,
            height: 1600,
        };
        let spanning_window = PhysicalWindowRect {
            x: -1000,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            spanning_window,
            PRIMARY_MONITOR,
            &[left_monitor, PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn still_recovers_when_another_monitor_only_covers_one_bad_edge() {
        let left_monitor = PhysicalWindowRect {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1600,
        };
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
            &[left_monitor, PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn calculates_dpi_aware_centered_restore_bounds() {
        let auto_hide_work_area = PhysicalWindowRect {
            height: 1599,
            ..PRIMARY_MONITOR
        };

        assert_eq!(
            centered_restore_rect(auto_hide_work_area, 1.5),
            PhysicalWindowRect {
                x: 680,
                y: 349,
                width: 1200,
                height: 900,
            },
        );
    }

    #[test]
    fn clips_restore_bounds_to_a_smaller_monitor() {
        let small_monitor = PhysicalWindowRect {
            x: -1280,
            y: 100,
            width: 640,
            height: 480,
        };

        assert_eq!(centered_restore_rect(small_monitor, 2.0), small_monitor,);
    }
}
