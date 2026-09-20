// ─────────────────────────────────────────────────────────────────────────────
// 系统托盘
//
// 托盘图标常驻，承担三类职责：
//   1. 「关闭软件时最小化到托盘」的落点，以及主窗口被隐藏后的唯一唤回入口；
//   2. 酒馆服务的快捷启停、打开网页、复制局域网地址；
//   3. 启动模式与几个常用开关的快捷切换。
//
// 设计约定（与既有 EVENT_TRAY_QUIT 保持一致）：
//   - 凡是会影响前端界面状态的操作（启停酒馆、打开网页、切换启动模式），
//     托盘只负责 emit 事件，由前端走既有流程。这样「最小化到托盘时窗口只是隐藏、
//     webview 仍然存活」，事件照常送达，且不会绕过状态机、确认弹窗、
//     依赖缺失自动修复等既有逻辑。
//   - 纯后端状态类开关（启动模式落盘除外）由 Rust 直接改配置，
//     改完广播 `app-config-changed` 让设置页刷新内存副本。
//
// 菜单是整份重建的：Tauri 的菜单项不支持隐藏，而「运行中才显示」的条目
// （打开网页 / 复制地址 / 重启）需要在状态变化时真正增删，重建最省心，
// 且这些状态变化一天也发生不了几次。
// ─────────────────────────────────────────────────────────────────────────────
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::config::{get_current_lang, read_app_config_from_disk};
use crate::types::{AppConfig, Lang};

/// 托盘图标 ID
const TRAY_ID: &str = "main-tray";

// ─── 菜单项 ID ───────────────────────────────────────────────────────────────
const MENU_SHOW: &str = "tray_show_main";
const MENU_TOGGLE: &str = "tray_toggle_tavern";
const MENU_RESTART: &str = "tray_restart_tavern";
const MENU_OPEN_TAVERN: &str = "tray_open_tavern";
const MENU_COPY_LAN: &str = "tray_copy_lan_url";
const MENU_MODE_NORMAL: &str = "tray_mode_normal";
const MENU_MODE_DESKTOP: &str = "tray_mode_desktop";
const MENU_MODE_LAN: &str = "tray_mode_lan";
const MENU_MODE_PUBLIC: &str = "tray_mode_public";
const MENU_MODE_DEBUG: &str = "tray_mode_debug";
const MENU_CFG_AUTOSTART: &str = "tray_cfg_autostart";
const MENU_CFG_START_MINIMIZED: &str = "tray_cfg_start_minimized";
const MENU_CFG_AUTOSTART_TAVERN: &str = "tray_cfg_autostart_tavern";
const MENU_CFG_AUTORESTART_TAVERN: &str = "tray_cfg_autorestart_tavern";
const MENU_OPEN_DATA_DIR: &str = "tray_open_data_dir";
const MENU_OPEN_LOG_DIR: &str = "tray_open_log_dir";
const MENU_QUIT: &str = "tray_quit";

// ─── 事件名 ─────────────────────────────────────────────────────────────────
/// 托盘请求退出。不直接 `app.exit()`，而是交给前端执行完整关闭流程，
/// 以保证「安装任务进行中」的确认弹窗、酒馆进程收尾等既有逻辑不被绕过。
pub const EVENT_TRAY_QUIT: &str = "tray-quit-requested";
/// 托盘请求启动/停止酒馆，payload: `"start" | "stop"`
pub const EVENT_TRAY_TOGGLE_TAVERN: &str = "tray-toggle-tavern";
/// 托盘请求重启酒馆（停止后重新启动）
pub const EVENT_TRAY_RESTART_TAVERN: &str = "tray-restart-tavern";
/// 托盘请求在浏览器中打开酒馆
pub const EVENT_TRAY_OPEN_TAVERN: &str = "tray-open-tavern";
/// 托盘请求复制局域网访问地址到剪贴板
pub const EVENT_TRAY_COPY_LAN_URL: &str = "tray-copy-lan-url";
/// 托盘请求切换酒馆启动模式，payload: 模式字符串。
/// 交给前端处理是为了复用「公网模式二次确认」等既有校验。
pub const EVENT_TRAY_SET_LAUNCH_MODE: &str = "tray-set-launch-mode";
/// 后端侧操作失败，需要前端弹一条错误提示，payload: 错误文案
pub const EVENT_TOAST_ERROR: &str = "app-toast-error";

/// 运行中使用的托盘图标。
///
/// 编译期嵌入，避免依赖运行时文件路径（安装后 icons/ 目录并不随包分发）。
/// 需要 tauri 的 `image-ico` feature 才能解码 ICO。
static ICON_RUNNING: OnceLock<Option<Image<'static>>> = OnceLock::new();

fn running_icon() -> Option<Image<'static>> {
    ICON_RUNNING
        .get_or_init(|| match Image::from_bytes(include_bytes!("../icons/icon-running.ico")) {
            Ok(img) => Some(img),
            Err(e) => {
                tracing::error!("解析 icon-running.ico 失败，将回退到默认图标: {}", e);
                None
            }
        })
        .clone()
}

/// 托盘状态。图标创建后常驻于此，后续只切换可见性与菜单。
#[derive(Default)]
pub struct TrayState {
    icon: Mutex<Option<TrayIcon<Wry>>>,
    /// 酒馆是否正在运行。由 sillytavern 模块在进程启停时更新，
    /// 用原子量是为了让菜单刷新能同步读取，不必去 await ProcessState 的异步锁。
    running: AtomicBool,
    /// 酒馆实际监听端口（就绪探测成功后写入），仅用于托盘提示文字
    port: AtomicU16,
}

/// 托盘图标当前是否可用。
///
/// 隐藏主窗口前必须确认，否则窗口会「消失」且没有任何入口可以唤回。
pub fn is_tray_available(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .map(|state| state.icon.lock().map(|guard| guard.is_some()).unwrap_or(false))
        .unwrap_or(false)
}

/// 显示并聚焦主窗口（从托盘恢复）
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 多语言文案
// ─────────────────────────────────────────────────────────────────────────────

struct Labels {
    show: &'static str,
    start: &'static str,
    stop: &'static str,
    restart: &'static str,
    open_tavern: &'static str,
    copy_lan: &'static str,
    launch_mode: &'static str,
    mode_normal: &'static str,
    mode_desktop: &'static str,
    mode_lan: &'static str,
    mode_public: &'static str,
    mode_debug: &'static str,
    quick_settings: &'static str,
    cfg_autostart: &'static str,
    cfg_start_minimized: &'static str,
    cfg_autostart_tavern: &'static str,
    cfg_autorestart_tavern: &'static str,
    open_data_dir: &'static str,
    open_log_dir: &'static str,
    quit: &'static str,
    tooltip_idle: &'static str,
    tooltip_running: &'static str,
}

fn labels(lang: Lang) -> Labels {
    match lang {
        Lang::ZhCn => Labels {
            show: "显示主界面",
            start: "启动酒馆",
            stop: "停止酒馆",
            restart: "重启酒馆",
            open_tavern: "打开酒馆网页",
            copy_lan: "复制局域网网址",
            launch_mode: "酒馆启动模式",
            mode_normal: "正常模式",
            mode_desktop: "桌面程序",
            mode_lan: "局域网服务",
            mode_public: "公网服务",
            mode_debug: "调试模式",
            quick_settings: "快捷设置",
            cfg_autostart: "开机自动启动",
            cfg_start_minimized: "启动时最小化到托盘",
            cfg_autostart_tavern: "启动时自动启动酒馆",
            cfg_autorestart_tavern: "酒馆异常退出自动重启",
            open_data_dir: "打开数据目录",
            open_log_dir: "打开日志目录",
            quit: "退出",
            tooltip_idle: "酒馆启动器 · 已停止",
            tooltip_running: "酒馆启动器 · 运行中",
        },
        Lang::EnUs => Labels {
            show: "Show Main Window",
            start: "Start Tavern",
            stop: "Stop Tavern",
            restart: "Restart Tavern",
            open_tavern: "Open Tavern in Browser",
            copy_lan: "Copy LAN Address",
            launch_mode: "Tavern Launch Mode",
            mode_normal: "Normal",
            mode_desktop: "Desktop App",
            mode_lan: "LAN Service",
            mode_public: "Public Service",
            mode_debug: "Debug",
            quick_settings: "Quick Settings",
            cfg_autostart: "Start on Boot",
            cfg_start_minimized: "Start Minimized to Tray",
            cfg_autostart_tavern: "Auto-start Tavern on Launch",
            cfg_autorestart_tavern: "Auto-restart on Abnormal Exit",
            open_data_dir: "Open Data Folder",
            open_log_dir: "Open Logs Folder",
            quit: "Quit",
            tooltip_idle: "Tavern Launcher · Stopped",
            tooltip_running: "Tavern Launcher · Running",
        },
    }
}

fn tooltip_text(lang: Lang, running: bool, port: u16) -> String {
    let base = if running {
        labels(lang).tooltip_running
    } else {
        labels(lang).tooltip_idle
    };
    if running && port > 0 {
        format!("{base} :{port}")
    } else {
        base.to_string()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 菜单构建
// ─────────────────────────────────────────────────────────────────────────────

/// 根据当前运行状态与配置构建整份托盘菜单。
///
/// 所有菜单项都必须先在函数作用域内创建，再按条件把引用 push 进 `items`——
/// Tauri 的 `with_items` 收的是 `&[&dyn IsMenuItem]`，引用必须活得比切片长。
fn build_menu(app: &AppHandle, running: bool, cfg: &AppConfig, lang: Lang) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);

    let show = MenuItem::with_id(app, MENU_SHOW, l.show, true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        MENU_TOGGLE,
        if running { l.stop } else { l.start },
        true,
        None::<&str>,
    )?;
    // 运行中才允许重启
    let restart = MenuItem::with_id(app, MENU_RESTART, l.restart, running, None::<&str>)?;

    // 仅运行中展示的两项
    let open_tavern = MenuItem::with_id(app, MENU_OPEN_TAVERN, l.open_tavern, true, None::<&str>)?;
    let copy_lan = MenuItem::with_id(app, MENU_COPY_LAN, l.copy_lan, true, None::<&str>)?;

    // ── 启动模式（单选） ──
    let mode = cfg.launch_mode.as_str();
    let mode_normal = CheckMenuItem::with_id(
        app,
        MENU_MODE_NORMAL,
        l.mode_normal,
        true,
        mode == "normal",
        None::<&str>,
    )?;
    let mode_desktop = CheckMenuItem::with_id(
        app,
        MENU_MODE_DESKTOP,
        l.mode_desktop,
        true,
        mode == "desktop",
        None::<&str>,
    )?;
    let mode_lan =
        CheckMenuItem::with_id(app, MENU_MODE_LAN, l.mode_lan, true, mode == "lan", None::<&str>)?;
    let mode_public = CheckMenuItem::with_id(
        app,
        MENU_MODE_PUBLIC,
        l.mode_public,
        true,
        mode == "public",
        None::<&str>,
    )?;
    let mode_debug = CheckMenuItem::with_id(
        app,
        MENU_MODE_DEBUG,
        l.mode_debug,
        true,
        mode == "debug",
        None::<&str>,
    )?;
    let mode_refs: Vec<&dyn IsMenuItem<Wry>> = vec![
        &mode_normal,
        &mode_desktop,
        &mode_lan,
        &mode_public,
        &mode_debug,
    ];
    let mode_submenu = Submenu::with_items(app, l.launch_mode, true, &mode_refs)?;

    // ── 快捷设置 ──
    let cfg_autostart = CheckMenuItem::with_id(
        app,
        MENU_CFG_AUTOSTART,
        l.cfg_autostart,
        true,
        cfg.auto_start_launcher,
        None::<&str>,
    )?;
    let cfg_start_minimized = CheckMenuItem::with_id(
        app,
        MENU_CFG_START_MINIMIZED,
        l.cfg_start_minimized,
        true,
        cfg.start_minimized,
        None::<&str>,
    )?;
    let cfg_autostart_tavern = CheckMenuItem::with_id(
        app,
        MENU_CFG_AUTOSTART_TAVERN,
        l.cfg_autostart_tavern,
        true,
        cfg.auto_start_tavern,
        None::<&str>,
    )?;
    let cfg_autorestart_tavern = CheckMenuItem::with_id(
        app,
        MENU_CFG_AUTORESTART_TAVERN,
        l.cfg_autorestart_tavern,
        true,
        cfg.auto_restart_tavern,
        None::<&str>,
    )?;
    let cfg_refs: Vec<&dyn IsMenuItem<Wry>> = vec![
        &cfg_autostart,
        &cfg_start_minimized,
        &cfg_autostart_tavern,
        &cfg_autorestart_tavern,
    ];
    let cfg_submenu = Submenu::with_items(app, l.quick_settings, true, &cfg_refs)?;

    let open_data_dir = MenuItem::with_id(app, MENU_OPEN_DATA_DIR, l.open_data_dir, true, None::<&str>)?;
    let open_log_dir = MenuItem::with_id(app, MENU_OPEN_LOG_DIR, l.open_log_dir, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, l.quit, true, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let sep5 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&show, &sep1, &toggle, &restart];
    if running {
        // 只有服务真的在跑，打开网页 / 复制地址才是有意义的操作
        items.push(&sep2);
        items.push(&open_tavern);
        items.push(&copy_lan);
    }
    items.push(&sep3);
    items.push(&mode_submenu);
    items.push(&cfg_submenu);
    items.push(&sep4);
    items.push(&open_data_dir);
    items.push(&open_log_dir);
    items.push(&sep5);
    items.push(&quit);

    Menu::with_items(app, &items)
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态更新
// ─────────────────────────────────────────────────────────────────────────────

/// 更新「酒馆是否运行」并重建托盘菜单 / 图标。
///
/// 由 sillytavern 模块在进程启动成功与进程退出时调用。
pub fn set_running(app: &AppHandle, running: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.running.store(running, Ordering::SeqCst);
        if !running {
            state.port.store(0, Ordering::SeqCst);
        }
    }
    refresh_menu(app);
}

/// 记录酒馆实际监听端口，用于托盘提示文字
pub fn set_port(app: &AppHandle, port: u16) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.port.store(port, Ordering::SeqCst);
    }
    refresh_menu(app);
}

/// 重建托盘菜单、切换图标与提示文字。
///
/// 读盘取配置在这里是可接受的：菜单刷新只发生在状态切换、用户点菜单、
/// 保存设置这几类低频时机，config.json 也只有几 KB。
pub fn refresh_menu(app: &AppHandle) {
    let app_handle = app.clone();
    // 菜单/托盘操作统一切到主线程，避免跨线程操作原生菜单带来的平台差异
    let _ = app.run_on_main_thread(move || {
        let Some(state) = app_handle.try_state::<TrayState>() else {
            return;
        };
        let tray = {
            let guard = state.icon.lock().unwrap();
            guard.as_ref().cloned()
        };
        let Some(tray) = tray else {
            return;
        };

        let running = state.running.load(Ordering::SeqCst);
        let port = state.port.load(Ordering::SeqCst);
        let cfg = read_app_config_from_disk(&app_handle);
        let lang = get_current_lang(&app_handle);

        match build_menu(&app_handle, running, &cfg, lang) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    tracing::error!("更新托盘菜单失败: {}", e);
                }
            }
            Err(e) => tracing::error!("构建托盘菜单失败: {}", e),
        }

        // 运行中优先用 icon-running.ico，解码失败则退回默认图标。
        // 这里刻意写成 match 而不是 `running_icon().or_else(...)`：
        // `default_window_icon()` 返回的是借用 `app_handle` 的 `&Image`，
        // 而 or_else 会要求闭包返回与接收者同型的 `Image<'static>`，
        // 等于要求一个局部借用活成 'static，编译不过。
        // 分开两次 set_icon 调用则各自独立推导生命周期，没有这个问题。
        let desired_icon = if running { running_icon() } else { None };
        let icon_result = match desired_icon {
            Some(icon) => tray.set_icon(Some(icon)),
            None => tray.set_icon(app_handle.default_window_icon().cloned()),
        };
        if let Err(e) = icon_result {
            tracing::error!("更新托盘图标失败: {}", e);
        }

        let _ = tray.set_tooltip(Some(tooltip_text(lang, running, port)));
    });
}

/// 创建托盘图标；若已创建则仅切换为可见。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<TrayState>();

    let existing = {
        let guard = state.icon.lock().unwrap();
        guard.as_ref().cloned()
    };
    if let Some(tray) = existing {
        let _ = tray.set_visible(true);
        // 图标已存在但可能是隐藏后被重新唤起的，刷新一次保证状态正确
        refresh_menu(app);
        return Ok(());
    }

    let cfg = read_app_config_from_disk(app);
    let lang = get_current_lang(app);
    let menu = build_menu(app, false, &cfg, lang)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip_text(lang, false, 0))
        .menu(&menu)
        // 左键单击与右键一样弹出菜单；唤出主窗口改用双击，避免单击误触
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
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

    // 图标刚建好，补一次刷新把状态（可能在创建前就已运行）同步过来
    refresh_menu(app);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 菜单事件
// ─────────────────────────────────────────────────────────────────────────────

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        MENU_SHOW => show_main_window(app),

        MENU_TOGGLE => {
            // 以 Rust 侧的运行状态为准判定动作，避免与前端状态机出现分歧
            let running = app
                .try_state::<TrayState>()
                .map(|s| s.running.load(Ordering::SeqCst))
                .unwrap_or(false);
            emit(app, EVENT_TRAY_TOGGLE_TAVERN, if running { "stop" } else { "start" });
        }

        MENU_RESTART => emit(app, EVENT_TRAY_RESTART_TAVERN, ()),

        MENU_OPEN_TAVERN => emit(app, EVENT_TRAY_OPEN_TAVERN, ()),
        MENU_COPY_LAN => emit(app, EVENT_TRAY_COPY_LAN_URL, ()),

        MENU_MODE_NORMAL => request_launch_mode(app, "normal"),
        MENU_MODE_DESKTOP => request_launch_mode(app, "desktop"),
        MENU_MODE_LAN => request_launch_mode(app, "lan"),
        MENU_MODE_PUBLIC => request_launch_mode(app, "public"),
        MENU_MODE_DEBUG => request_launch_mode(app, "debug"),

        MENU_CFG_START_MINIMIZED => {
            if let Err(e) =
                crate::config::update_app_config(app, |c| c.start_minimized = !c.start_minimized)
            {
                tracing::error!("保存「启动时最小化到托盘」失败: {}", e);
            }
            refresh_menu(app);
        }
        MENU_CFG_AUTOSTART_TAVERN => {
            if let Err(e) =
                crate::config::update_app_config(app, |c| c.auto_start_tavern = !c.auto_start_tavern)
            {
                tracing::error!("保存「启动时自动启动酒馆」失败: {}", e);
            }
            refresh_menu(app);
        }
        MENU_CFG_AUTORESTART_TAVERN => {
            if let Err(e) = crate::config::update_app_config(app, |c| {
                c.auto_restart_tavern = !c.auto_restart_tavern
            }) {
                tracing::error!("保存「异常退出自动重启」失败: {}", e);
            }
            refresh_menu(app);
        }
        MENU_CFG_AUTOSTART => {
            // 菜单事件跑在主线程上，而注册/注销计划任务要拉起 PowerShell（约 1 秒），
            // 直接同步执行会把界面卡住，所以丢到后台线程去做。
            let handle = app.clone();
            let _ = std::thread::spawn(move || {
                // 开关状态以「计划任务是否真的存在」为准，配置字段只记录界面意图，
                // 避免用户在任务计划程序里手动删掉任务后设置页显示的状态不对
                let enable = !crate::config::autostart_task_exists();
                match crate::config::apply_autostart(enable) {
                    Ok(actual) => {
                        if let Err(e) = crate::config::update_app_config(&handle, |c| {
                            c.auto_start_launcher = actual
                        }) {
                            tracing::error!("保存开机自启状态失败: {}", e);
                        }
                        refresh_menu(&handle);
                    }
                    Err(e) => {
                        tracing::error!("切换开机自启失败: {}", e);
                        // 打开主窗口，让用户能看清失败原因
                        show_main_window(&handle);
                        let _ = handle.emit(crate::config::EVENT_CONFIG_CHANGED, ());
                        let _ = handle.emit(EVENT_TOAST_ERROR, e);
                    }
                }
            });
        }

        MENU_OPEN_DATA_DIR => {
            if let Err(e) = crate::config::open_directory(app.clone(), "data".to_string(), None) {
                tracing::error!("打开数据目录失败: {}", e);
            }
        }
        MENU_OPEN_LOG_DIR => {
            if let Err(e) = crate::config::open_directory(app.clone(), "logs".to_string(), None) {
                tracing::error!("打开日志目录失败: {}", e);
            }
        }

        MENU_QUIT => {
            // 先恢复窗口，保证前端的确认弹窗可见，再交由前端走完整关闭流程
            show_main_window(app);
            emit(app, EVENT_TRAY_QUIT, ());
        }

        _ => {}
    }
}

/// 启动模式变更交给前端处理：公网模式需要二次风险确认，托盘弹不出模态框。
fn request_launch_mode(app: &AppHandle, mode: &str) {
    emit(app, EVENT_TRAY_SET_LAUNCH_MODE, mode.to_string());
}

fn emit<P: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(e) = app.emit(event, payload) {
        tracing::error!("发送托盘事件 {} 失败: {}", event, e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// 隐藏主窗口到托盘
///
/// 由前端点击关闭按钮时调用（前端未授予 `core:window:allow-hide` 权限，
/// 且所有窗口操作统一经由 Rust 后端）。只隐藏窗口，不会停止酒馆进程。
///
/// 若托盘图标不可用则返回错误，前端会退回正常的关闭流程——
/// 否则窗口隐藏后将没有任何入口可以重新唤回。
#[tauri::command]
pub fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    let tray = {
        let state = app.state::<TrayState>();
        let guard = state.icon.lock().unwrap();
        guard.as_ref().cloned()
    };
    let Some(tray) = tray else {
        return Err("系统托盘不可用，已取消最小化到托盘".to_string());
    };

    // 隐藏前确保托盘图标可见，避免窗口"消失"后无法唤回
    if let Err(e) = tray.set_visible(true) {
        return Err(format!("显示托盘图标失败: {e}"));
    }

    let Some(window) = app.get_webview_window("main") else {
        return Err("主窗口不存在".to_string());
    };
    window.hide().map_err(|e| e.to_string())
}
