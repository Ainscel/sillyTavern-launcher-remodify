import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

const CONFIG_CACHE_KEY = 'app_settings_config_cache'

/** 读取「系统通知」开关（与设置页共用同一份缓存，默认开启） */
const notificationsEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY)
    if (!raw) return true
    return JSON.parse(raw)?.enableNotifications !== false
  } catch {
    return true
  }
}

/**
 * 发送 Windows 系统通知。
 *
 * 窗口隐藏到托盘时界面上的 toast 是看不到的，系统通知是用户唯一能察觉异常的渠道，
 * 因此这里连权限申请失败都只记录日志——通知发不出去不应该影响主流程。
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!notificationsEnabled()) return
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      granted = (await requestPermission()) === 'granted'
    }
    if (granted) {
      sendNotification({ title, body })
    }
  } catch (e) {
    console.error('发送系统通知失败:', e)
  }
}
