import { ref } from 'vue'

/**
 * 「关闭软件时最小化到托盘」开关的全局共享状态。
 *
 * 关闭窗口的逻辑分散在自定义标题栏（layouts/Oheader.vue）和全局拦截（App.vue）两处，
 * 都需要同步读取该开关，因此不能只放在 Settings.vue 的局部 ref 里。
 *
 * 初始值取自 localStorage 中的配置缓存，保证首帧即可用；
 * App.vue 启动后会再以 Rust 后端返回的配置为准校正一次。
 */
const CONFIG_CACHE_KEY = 'app_settings_config_cache'

const readCachedValue = (): boolean => {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY)
    if (!raw) return false
    return JSON.parse(raw)?.minimizeToTray === true
  } catch {
    return false
  }
}

/** 是否开启「关闭软件时最小化到托盘」 */
export const minimizeToTray = ref(readCachedValue())

/** 更新开关状态（由设置页与启动时同步调用） */
export const setMinimizeToTray = (value: boolean) => {
  minimizeToTray.value = value === true
}
