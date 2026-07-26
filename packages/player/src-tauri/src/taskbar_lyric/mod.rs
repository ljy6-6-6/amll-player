use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use taskbar_lyric::TaskbarService;
use tauri::{Emitter, Manager};
use tracing::warn;
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect},
    UI::{
        Shell::{ABM_GETSTATE, ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA, SHAppBarMessage},
        WindowsAndMessaging::{HWND_TOP, SWP_NOZORDER, SetWindowPos},
    },
};

pub mod mouse_forward;
pub mod webview_finder;

#[allow(dead_code)]
pub struct TaskbarLyricWatchers {
    pub uia: Option<taskbar_lyric::UiaWatcher>,
    pub tray: Option<taskbar_lyric::TrayWatcher>,
    pub reg: Option<taskbar_lyric::RegistryWatcher>,
}

#[derive(Default)]
pub struct TaskbarLyricState {
    pub service: Mutex<Option<taskbar_lyric::TaskbarService>>,
    pub watchers: Mutex<Option<TaskbarLyricWatchers>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarLayoutExtraPayload {
    pub is_centered: bool,
    pub system_type: String,
}

const AUTO_HIDE_TRIGGER_BAND_PX: i32 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TaskbarEdge {
    Left,
    Top,
    Right,
    Bottom,
}

fn taskbar_edge_from_rect(taskbar: RECT, monitor: RECT) -> Option<TaskbarEdge> {
    let width = i64::from(taskbar.right) - i64::from(taskbar.left);
    let height = i64::from(taskbar.bottom) - i64::from(taskbar.top);
    if width <= 0 || height <= 0 {
        return None;
    }

    if width >= height {
        let top_distance = (i64::from(taskbar.top) - i64::from(monitor.top)).abs();
        let bottom_distance = (i64::from(monitor.bottom) - i64::from(taskbar.bottom)).abs();
        Some(if top_distance <= bottom_distance {
            TaskbarEdge::Top
        } else {
            TaskbarEdge::Bottom
        })
    } else {
        let left_distance = (i64::from(taskbar.left) - i64::from(monitor.left)).abs();
        let right_distance = (i64::from(monitor.right) - i64::from(taskbar.right)).abs();
        Some(if left_distance <= right_distance {
            TaskbarEdge::Left
        } else {
            TaskbarEdge::Right
        })
    }
}

fn auto_hidden_taskbar_edge() -> Option<TaskbarEdge> {
    let mut appbar_data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };

    let state = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut appbar_data) };
    if state & ABS_AUTOHIDE as usize == 0 {
        return None;
    }

    if unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut appbar_data) } == 0 {
        return None;
    }

    let monitor = unsafe { MonitorFromRect(&appbar_data.rc, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return None;
    }

    taskbar_edge_from_rect(appbar_data.rc, monitor_info.rcMonitor)
}

fn reserve_auto_hide_trigger_band(
    mut rect: taskbar_lyric::Rect,
    edge: Option<TaskbarEdge>,
) -> taskbar_lyric::Rect {
    match edge {
        Some(TaskbarEdge::Bottom) => {
            let reserved = rect.height.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
            rect.y += reserved;
            rect.height -= reserved;
        }
        Some(TaskbarEdge::Top) => {
            rect.height -= rect.height.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
        }
        Some(TaskbarEdge::Right) => {
            let reserved = rect.width.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
            rect.x += reserved;
            rect.width -= reserved;
        }
        Some(TaskbarEdge::Left) => {
            rect.width -= rect.width.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
        }
        None => {}
    }

    rect
}

#[tauri::command]
pub fn close_taskbar_lyric(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("taskbar-lyric") {
        mouse_forward::stop_mouse_hook();
        if let Some(state) = app.try_state::<TaskbarLyricState>() {
            let _ = state.watchers.lock().unwrap().take();
            let _ = state.service.lock().unwrap().take();
        }
        let _ = win.destroy();
    }
}

#[tauri::command]
pub fn open_taskbar_lyric_devtools(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("taskbar-lyric") {
        win.open_devtools();
    }
}

#[tauri::command]
pub fn refresh_taskbar_lyric_layout(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<TaskbarLyricState>()
        && let Some(service) = state.service.lock().unwrap().as_ref()
    {
        service.update(300);
    }
}

#[tauri::command]
pub fn open_taskbar_lyric(app: tauri::AppHandle) {
    if app.get_webview_window("taskbar-lyric").is_some() {
        return;
    }

    let app_clone = app.clone();
    let service = TaskbarService::new(move |layout| {
        if let Some(win) = app_clone.get_webview_window("taskbar-lyric") {
            let left = layout.space.left;
            let current_rect = if left.width > 0 {
                left
            } else {
                layout.space.right
            };
            let current_rect =
                reserve_auto_hide_trigger_band(current_rect, auto_hidden_taskbar_edge());

            let _ = app_clone.emit(
                "taskbar-layout-extra",
                TaskbarLayoutExtraPayload {
                    is_centered: layout.extra.is_centered,
                    system_type: format!("{:?}", layout.extra.system_type),
                },
            );

            if let Ok(hwnd) = win.hwnd() {
                unsafe {
                    let _ = SetWindowPos(
                        HWND(hwnd.0),
                        Some(HWND_TOP),
                        current_rect.x,
                        current_rect.y,
                        current_rect.width,
                        current_rect.height,
                        SWP_NOZORDER,
                    );
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    mouse_forward::update_cached_bounds();
                });
            }
        }
    });

    if let Some(state) = app.try_state::<TaskbarLyricState>() {
        *state.service.lock().unwrap() = Some(service);
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        #[cfg(debug_assertions)]
        let url = tauri::WebviewUrl::External(
            app_clone
                .config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join("taskbar-lyric.html")
                .unwrap(),
        );
        #[cfg(not(debug_assertions))]
        let url = tauri::WebviewUrl::App("taskbar-lyric.html".into());

        let win_builder = tauri::WebviewWindowBuilder::new(&app_clone, "taskbar-lyric", url)
            .decorations(true)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .visible(true);

        if let Ok(win) = win_builder.build() {
            if let Ok(hwnd) = win.hwnd() {
                let hwnd_ptr = hwnd.0 as usize;
                let top_hwnd = HWND(hwnd.0.cast());

                if let Some(state) = app_clone.try_state::<TaskbarLyricState>()
                    && let Some(srv) = state.service.lock().unwrap().as_ref()
                {
                    srv.embed_window_by_ptr(hwnd_ptr);
                    srv.update(300);
                }

                if let Some(webview_hwnd) = webview_finder::find_webview_hwnd(top_hwnd) {
                    mouse_forward::init_mouse_forwarding_state(top_hwnd, webview_hwnd);
                    mouse_forward::start_mouse_hook_thread();
                } else {
                    warn!("未能找到 WebView 句柄");
                }

                if let Some(state) = app_clone.try_state::<TaskbarLyricState>() {
                    let mut watchers = state.watchers.lock().unwrap();

                    let uia_counter = Arc::new(AtomicUsize::new(0));
                    let win_clone = app_clone.clone();
                    let uia_cb = Box::new(move || {
                        let current = uia_counter.fetch_add(1, Ordering::SeqCst) + 1;
                        let counter_clone = uia_counter.clone();
                        let win_clone_inner = win_clone.clone();

                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            if counter_clone.load(Ordering::SeqCst) == current
                                && let Some(s) = win_clone_inner.try_state::<TaskbarLyricState>()
                                && let Some(srv) = s.service.lock().unwrap().as_ref()
                            {
                                srv.update(300);
                            }
                        });
                    });

                    let win_clone2 = app_clone.clone();
                    let tray_cb = Box::new(move || {
                        if let Some(s) = win_clone2.try_state::<TaskbarLyricState>()
                            && let Some(srv) = s.service.lock().unwrap().as_ref()
                        {
                            srv.update(300);
                        }
                    });

                    let reg_counter = Arc::new(AtomicUsize::new(0));
                    let win_clone3 = app_clone.clone();
                    let reg_cb = Box::new(move || {
                        let _ = win_clone3.emit("taskbar-lyric:fade-out", ());

                        let current = reg_counter.fetch_add(1, Ordering::SeqCst) + 1;
                        let counter_clone = reg_counter.clone();
                        let win_clone_inner = win_clone3.clone();

                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if counter_clone.load(Ordering::SeqCst) == current
                                && let Some(s) = win_clone_inner.try_state::<TaskbarLyricState>()
                                && let Some(srv) = s.service.lock().unwrap().as_ref()
                            {
                                srv.update(300);
                                let _ = win_clone_inner.emit("taskbar-lyric:fade-in", ());
                            }
                        });
                    });

                    *watchers = Some(TaskbarLyricWatchers {
                        uia: taskbar_lyric::UiaWatcher::new(uia_cb).ok(),
                        tray: taskbar_lyric::TrayWatcher::new(tray_cb).ok(),
                        reg: taskbar_lyric::RegistryWatcher::new(reg_cb).ok(),
                    });

                    let _ = win.show();
                }
            } else {
                tracing::warn!("Failed to get hwnd for taskbar-lyric window");
            }
        } else {
            tracing::warn!("Failed to build taskbar-lyric window");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect_tuple(rect: taskbar_lyric::Rect) -> (i32, i32, i32, i32) {
        (rect.x, rect.y, rect.width, rect.height)
    }

    fn sample_rect() -> taskbar_lyric::Rect {
        taskbar_lyric::Rect {
            x: 100,
            y: 200,
            width: 300,
            height: 40,
        }
    }

    #[test]
    fn infers_each_edge_from_taskbar_and_monitor_rects() {
        let monitor = RECT {
            left: -1_280,
            top: -200,
            right: 640,
            bottom: 880,
        };

        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_280,
                    top: -246,
                    right: 640,
                    bottom: -198,
                },
                monitor,
            ),
            Some(TaskbarEdge::Top)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_280,
                    top: 878,
                    right: 640,
                    bottom: 926,
                },
                monitor,
            ),
            Some(TaskbarEdge::Bottom)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_326,
                    top: -200,
                    right: -1_278,
                    bottom: 880,
                },
                monitor,
            ),
            Some(TaskbarEdge::Left)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: 638,
                    top: -200,
                    right: 686,
                    bottom: 880,
                },
                monitor,
            ),
            Some(TaskbarEdge::Right)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: 10,
                    top: 10,
                    right: 10,
                    bottom: 20,
                },
                monitor,
            ),
            None
        );
    }

    #[test]
    fn reserves_trigger_band_for_each_auto_hidden_taskbar_edge() {
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Bottom)
            )),
            (100, 202, 300, 38)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Top)
            )),
            (100, 200, 300, 38)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Right)
            )),
            (102, 200, 298, 40)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Left)
            )),
            (100, 200, 298, 40)
        );
    }

    #[test]
    fn leaves_rect_unchanged_when_taskbar_is_not_auto_hidden() {
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(sample_rect(), None)),
            (100, 200, 300, 40)
        );
    }

    #[test]
    fn does_not_make_tiny_rect_dimensions_negative() {
        let tiny = taskbar_lyric::Rect {
            x: 10,
            y: 20,
            width: 1,
            height: 1,
        };

        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Bottom)
            )),
            (10, 21, 1, 0)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(tiny, Some(TaskbarEdge::Top))),
            (10, 20, 1, 0)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Right)
            )),
            (11, 20, 0, 1)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Left)
            )),
            (10, 20, 0, 1)
        );
    }
}
