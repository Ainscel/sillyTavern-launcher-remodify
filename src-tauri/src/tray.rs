// ─────────────────────────────────────────────────────────────────────────────
// 系统托盘
//
// 用于「关闭软件时最小化到托盘」：开启后关闭主窗口不再退出程序，而是隐藏到托盘图标。
// 托盘图标按需创建一次后常驻，之后仅切换可见性，避免反复创建/销毁。
// 图标是否显示完全由 AppConfig::minimize_to_tray 决定（见 config::save_app_config）。
//
// 注意：隐藏窗口不会停止酒馆进程，也不影响任何进行中的安装/下载任务。
// ─────────────────────────────────────────────────────────────────────────────
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

/// 托盘图标 ID
const TRAY_ID: &str = "main-tray";
/// 菜单项：显示主界面
const MENU_SHOW: &str = "tray_show_main";
/// 菜单项：退出程序
const MENU_QUIT: &str = "tray_quit";
/// 事件名：托盘请求退出
///
/// 不直接调用 `app.exit()`，而是交给前端执行完整的关闭流程，
/// 以保证「安装任务进行中」的确认弹窗、酒馆进程收尾等既有逻辑不被绕过。
pub const EVENT_TRAY_QUIT: &str = "tray-quit-requested";

/// 托盘状态。图标创建后常驻于此，后续只切换可见性。
#[derive(Default)]
pub struct TrayState {
    icon: Mutex<Option<TrayIcon<Wry>>>,
}

/// 显示并聚焦主窗口（从托盘恢复）
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 创建托盘图标；若已创建则仅切换为可见。
///
/// 必须在主线程调用（Tauri 内部会自行派发到主线程）。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<TrayState>();

    let existing = {
        let guard = state.icon.lock().unwrap();
        guard.as_ref().cloned()
    };
    if let Some(tray) = existing {
        let _ = tray.set_visible(true);
        return Ok(());
    }

    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示主界面", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("酒馆启动器")
        .menu(&menu)
        // 左键单击恢复窗口，右键弹出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => {
                // 先恢复窗口，保证前端的确认弹窗可见，再交由前端走完整关闭流程
                show_main_window(app);
                if let Err(e) = app.emit(EVENT_TRAY_QUIT, ()) {
                    tracing::error!("发送托盘退出事件失败: {}", e);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 复用应用自身图标，无需额外图标资源
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    *state.icon.lock().unwrap() = Some(tray);
    tracing::info!("系统托盘图标已创建");
    Ok(())
}

/// 按开关状态显示/隐藏托盘图标。
///
/// 关闭时不销毁图标，只切换可见性，便于用户反复开关。
pub fn set_tray_visible(app: &AppHandle, visible: bool) {
    if !visible {
        let existing = {
            let state = app.state::<TrayState>();
            let guard = state.icon.lock().unwrap();
            guard.as_ref().cloned()
        };
        if let Some(tray) = existing {
            if let Err(e) = tray.set_visible(false) {
                tracing::warn!("隐藏托盘图标失败: {}", e);
            }
        }
        return;
    }

    if let Err(e) = create_tray(app) {
        tracing::error!("创建托盘图标失败: {}", e);
    }
}

/// 隐藏主窗口到托盘
///
/// 由前端点击关闭按钮时调用（前端未授予 `core:window:allow-hide` 权限，
/// 且所有窗口操作统一经由 Rust 后端）。只隐藏窗口，不会停止酒馆进程。
#[tauri::command]
pub fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("主窗口不存在".to_string());
    };
    window.hide().map_err(|e| e.to_string())
}
