<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import Oheader from './layouts/Oheader.vue'
import { Toaster, toast } from 'vue-sonner'
import { invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import GlobalDialog from './components/GlobalDialog.vue'
import InstallDialog from './components/InstallDialog.vue'
import InstallExtensionDialog from './components/InstallExtensionDialog.vue'
import RepairGitDialog from './components/RepairGitDialog.vue'
import CharacterCardDialog from './components/CharacterCardDialog.vue'
import UploadCharacterCardDialog from './components/UploadCharacterCardDialog.vue'
import WorldInfoDialog from './components/WorldInfoDialog.vue'
import UploadWorldInfoDialog from './components/UploadWorldInfoDialog.vue'
import ChatDialog from './components/ChatDialog.vue'
import OneClickCapsule from './components/OneClickCapsule.vue'
import {
  initConsoleState,
  consoleStatus,
  stopProcess,
  restartProcess,
  startProcess,
  autoStartTavernIfNeeded,
  serverUrl,
  networkMode,
  networkPort,
  setConsoleRouter,
} from './lib/consoleState'
import { initDownloadProgressListener } from './lib/useNodeGitInstall'
import { hideToTray, quitApp, confirmQuitWithoutTray } from './lib/appClose'
import { bumpConfigRevision } from './lib/configSync'
import { getPreferredLanIpv4 } from './lib/networkUrl'
import { Dialog } from './lib/useDialog'

const { t } = useI18n()
const router = useRouter()

/** 监听器的注销函数，组件卸载时统一清理 */
const unlisteners: Array<() => void> = []

const CONFIG_CACHE_KEY = 'app_settings_config_cache'

/**
 * 从后端拉取配置，刷新 localStorage 镜像。
 *
 * 启动时必须先跑一次：多处逻辑（自动重启、自动启动酒馆、通知开关）都从这份镜像读配置，
 * 而镜像原本只有「用户打开过设置页」之后才会生成——否则全新安装时这些开关全部读不到。
 */
const syncConfigFromBackend = async (): Promise<Record<string, unknown> | null> => {
  try {
    const cfg = await invoke<Record<string, unknown>>('get_app_config')
    const cached = localStorage.getItem(CONFIG_CACHE_KEY)
    const base = cached ? JSON.parse(cached) : {}
    localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ...base, ...cfg }))
    return cfg
  } catch (e) {
    console.error('同步后端配置失败:', e)
    return null
  }
}

/** 取酒馆当前监听端口：网络模式用后端给的值，否则从地址里解析 */
const resolveTavernPort = (): number => {
  if (networkMode.value !== null) return networkPort.value
  const matched = serverUrl.value.match(/:(\d+)/)
  return matched ? Number.parseInt(matched[1], 10) : networkPort.value
}

/** 托盘菜单「打开酒馆网页」 */
const handleOpenTavern = async () => {
  if (!serverUrl.value) {
    toast.warning(t('tray.notRunning'))
    return
  }
  try {
    await openUrl(serverUrl.value)
  } catch (e) {
    console.error('打开酒馆网页失败:', e)
    toast.error(t('tray.openFailed'))
  }
}

/** 托盘菜单「复制局域网网址」 */
const handleCopyLanUrl = async () => {
  if (consoleStatus.value !== 2) {
    toast.warning(t('tray.notRunning'))
    return
  }
  const lanIp = await getPreferredLanIpv4()
  const url = `http://${lanIp ?? 'localhost'}:${resolveTavernPort()}`
  try {
    await writeText(url)
    toast.success(t('tray.lanUrlCopied', { url }))
  } catch (e) {
    console.error('复制局域网网址失败:', e)
    toast.error(t('tray.copyFailed'))
  }
}

/**
 * 托盘菜单切换启动模式。
 *
 * 公网模式的二次风险确认在设置页里，托盘弹不出它的模态框，
 * 所以这里用原生确认框把同样的风险讲清楚；用户拒绝就什么都不做，
 * 托盘菜单会重新按磁盘上的旧值渲染，不会出现「显示已选中但其实没生效」。
 */
const handleSetLaunchMode = async (mode: string) => {
  if (mode === 'public') {
    // 托盘弹不出设置页那个自定义风险弹窗，用原生确认框把同样的风险讲清楚
    const risks = ['publicModeRisk1', 'publicModeRisk2', 'publicModeRisk3', 'publicModeRisk4']
      .map(key => `· ${t(`settings.${key}`)}`)
      .join('\n')
    const yes = await confirm(
      `${t('settings.publicModeWarningDesc')}\n\n${risks}\n\n${t('settings.publicModeAdvice')}`,
      {
        title: t('settings.publicModeWarningTitle'),
        kind: 'warning',
        okLabel: t('settings.publicModeConfirm'),
        cancelLabel: t('settings.publicModeCancel'),
      },
    )
    if (!yes) return
  }

  try {
    await invoke('set_launch_mode', { mode })
    toast.success(t('tray.launchModeChanged', { mode: t(`settings.launchMode${modeNameKey(mode)}`) }))
    if (consoleStatus.value === 2) {
      // 启动模式只在启动时读取，运行中改了要重启才生效
      Dialog.warning({
        title: t('common.warning'),
        msg: t('tray.launchModeNeedRestart'),
        showCancel: true,
        confirmText: t('tray.restartNow'),
        cancelText: t('common.cancel'),
        onConfirm: () => {
          void restartProcess()
        },
      })
    }
  } catch (e) {
    console.error('切换启动模式失败:', e)
    toast.error(String(e))
  }
}

/** normal → Normal，用于拼 i18n key */
const modeNameKey = (mode: string) => mode.charAt(0).toUpperCase() + mode.slice(1)

onMounted(async () => {
  // 全局注册 Git/Node 下载进度监听（只注册一次，页面切换不会丢失进度）
  initDownloadProgressListener().catch(console.error)

  // 注入 router 到 consoleState，供版本检查跳转使用
  setConsoleRouter(router)

  await initConsoleState()

  // 启动时先把后端配置同步到本地镜像，「关闭时最小化到托盘」等开关的首帧行为都依赖它
  await syncConfigFromBackend()

  // 后端侧改了配置（主要是托盘菜单），刷新本地镜像并通知设置页重载
  unlisteners.push(
    await listen('app-config-changed', async () => {
      await syncConfigFromBackend()
      bumpConfigRevision()
    }),
  )

  // 后端侧操作失败（如注册开机自启失败）时弹一条提示
  unlisteners.push(
    await listen<string>('app-toast-error', event => {
      toast.error(event.payload)
    }),
  )

  // ─── 托盘菜单事件 ────────────────────────────────────────────────────────
  // 托盘只负责发意图，实际动作都在前端走既有流程（状态机、确认弹窗、依赖修复）
  unlisteners.push(
    await listen<'start' | 'stop'>('tray-toggle-tavern', async event => {
      if (event.payload === 'stop') {
        await stopProcess()
      } else {
        await startProcess()
      }
    }),
  )
  unlisteners.push(
    await listen('tray-restart-tavern', () => {
      void restartProcess()
    }),
  )
  unlisteners.push(await listen('tray-open-tavern', () => void handleOpenTavern()))
  unlisteners.push(await listen('tray-copy-lan-url', () => void handleCopyLanUrl()))
  unlisteners.push(await listen<string>('tray-set-launch-mode', event => void handleSetLaunchMode(event.payload)))

  // 关闭窗口一律改为隐藏到托盘，绝不退出程序。
  //
  // 标题栏的 X、Alt+Tab 窗口列表里的关闭、任务栏右键关闭、Alt+F4，
  // 最终都会走到这个 onCloseRequested——放在 App.vue 而不是标题栏组件里，
  // 就是为了把这些入口全部覆盖到。真正退出只认托盘菜单的「退出」。
  const appWindow = getCurrentWindow()
  appWindow.onCloseRequested(async event => {
    event.preventDefault()
    // preventDefault 必须同步调用，隐藏则是异步的，所以顺序不能颠倒
    const hidden = await hideToTray()
    if (!hidden) {
      // 托盘不可用：窗口藏起来就没有唤回入口了，只能让用户选择直接退出
      confirmQuitWithoutTray()
    }
  })

  // 托盘菜单「退出」：后端已先把窗口恢复出来，保证确认弹窗可见
  unlisteners.push(
    await listen('tray-quit-requested', () => {
      void quitApp()
    }),
  )

  // 检查是否已经在运行
  try {
    const isRunning = await invoke<boolean>('check_sillytavern_status')
    if (isRunning && consoleStatus.value === 0) {
      consoleStatus.value = 2 // 假设运行中
    }
  } catch (e) {
    console.error(e)
  }

  // 酒馆就绪（后端做真实端口探测后发出）：桌面程序模式下打开子窗口
  unlisteners.push(
    await listen<{ url: string; port: number; mode: string }>('tavern-ready', event => {
      if (event.payload.mode !== 'desktop') return
      invoke('open_tavern_desktop_window', { url: event.payload.url }).catch(e => {
        console.error('打开桌面程序窗口失败:', e)
      })
    }),
  )

  // 设置项「启动时自动启动酒馆」：事件监听已全部注册完毕，此时再拉起才不会漏事件
  await autoStartTavernIfNeeded()
})

onUnmounted(() => {
  unlisteners.forEach(unlisten => unlisten())
  unlisteners.length = 0
})
</script>

<template>
  <Oheader>
    <!-- 页面区域 -->
    <router-view />

    <!-- 弹窗/全局消息区域 -->
    <template #Modal>
      <!-- 全局确认框 -->
      <GlobalDialog />
      <!-- 安装进度框 -->
      <InstallDialog />
      <!-- 扩展安装框 -->
      <InstallExtensionDialog />
      <!-- Git 修复日志框 -->
      <RepairGitDialog />
      <CharacterCardDialog />
      <!-- 角色卡导入框 -->
      <UploadCharacterCardDialog />
      <!-- 世界书详情弹窗 -->
      <WorldInfoDialog />
      <!-- 世界书导入框 -->
      <UploadWorldInfoDialog />
      <!-- 对话历史预览弹窗 -->
      <ChatDialog />

      <!-- 一键安装悬浮球 -->
      <OneClickCapsule />
    </template>
    <Toaster />
  </Oheader>
</template>

<style scoped></style>
