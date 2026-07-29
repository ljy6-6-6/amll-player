#[cfg(target_os = "windows")]
use serde::Deserialize;
#[cfg(target_os = "windows")]
use std::{
    collections::HashMap,
    fs,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
#[cfg(target_os = "windows")]
use tauri::{PhysicalPosition, Position, Rect};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
#[cfg(target_os = "windows")]
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
use tracing::*;
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::{DWMWA_CLOAK, DwmFlush, DwmSetWindowAttribute},
    UI::WindowsAndMessaging::{SW_SHOWMAXIMIZED, ShowWindow},
};
#[cfg(target_os = "windows")]
use windows::core::BOOL;

#[cfg(target_os = "windows")]
const LEGACY_MAXIMIZED_SIZE_TOLERANCE: u32 = 1;
#[cfg(target_os = "windows")]
const CLEARLY_OFFSCREEN_DISTANCE: i64 = 32;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_WIDTH: f64 = 800.0;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_HEIGHT: f64 = 600.0;
#[cfg(target_os = "windows")]
const RESTORE_BOUNDS_SETTLE_DELAY: Duration = Duration::from_millis(80);
#[cfg(target_os = "windows")]
const DWM_UNCLOAK_RETRY_DELAYS_MS: [u64; 5] = [0, 1, 2, 4, 8];

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
struct PersistedWindowPresentation {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    fullscreen: bool,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Default)]
pub(crate) struct MainWindowPresentationState {
    maximize_on_reveal: AtomicBool,
    fullscreen_on_reveal: AtomicBool,
    revealed: AtomicBool,
    presenting: AtomicBool,
    restore_bounds_generation: AtomicU64,
    restore_bounds: Mutex<Option<PhysicalWindowRect>>,
    pending_restore_bounds: Mutex<Option<PhysicalWindowRect>>,
}

#[cfg(target_os = "windows")]
impl MainWindowPresentationState {
    fn prepare(&self, maximize_on_reveal: bool, fullscreen_on_reveal: bool) {
        self.maximize_on_reveal
            .store(maximize_on_reveal, Ordering::Release);
        self.fullscreen_on_reveal
            .store(fullscreen_on_reveal, Ordering::Release);
        self.revealed.store(false, Ordering::Release);
        self.presenting.store(false, Ordering::Release);
        self.restore_bounds_generation
            .fetch_add(1, Ordering::AcqRel);
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn set_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
    }

    fn restore_bounds(&self) -> Option<PhysicalWindowRect> {
        let pending = *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.or_else(|| {
            *self
                .restore_bounds
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        })
    }

    fn set_pending_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
    }

    fn commit_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
        let mut pending = self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *pending == Some(bounds) {
            *pending = None;
        }
    }
}

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
fn main_window_restore_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::DECORATIONS
}

#[cfg(target_os = "windows")]
fn parse_persisted_window_presentation(
    json: &str,
    label: &str,
) -> Result<PersistedWindowPresentation, serde_json::Error> {
    let states: HashMap<String, PersistedWindowPresentation> = serde_json::from_str(json)?;
    Ok(states.get(label).copied().unwrap_or_default())
}

#[cfg(target_os = "windows")]
fn load_persisted_window_presentation(app: &AppHandle, label: &str) -> PersistedWindowPresentation {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return PersistedWindowPresentation::default();
    };
    let path = config_dir.join(app.filename());
    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return PersistedWindowPresentation::default();
        }
        Err(err) => {
            warn!("Failed to read persisted window state from {path:?}: {err}");
            return PersistedWindowPresentation::default();
        }
    };
    match parse_persisted_window_presentation(&json, label) {
        Ok(presentation) => presentation,
        Err(err) => {
            warn!("Failed to parse persisted window state from {path:?}: {err}");
            PersistedWindowPresentation::default()
        }
    }
}

#[cfg(target_os = "windows")]
fn normalize_persisted_main_window_state(
    json: &str,
    restore_bounds: PhysicalWindowRect,
    presentation_override: Option<(bool, bool)>,
) -> Result<Option<Vec<u8>>, serde_json::Error> {
    let mut states: serde_json::Value = serde_json::from_str(json)?;
    let Some(main) = states
        .get_mut("main")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(None);
    };

    if let Some((maximized, fullscreen)) = presentation_override {
        main.insert("maximized".into(), maximized.into());
        main.insert("fullscreen".into(), fullscreen.into());
    }
    let maximized = main
        .get("maximized")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let fullscreen = main
        .get("fullscreen")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !maximized && !fullscreen {
        return Ok(None);
    }

    for (key, value) in [
        ("width", u64::from(restore_bounds.width)),
        ("height", u64::from(restore_bounds.height)),
    ] {
        main.insert(key.into(), value.into());
    }
    for (key, value) in [
        ("x", i64::from(restore_bounds.x)),
        ("y", i64::from(restore_bounds.y)),
        ("prev_x", i64::from(restore_bounds.x)),
        ("prev_y", i64::from(restore_bounds.y)),
    ] {
        main.insert(key.into(), value.into());
    }

    serde_json::to_vec_pretty(&states).map(Some)
}

#[cfg(target_os = "windows")]
fn rewrite_persisted_main_window_state(
    app: &AppHandle,
    presentation_override: Option<(bool, bool)>,
) {
    let presentation = app.state::<MainWindowPresentationState>();
    let Some(restore_bounds) = presentation.restore_bounds() else {
        warn!("Skipping main window state normalization without stable restore bounds");
        return;
    };
    let Ok(config_dir) = app.path().app_config_dir() else {
        warn!("Failed to resolve app config directory while normalizing main window state");
        return;
    };
    let path = config_dir.join(app.filename());
    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(err) => {
            warn!("Failed to read persisted window state from {path:?}: {err}");
            return;
        }
    };
    let normalized =
        match normalize_persisted_main_window_state(&json, restore_bounds, presentation_override) {
            Ok(Some(normalized)) => normalized,
            Ok(None) => return,
            Err(err) => {
                warn!("Failed to normalize persisted main window state from {path:?}: {err}");
                return;
            }
        };
    if normalized == json.as_bytes() {
        return;
    }
    if let Err(err) = fs::write(&path, normalized) {
        warn!("Failed to write normalized main window state to {path:?}: {err}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn sanitize_persisted_main_window_state(app: &AppHandle) {
    rewrite_persisted_main_window_state(app, None);
}

#[cfg(target_os = "windows")]
fn is_probable_presentation_transition_bounds(
    bounds: PhysicalWindowRect,
    work_area: PhysicalWindowRect,
    monitor: PhysicalWindowRect,
) -> bool {
    let x_offset = i64::from(bounds.x) - i64::from(work_area.x);
    let y_offset = i64::from(bounds.y) - i64::from(work_area.y);
    let at_maximized_shadow_edge = (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&x_offset)
        || (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&y_offset);
    let transition_tolerance = u32::try_from(CLEARLY_OFFSCREEN_DISTANCE).unwrap_or(u32::MAX);
    let fills_work_area = bounds.width.abs_diff(work_area.width) < transition_tolerance
        && bounds.height.abs_diff(work_area.height) < transition_tolerance;
    let fills_monitor = bounds.width.abs_diff(monitor.width) < transition_tolerance
        && bounds.height.abs_diff(monitor.height) < transition_tolerance;
    at_maximized_shadow_edge || fills_work_area || fills_monitor
}

#[cfg(target_os = "windows")]
fn current_normal_restore_bounds(window: &tauri::WebviewWindow) -> Option<PhysicalWindowRect> {
    if window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
        || window.is_minimized().unwrap_or(true)
    {
        return None;
    }
    let (Ok(position), Ok(size), Ok(Some(monitor))) = (
        window.outer_position(),
        window.inner_size(),
        window.current_monitor(),
    ) else {
        return None;
    };
    if size.width == 0 || size.height == 0 {
        return None;
    }

    let monitor_rect = PhysicalWindowRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    };
    let work_area = monitor.work_area();
    let bounds = PhysicalWindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let work_area = PhysicalWindowRect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    };
    // WM_WINDOWPOSCHANGED may arrive before Tao updates is_maximized().
    // Reject the maximized shadow edge/full-work-area geometry during that gap.
    if is_probable_presentation_transition_bounds(bounds, work_area, monitor_rect) {
        return None;
    }

    Some(bounds)
}

#[cfg(target_os = "windows")]
pub(crate) fn track_main_window_restore_bounds(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main"
        || !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        )
    {
        return;
    }

    let app = window.app_handle().clone();
    let presentation = app.state::<MainWindowPresentationState>();
    if !presentation.presenting.load(Ordering::Acquire)
        && let Some(window) = app.get_webview_window("main")
        && let Some(bounds) = current_normal_restore_bounds(&window)
    {
        // Preserve the latest valid candidate immediately. A maximize event can
        // cancel the delayed stable sample less than one frame later.
        presentation.set_pending_restore_bounds(bounds);
    }
    let generation = presentation
        .restore_bounds_generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESTORE_BOUNDS_SETTLE_DELAY).await;
        let presentation = app.state::<MainWindowPresentationState>();
        if presentation.presenting.load(Ordering::Acquire)
            || presentation
                .restore_bounds_generation
                .load(Ordering::Acquire)
                != generation
        {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Some(bounds) = current_normal_restore_bounds(&window) {
            presentation.commit_restore_bounds(bounds);
        }
    });
}

#[cfg(target_os = "windows")]
fn set_dwm_cloaked(hwnd: HWND, cloaked: bool) -> windows::core::Result<()> {
    let value = BOOL::from(cloaked);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of_val(&value) as u32,
        )
    }
}

#[cfg(target_os = "windows")]
fn uncloak_dwm_with_retry(hwnd: HWND) -> windows::core::Result<()> {
    let mut last_error = None;
    for delay_ms in DWM_UNCLOAK_RETRY_DELAYS_MS {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match set_dwm_cloaked(hwnd, false) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
                let _ = unsafe { DwmFlush() };
            }
        }
    }
    Err(last_error.expect("uncloak retry loop must run at least once"))
}

#[cfg(target_os = "windows")]
struct DwmCloakGuard {
    hwnd: HWND,
    active: bool,
}

#[cfg(target_os = "windows")]
impl DwmCloakGuard {
    fn new(hwnd: HWND) -> Self {
        Self { hwnd, active: true }
    }

    fn release(&mut self) -> windows::core::Result<()> {
        uncloak_dwm_with_retry(self.hwnd)?;
        self.active = false;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for DwmCloakGuard {
    fn drop(&mut self) {
        if self.active
            && let Err(err) = uncloak_dwm_with_retry(self.hwnd)
        {
            error!("Failed to release emergency DWM cloak guard: {err}");
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
fn centered_rect_with_size(
    monitor: PhysicalWindowRect,
    width: u32,
    height: u32,
) -> PhysicalWindowRect {
    let width = width.clamp(1, monitor.width);
    let height = height.clamp(1, monitor.height);
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
fn is_collapsed_maximized_restore_origin(
    persisted: PersistedWindowPresentation,
    work_area: PhysicalWindowRect,
) -> bool {
    if !persisted.maximized {
        return false;
    }
    let same_origin = persisted.x == persisted.prev_x && persisted.y == persisted.prev_y;
    let x_offset = i64::from(persisted.prev_x) - i64::from(work_area.x);
    let y_offset = i64::from(persisted.prev_y) - i64::from(work_area.y);
    let prev_is_maximized_shadow_edge = (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&x_offset)
        || (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&y_offset);
    let work_area = RectEdges::from_rect(work_area);
    let persisted_x = i64::from(persisted.x);
    let persisted_y = i64::from(persisted.y);
    let current_origin_is_normal = persisted_x >= work_area.left
        && persisted_x < work_area.right
        && persisted_y >= work_area.top
        && persisted_y < work_area.bottom;
    prev_is_maximized_shadow_edge
        && (same_origin || persisted.fullscreen || current_origin_is_normal)
}

#[cfg(target_os = "windows")]
fn repair_collapsed_maximized_restore_bounds<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    label: &str,
    persisted: PersistedWindowPresentation,
) -> bool {
    if label != "main" {
        return false;
    }
    let (Ok(window_size), Ok(Some(current_monitor))) =
        (window.inner_size(), window.current_monitor())
    else {
        return false;
    };
    let work_area = current_monitor.work_area();
    let work_area_rect = PhysicalWindowRect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    };
    if !is_collapsed_maximized_restore_origin(persisted, work_area_rect) {
        return false;
    }
    let repaired = centered_rect_with_size(work_area_rect, window_size.width, window_size.height);
    info!(
        "Repairing collapsed maximized restore bounds for {label}: ({}, {}) -> {:?}",
        persisted.prev_x, persisted.prev_y, repaired
    );
    if let Err(err) = window.set_size(PhysicalSize::new(repaired.width, repaired.height)) {
        warn!("Failed to repair collapsed window size for {label}: {err}");
        return false;
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(repaired.x, repaired.y)) {
        warn!("Failed to repair collapsed window position for {label}: {err}");
        return false;
    }
    true
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
    let Ok(is_fullscreen) = window.is_fullscreen() else {
        return false;
    };
    if is_fullscreen {
        return false;
    }
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
        if label == "main" {
            let persisted_presentation = load_persisted_window_presentation(app, label);
            if let Err(err) = win.restore_state(main_window_restore_flags()) {
                warn!("Failed to restore hidden main window bounds: {err}");
            }
            repair_collapsed_maximized_restore_bounds(&win, label, persisted_presentation);
            let recovered_legacy_maximized_state = recover_legacy_maximized_state(&win, label);
            let presentation = app.state::<MainWindowPresentationState>();
            presentation.prepare(
                persisted_presentation.maximized || recovered_legacy_maximized_state,
                persisted_presentation.fullscreen,
            );
            if let (Ok(position), Ok(size)) = (win.outer_position(), win.inner_size())
                && size.width > 0
                && size.height > 0
            {
                presentation.set_restore_bounds(PhysicalWindowRect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                });
            }
        }

        // The Windows main window remains hidden until React has painted its
        // first frame. Focusing it here may implicitly expose the blank native
        // host, so the frontend shows and focuses it together when ready.
        #[cfg(target_os = "windows")]
        if label != "main" {
            let _ = win.set_focus();
        }
        #[cfg(not(target_os = "windows"))]
        let _ = win.set_focus();

        // The main WebView is calibrated after its final visible presentation.
        // Keep the historical hidden size refresh only for auxiliary windows.
        #[cfg(target_os = "windows")]
        let should_refresh_layout = label != "main" && matches!(win.is_maximized(), Ok(false));
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

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn present_main_window(app: AppHandle) -> Result<(), String> {
    let presentation = app.state::<MainWindowPresentationState>();
    if presentation.revealed.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    presentation.presenting.store(true, Ordering::Release);

    let result = (|| {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window not found.".to_string())?;
        let should_maximize = presentation.maximize_on_reveal.load(Ordering::Acquire);
        let should_fullscreen = presentation.fullscreen_on_reveal.load(Ordering::Acquire);

        // Refresh the cached normal bounds immediately before the native
        // presentation, then normalize the disk fallback independently of
        // the plugin's maximized Moved events.
        if let Err(err) = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION) {
            warn!("Failed to refresh normal bounds before presenting main window: {err}");
        }
        rewrite_persisted_main_window_state(&app, Some((should_maximize, should_fullscreen)));

        let raw_hwnd = window.hwnd().map_err(|err| err.to_string())?;
        let hwnd = HWND(raw_hwnd.0);
        let mut cloak_guard = match set_dwm_cloaked(hwnd, true) {
            Ok(()) => Some(DwmCloakGuard::new(hwnd)),
            Err(err) => {
                warn!("Failed to cloak main window during atomic presentation: {err}");
                None
            }
        };

        let configure_result = (|| {
            // Synchronize Tao's VISIBLE flag while DWM still withholds the
            // window. If cloaking was unavailable, this is the visible fallback.
            window.show().map_err(|err| err.to_string())?;
            if should_maximize {
                if let Err(err) = window.restore_state(StateFlags::MAXIMIZED) {
                    warn!("Failed to restore guarded maximized state: {err}");
                }
                if !window.is_maximized().map_err(|err| err.to_string())? {
                    warn!("Window-state cache did not contain maximized state; using raw fallback");
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_SHOWMAXIMIZED);
                    }
                }
            }
            if should_fullscreen {
                // Reuse the plugin's restoring lock so its fullscreen move
                // cannot overwrite the normal prev_x/prev_y captured above.
                window
                    .restore_state(StateFlags::FULLSCREEN)
                    .map_err(|err| err.to_string())?;
                if !window.is_fullscreen().map_err(|err| err.to_string())? {
                    warn!(
                        "Window-state cache did not contain fullscreen state; using direct fallback"
                    );
                    window.set_fullscreen(true).map_err(|err| err.to_string())?;
                }
            }

            let client_size = window.inner_size().map_err(|err| err.to_string())?;
            window
                .as_ref()
                .set_bounds(Rect {
                    position: Position::Physical(PhysicalPosition::new(0, 0)),
                    size: Size::Physical(client_size),
                })
                .map_err(|err| err.to_string())
        })();

        let uncloak_result = if let Some(guard) = cloak_guard.as_mut() {
            // Let WebView2 submit the final hidden surface before DWM exposes it.
            let _ = unsafe { DwmFlush() };
            let result = guard
                .release()
                .or_else(|first_err| {
                    warn!("First DWM uncloak retry cycle failed: {first_err}");
                    guard.release()
                })
                .map_err(|err| err.to_string());
            if result.is_ok() {
                let _ = unsafe { DwmFlush() };
            }
            result
        } else {
            Ok(())
        };
        configure_result?;
        uncloak_result?;
        window.set_focus().map_err(|err| err.to_string())
    })();

    presentation.presenting.store(false, Ordering::Release);
    if result.is_err() {
        presentation.revealed.store(false, Ordering::Release);
    }
    result
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
    fn hidden_restore_excludes_visibility_and_maximization() {
        let flags = main_window_restore_flags();

        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::DECORATIONS));
        assert!(!flags.contains(StateFlags::FULLSCREEN));
        assert!(!flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags.contains(StateFlags::VISIBLE));
    }

    #[test]
    fn reads_only_the_persisted_presentation_intent() {
        let json = r#"{
            "main": {
                "width": 1850,
                "height": 1079,
                "x": -11,
                "y": -11,
                "prev_x": 520,
                "prev_y": 394,
                "maximized": true,
                "fullscreen": false
            }
        }"#;

        assert_eq!(
            parse_persisted_window_presentation(json, "main").unwrap(),
            PersistedWindowPresentation {
                width: 1850,
                height: 1079,
                x: -11,
                y: -11,
                prev_x: 520,
                prev_y: 394,
                maximized: true,
                fullscreen: false,
            },
        );
        assert_eq!(
            parse_persisted_window_presentation(json, "missing").unwrap(),
            PersistedWindowPresentation::default(),
        );
    }

    #[test]
    fn normalizes_maximized_restore_bounds_without_touching_other_windows() {
        let json = r#"{
            "main": {
                "width": 1850,
                "height": 1079,
                "x": -11,
                "y": -11,
                "prev_x": -11,
                "prev_y": -11,
                "maximized": true,
                "visible": true,
                "decorated": false,
                "fullscreen": false
            },
            "screenshot": {
                "x": 42
            }
        }"#;
        let restore_bounds = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };
        let normalized = normalize_persisted_main_window_state(json, restore_bounds, None)
            .unwrap()
            .unwrap();
        let normalized: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

        assert_eq!(normalized["main"]["x"], 355);
        assert_eq!(normalized["main"]["y"], 260);
        assert_eq!(normalized["main"]["prev_x"], 355);
        assert_eq!(normalized["main"]["prev_y"], 260);
        assert_eq!(normalized["main"]["width"], 1850);
        assert_eq!(normalized["main"]["height"], 1079);
        assert_eq!(normalized["main"]["maximized"], true);
        assert_eq!(normalized["main"]["visible"], true);
        assert_eq!(normalized["main"]["decorated"], false);
        assert_eq!(normalized["screenshot"]["x"], 42);
    }

    #[test]
    fn presentation_override_persists_recovered_legacy_maximization() {
        let json = r#"{
            "main": {
                "width": 2560,
                "height": 1600,
                "x": -40,
                "y": -40,
                "prev_x": 0,
                "prev_y": 0,
                "maximized": false,
                "fullscreen": false
            }
        }"#;
        let restore_bounds = PhysicalWindowRect {
            x: 880,
            y: 500,
            width: 800,
            height: 600,
        };
        let normalized =
            normalize_persisted_main_window_state(json, restore_bounds, Some((true, false)))
                .unwrap()
                .unwrap();
        let normalized: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

        assert_eq!(normalized["main"]["maximized"], true);
        assert_eq!(normalized["main"]["fullscreen"], false);
        assert_eq!(normalized["main"]["x"], 880);
        assert_eq!(normalized["main"]["prev_x"], 880);
        assert_eq!(normalized["main"]["width"], 800);
        assert_eq!(normalized["main"]["height"], 600);
    }

    #[test]
    fn leaves_normal_persisted_window_state_unchanged() {
        let json = r#"{
            "main": {
                "maximized": false,
                "fullscreen": false
            }
        }"#;

        assert!(
            normalize_persisted_main_window_state(json, PRIMARY_MONITOR, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_maximized_and_fullscreen_event_orders_as_restore_candidates() {
        let work_area = PhysicalWindowRect {
            height: 1500,
            ..PRIMARY_MONITOR
        };
        let normal = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };

        assert!(!is_probable_presentation_transition_bounds(
            normal,
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                x: -11,
                y: -11,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                width: work_area.width,
                height: work_area.height,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                width: PRIMARY_MONITOR.width,
                height: PRIMARY_MONITOR.height,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn pending_normal_bounds_survive_a_cancelled_stable_sample() {
        let state = MainWindowPresentationState::default();
        let old_bounds = PhysicalWindowRect {
            x: 200,
            y: 160,
            width: 1200,
            height: 800,
        };
        let latest_bounds = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };

        state.set_restore_bounds(old_bounds);
        state.set_pending_restore_bounds(latest_bounds);

        assert_eq!(state.restore_bounds(), Some(latest_bounds));
    }

    #[test]
    fn recenters_a_restore_origin_collapsed_to_the_maximized_edge() {
        let work_area = PhysicalWindowRect {
            height: 1599,
            ..PRIMARY_MONITOR
        };
        let collapsed = PersistedWindowPresentation {
            width: 1850,
            height: 1079,
            x: -11,
            y: -11,
            prev_x: -11,
            prev_y: -11,
            maximized: true,
            fullscreen: false,
        };

        assert!(is_collapsed_maximized_restore_origin(collapsed, work_area));
        assert_eq!(
            centered_rect_with_size(work_area, 1850, 1079),
            PhysicalWindowRect {
                x: 355,
                y: 260,
                width: 1850,
                height: 1079,
            },
        );
        assert!(!is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 0,
                y: 0,
                prev_x: 0,
                prev_y: 0,
                ..collapsed
            },
            work_area,
        ));
        assert!(is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 0,
                y: 0,
                fullscreen: true,
                ..collapsed
            },
            work_area,
        ));
        assert!(is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 355,
                y: 260,
                ..collapsed
            },
            work_area,
        ));
    }

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
