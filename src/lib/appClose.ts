import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18n from '../lang'
import { installState, resetInstallState } from './useInstall'
import { oneClickState, finishOneClickSetup } from './useOneClick'
import { Dialog } from './useDialog'
import { consoleStatus, stopProcess } from './consoleState'

/**
 * 应用的关闭行为统一收在这里。
 *
 * 本启动器常驻系统托盘，托盘图标是可以随时唤回界面的入口，
 * 因此**任何**关闭窗口的动作（标题栏的 X、Alt+Tab 窗口列表的关闭、任务栏右键关闭、
 * Alt+F4）都只把窗口藏到托盘，不退出程序；唯一真正的退出入口是托盘菜单的「退出」。
 *
 * 这样设计的好处是不会有「点错了就把正在跑的酒馆连同安装任务一起关掉」的意外。
 */

const t = (key: string) => i18n.global.t(key)

/**
 * 把主窗口隐藏到系统托盘。不触碰酒馆进程，也不打断进行中的安装/下载。
 *
 * @returns 是否隐藏成功。托盘不可用时后端会拒绝隐藏，此时窗口**不能**消失——
 *          否则用户既唤不回界面、也没有退出入口。
 */
export async function hideToTray(): Promise<boolean> {
  try {
    await invoke('hide_main_window_to_tray')
    return true
  } catch (e) {
    console.error('隐藏到托盘失败:', e)
    return false
  }
}

/** 停止酒馆服务；失败也不阻断退出流程 */
async function stopTavernQuietly(): Promise<void> {
  try {
    await stopProcess()
  } catch (e) {
    console.error('退出前停止酒馆失败:', e)
  }
}

/** 收尾并销毁窗口，走完退出流程 */
async function doQuit(): Promise<void> {
  await stopTavernQuietly()
  await getCurrentWindow().destroy()
}

/**
 * 托盘不可用时的兜底。
 *
 * 此时「关闭 = 隐藏」这条规则没法成立（隐藏了就再也唤不回来），
 * 而托盘菜单又是唯一的退出入口——必须给用户留一条退路，
 * 否则程序会变成关不掉也退不了的僵局。
 */
export function confirmQuitWithoutTray(): void {
  Dialog.warning({
    title: t('common.warning'),
    msg: t('tray.unavailableDesc'),
    showCancel: true,
    confirmText: t('tray.quitAnyway'),
    cancelText: t('common.cancel'),
    onConfirm: doQuit,
  })
}

/**
 * 真正退出应用，只应由托盘菜单的「退出」触发。
 *
 * 退出前要把可能造成损失的事情处理掉：进行中的安装/下载拦一道确认，
 * 正在运行的酒馆先停掉。
 */
export async function quitApp(): Promise<void> {
  const isRunningTask =
    (installState.show && ['downloading', 'extracting', 'installing', 'deleting'].includes(installState.status)) ||
    oneClickState.isActive

  if (isRunningTask) {
    Dialog.warning({
      title: t('common.warning'),
      msg:
        i18n.global.locale.value === 'zh-CN'
          ? '自动化流程或安装任务正在进行中。强制关闭将中断所有进度并退回初始状态，确定要关闭吗？'
          : 'Automation or installation tasks are running. Force closing will interrupt all progress and reset to the initial state. Are you sure you want to close?',
      showCancel: true,
      confirmText: i18n.global.locale.value === 'zh-CN' ? '确认关闭' : 'Force Close',
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        try {
          await invoke('cancel_install')
        } catch (e) {
          console.error(e)
        }
        resetInstallState()
        if (oneClickState.isActive) {
          finishOneClickSetup()
        }
        await doQuit()
      },
    })
    return
  }

  // 酒馆还在跑：退出会连带把它停掉，问一句更稳妥
  if (consoleStatus.value === 1 || consoleStatus.value === 2) {
    Dialog.warning({
      title: t('home.confirmClose'),
      msg: t('home.tavernIsRunningCloseApp'),
      showCancel: true,
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onConfirm: doQuit,
    })
    return
  }

  await doQuit()
}
