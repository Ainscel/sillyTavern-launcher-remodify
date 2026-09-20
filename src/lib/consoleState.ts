import { reactive, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'vue-sonner'
import i18n from '../lang'
import { initReleases } from './useReleases'
import { useRouter } from 'vue-router'
import { notify } from './notify'

// 路由实例（由外部设置，避免循环依赖）
let _router: ReturnType<typeof useRouter> | null = null
export function setConsoleRouter(router: ReturnType<typeof useRouter>) {
  _router = router
}

/**
 * 根据酒馆版本计算所需的最低 Node.js 主版本号
 * - ST >= 1.17.0 需要 Node v20+
 * - ST < 1.17.0 需要 Node v18+
 */
function getRequiredNodeMajor(tavernVersion: string | null): number {
  if (!tavernVersion) return 18
  // 解析版本号，支持 "1.17.0" 或 "v1.17.0" 格式
  const match = tavernVersion.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return 18
  const major = parseInt(match[1], 10)
  const minor = parseInt(match[2], 10)
  // >= 1.17.0
  if (major > 1 || (major === 1 && minor >= 17)) return 20
  return 18
}

/**
 * 检查当前 Node.js 版本是否满足酒馆版本要求
 * 返回 { ok, requiredMajor, currentMajor }
 */
function checkNodeCompatibility(): {
  ok: boolean
  requiredMajor: number
  currentMajor: number | null
} {
  try {
    // 读取 Node 信息
    const nodeCache = localStorage.getItem('app_settings_node_cache')
    const nodeInfo = nodeCache ? JSON.parse(nodeCache) : null
    const nodeVersion: string | null = nodeInfo?.version || null
    const nodeSource: string = nodeInfo?.source || 'none'

    // 读取酒馆版本
    const configCache = localStorage.getItem('app_settings_config_cache')
    let tavernVersion: string | null = null
    if (configCache) {
      const config = JSON.parse(configCache)
      tavernVersion = config?.sillytavern?.version?.version || null
    }

    const requiredMajor = getRequiredNodeMajor(tavernVersion)

    if (!nodeVersion || nodeSource === 'none') {
      return { ok: false, requiredMajor, currentMajor: null }
    }

    const match = nodeVersion.match(/v?(\d+)\./)
    const currentMajor = match ? parseInt(match[1], 10) : null

    if (currentMajor === null) return { ok: false, requiredMajor, currentMajor: null }

    // 系统 Node 不满足要求时，视为不可用（将使用内置 Node）
    // 如果是内置 Node（local），也要检查版本
    return { ok: currentMajor >= requiredMajor, requiredMajor, currentMajor }
  } catch (e) {
    console.error('检查 Node 版本兼容性失败:', e)
    return { ok: true, requiredMajor: 18, currentMajor: null } // 出错时不阻止启动
  }
}

export type LogType = 'info' | 'success' | 'error' | 'output' | 'system'

export interface LogEntry {
  id: number
  type: LogType
  text: string
  time: number
}

// 0: 未启动, 1: 启动中, 2: 运行中, 3: 已停止, 4: 启动失败/异常
export const consoleStatus = ref(0)
export const consoleLogs = reactive<LogEntry[]>([])
export const serverUrl = ref('')
export const processPid = ref<number | null>(null)
// 网络服务模式信息（lan/public 模式启动成功后填充）
export const networkMode = ref<'lan' | 'public' | null>(null)
export const networkPort = ref<number>(8000)
// 公网服务 session 计数：每次 public 模式的酒馆启动成功时 +1，用于检测结果缓存
export const publicSessionId = ref<number>(0)
// 当前启动模式（从 config 读取，启动时更新，停止时重置）
export const launchMode = ref<string>('normal')

let nextId = 0
let isIntentionalStop = false

/** 本次启动是否由「自动」触发（开机自启、启动器自动拉起、崩溃后自动重启） */
let currentStartIsAuto = false

// ─── 异常退出自动重启 ────────────────────────────────────────────────────────
// 酒馆起不来时（端口被占、依赖装坏、Node 版本不对……）如果无脑重启，
// 会退化成一个疯狂拉起 node 的死循环。三重限制兜底：
//   1. 连续自动重启不超过 MAX_AUTO_RESTARTS 次；
//   2. 每次间隔指数退避（3s → 6s → 12s，上限 30s）；
//   3. 只要某次进程稳定运行超过 HEALTHY_UPTIME_MS，就清零计数、重新获得额度——
//      这区分了「起不来」和「跑了一阵才崩」，后者不该被限制次数。
const MAX_AUTO_RESTARTS = 3
const HEALTHY_UPTIME_MS = 60_000
const AUTO_RESTART_BASE_DELAY_MS = 3_000
const AUTO_RESTART_MAX_DELAY_MS = 30_000

let restartAttempts = 0
/** 本次进程的启动时刻，用于判断「是否稳定运行过」 */
let processStartedAt = 0
let autoRestartTimer: ReturnType<typeof setTimeout> | null = null

/** `process-exit` 的等待者，由重启流程注册 */
let exitWaiters: Array<() => void> = []

/** 等待酒馆进程真正退出；超时则放弃等待，避免流程被卡死 */
function waitForProcessExit(timeoutMs = 8000): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      exitWaiters = exitWaiters.filter(w => w !== finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    exitWaiters.push(finish)
  })
}

function resolveExitWaiters() {
  const waiters = exitWaiters
  exitWaiters = []
  waiters.forEach(w => w())
}

/** 读取设置页写入的配置缓存（与 Settings.vue 共用同一份 localStorage 镜像） */
function readConfigCache(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem('app_settings_config_cache')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function cancelAutoRestart() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer)
    autoRestartTimer = null
  }
}

/** 手动启停时调用：清空重试计数，重新给满额度 */
function resetAutoRestart() {
  restartAttempts = 0
  cancelAutoRestart()
}

/** 按需安排一次自动重启；达到上限则放弃并告知用户 */
function scheduleAutoRestart() {
  if (readConfigCache()?.autoRestartTavern !== true) return
  // 已经有排队的重启就不重复安排
  if (autoRestartTimer) return

  // 稳定跑过一段时间的崩溃属于「偶发」，不该消耗连续重试额度
  if (processStartedAt && Date.now() - processStartedAt >= HEALTHY_UPTIME_MS) {
    restartAttempts = 0
  }

  if (restartAttempts >= MAX_AUTO_RESTARTS) {
    const msg = i18n.global.t('console.autoRestartGaveUp', { count: MAX_AUTO_RESTARTS })
    addLog('error', msg)
    toast.error(msg)
    notify(i18n.global.t('console.notifyAbnormalTitle'), msg)
    return
  }

  restartAttempts += 1
  const delay = Math.min(AUTO_RESTART_BASE_DELAY_MS * 2 ** (restartAttempts - 1), AUTO_RESTART_MAX_DELAY_MS)
  const seconds = Math.round(delay / 1000)
  const msg = i18n.global.t('console.autoRestartScheduled', {
    seconds,
    attempt: restartAttempts,
    max: MAX_AUTO_RESTARTS,
  })
  addLog('system', msg)
  notify(i18n.global.t('console.notifyAbnormalTitle'), msg)

  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null
    void startProcess({ auto: true })
  }, delay)
}

export function addLog(type: LogType, text: string) {
  // 移除可能存在的 ANSI 转义字符
  const cleanText = text.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '') // eslint-disable-line no-control-regex
  consoleLogs.push({
    id: nextId++,
    type,
    text: cleanText,
    time: Date.now(),
  })

  // 限制日志条数，防止内存泄漏（最多保留2000条日志）
  if (consoleLogs.length > 2000) {
    consoleLogs.splice(0, consoleLogs.length - 2000)
  }
}

export function clearLogs() {
  consoleLogs.splice(0, consoleLogs.length)
}

/**
 * 启动酒馆。
 *
 * @param options.auto 是否由自动流程触发（开机自启、启动器自动拉起、崩溃后自动重启）。
 *                     自动触发时不弹「启动成功」系统通知，也不消耗/重置重试计数。
 */
export async function startProcess(options: { auto?: boolean } = {}) {
  if (consoleStatus.value === 1 || consoleStatus.value === 2) return

  // 检查 Node.js 版本是否满足当前酒馆版本要求
  const { ok, requiredMajor, currentMajor } = checkNodeCompatibility()
  if (!ok) {
    const msg = i18n.global.t('console.nodeVersionInsufficient', {
      required: `v${requiredMajor}`,
      current: currentMajor !== null ? `v${currentMajor}` : i18n.global.t('home.notInstalled'),
    })
    if (options.auto) {
      // 自动流程下跳转设置页只会打扰用户，且重试也没意义，直接记日志停下
      addLog('error', msg)
      return
    }
    toast.warning(msg, { duration: 5000 })
    // 跳转到设置页触发内置 Node 安装
    if (_router) {
      setTimeout(() => {
        _router!.push('/settings?action=install_node')
      }, 800)
    }
    return
  }

  currentStartIsAuto = options.auto === true
  if (!currentStartIsAuto) {
    // 手动启动视为新的开始，之前的失败计数作废
    resetAutoRestart()
  } else {
    cancelAutoRestart()
  }

  // 从 config 缓存读取当前启动模式
  const configCache = localStorage.getItem('app_settings_config_cache')
  if (configCache) {
    try {
      const cfg = JSON.parse(configCache)
      launchMode.value = cfg?.launchMode || 'normal'
    } catch {
      launchMode.value = 'normal'
    }
  } else {
    launchMode.value = 'normal'
  }

  clearLogs()
  consoleStatus.value = 1
  serverUrl.value = ''
  processPid.value = null
  isIntentionalStop = false
  networkMode.value = null
  networkPort.value = 8000
  processStartedAt = Date.now()
  addLog('system', i18n.global.t('console.initializing'))

  try {
    await invoke('start_sillytavern')
    addLog('success', i18n.global.t('console.startSent'))
  } catch (error: any) {
    consoleStatus.value = 4
    addLog('error', i18n.global.t('console.startError', { error }))
    toast.error(i18n.global.t('console.startError', { error }))
    // 启动就失败（端口被占、文件缺失等）同样算「起不来」，走自动重启退避
    scheduleAutoRestart()
  }
}

export async function stopProcess() {
  // 取消排队中的自动重启、清空失败计数必须在提前返回之前：
  // 状态为 4（启动失败）时正有一个重启定时器在路上，此时用户点停止却直接 return
  // 的话，定时器仍会触发，酒馆会被莫名其妙地重新拉起。
  resetAutoRestart()

  if (consoleStatus.value === 0 || consoleStatus.value === 3 || consoleStatus.value === 4) return

  try {
    isIntentionalStop = true
    await invoke('stop_sillytavern')
    addLog('system', i18n.global.t('console.stopping'))
    consoleStatus.value = 3
    processPid.value = null
  } catch (error: any) {
    toast.error(i18n.global.t('console.stopError', { error }))
  }
}

/**
 * 启动器启动后自动拉起酒馆（设置项「启动时自动启动酒馆」）。
 *
 * 刻意放在前端挂载完成后再触发，而不是 Rust 在 setup 阶段启动：
 * 只有事件监听注册好之后再启动，`tavern-ready` 之类的通知才不会发进真空里。
 */
export async function autoStartTavernIfNeeded() {
  if (readConfigCache()?.autoStartTavern !== true) return
  if (consoleStatus.value === 1 || consoleStatus.value === 2) return
  await startProcess({ auto: true })
}

/**
 * 重启酒馆：停止后重新启动（托盘菜单用，切换启动模式后需要重启才生效）。
 *
 * 必须等进程真正退出再拉起——端口还没释放时新进程会直接起不来。
 * 这里等的是 `process-exit` 事件而不是固定延时：
 * 延时太短会撞上端口未释放，太长又会让用户觉得卡顿。
 */
export async function restartProcess() {
  if (consoleStatus.value === 1 || consoleStatus.value === 2) {
    // 必须先把等待者挂上再发停止命令：`process-exit` 是另一条 IPC 消息，
    // 很可能在 `stop_sillytavern` 返回之前就送到了，那时再注册就只能干等到超时。
    const exited = waitForProcessExit()
    await stopProcess()
    await exited
  }
  await startProcess()
}

// 预加载 GitHub 加速列表
const preloadGithubProxies = async () => {
  try {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
    const lastFetchTime = localStorage.getItem('app_settings_proxies_last_fetch')
    const now = Date.now()

    // 如果没有缓存或者缓存已过期，则预加载
    if (!lastFetchTime || now - Number(lastFetchTime) >= THREE_DAYS_MS) {
      await invoke('fetch_github_proxies')
      localStorage.setItem('app_settings_proxies_last_fetch', now.toString())
    }
  } catch (error) {
    // 静默失败，不影响启动
    console.error('预加载 GitHub 加速列表失败:', error)
  }
}

let isInitialized = false
export async function initConsoleState() {
  if (isInitialized) return
  isInitialized = true

  setTimeout(() => {
    initReleases()
    preloadGithubProxies()
  }, 2000)

  await listen<string>('process-log', event => {
    const text = event.payload
    let type: LogType = 'output'
    if (text.startsWith('ERROR:')) type = 'error'
    else if (text.startsWith('INFO:')) type = 'info'

    addLog(type, text.replace(/^(INFO|ERROR):\s*/, ''))

    const pidMatch = text.match(/PID:\s*(\d+)/i)
    if (pidMatch) {
      processPid.value = parseInt(pidMatch[1], 10)
    }
  })

  // 酒馆就绪：由后端对真实端口做 TCP 探测后发出。
  // 取代了原先「匹配日志里的英文 listening 字样」的判断——那样在中文语言环境下会失效。
  await listen<{ url: string; port: number; mode: string }>('tavern-ready', event => {
    const { url, port, mode } = event.payload
    consoleStatus.value = 2
    serverUrl.value = url
    launchMode.value = mode || 'normal'
    addLog('success', i18n.global.t('console.tavernReady', { port }))
    if (mode === 'lan' || mode === 'public') {
      networkMode.value = mode
      networkPort.value = port
      if (mode === 'public') {
        publicSessionId.value += 1
      }
    }

    // 自动启动（开机自启 / 自动拉起 / 崩溃重启）不提示「启动成功」，
    // 否则每次开机都会被一条没有信息量的通知打扰；异常相关的通知仍然保留。
    if (!currentStartIsAuto) {
      notify(i18n.global.t('console.notifyReadyTitle'), i18n.global.t('console.notifyReadyBody', { url, port }))
    }
  })

  // 探测超时：进程还在但迟迟连不上，多半是酒馆启动卡住了
  await listen('tavern-ready-timeout', () => {
    const msg = i18n.global.t('console.readyTimeout')
    addLog('error', msg)
    toast.warning(msg, { duration: 6000 })
    // 窗口藏在托盘里时 toast 是看不见的，只有系统通知能把人叫过来
    notify(i18n.global.t('console.notifyAbnormalTitle'), msg)
  })

  // 桌面程序模式关闭子窗口时提前标记为主动停止，避免后续 process-exit 被误判为异常退出
  await listen('process-intentional-stop', () => {
    isIntentionalStop = true
  })

  await listen('process-exit', () => {
    // 先唤醒等待退出的流程（重启酒馆），再改状态
    resolveExitWaiters()

    const abnormal = !isIntentionalStop && (consoleStatus.value === 1 || consoleStatus.value === 2)
    if (abnormal) {
      consoleStatus.value = 4
      addLog('error', i18n.global.t('console.processAbnormalExit'))
      notify(i18n.global.t('console.notifyAbnormalTitle'), i18n.global.t('console.processAbnormalExit'))
    } else {
      consoleStatus.value = 3
      addLog('system', i18n.global.t('console.processExited'))
    }
    processPid.value = null
    networkMode.value = null
    networkPort.value = 8000
    launchMode.value = 'normal'

    if (abnormal) {
      scheduleAutoRestart()
    }
  })

  // ─── 运行时缺失依赖自动修复 ──────────────────────────────────────────────
  // 当酒馆 stderr 检测到 MODULE_NOT_FOUND 时，Rust 端发此事件
  await listen<{ packages: string[]; st_dir: string }>('tavern-missing-dep', async event => {
    const { packages, st_dir } = event.payload
    if (!packages || packages.length === 0) return

    addLog('error', i18n.global.t('console.missingDepDetected', { packages: packages.join(', ') }))

    // 先标记当前是主动停止，等进程自然退出后不触发「异常退出」提示
    isIntentionalStop = true

    try {
      await invoke('repair_missing_deps', { packages, stDir: st_dir })
      // repair_missing_deps 成功后会 emit tavern-dep-repaired，由下面的监听触发重启
    } catch (err: any) {
      addLog('error', i18n.global.t('console.missingDepRepairFailed', { error: err }))
      toast.error(i18n.global.t('console.missingDepRepairFailed', { error: err }))
      // 修复失败时把状态置为异常，让用户手动处理
      consoleStatus.value = 4
      isIntentionalStop = false
    }
  })

  // 修复成功后自动重启
  await listen('tavern-dep-repaired', async () => {
    addLog('system', i18n.global.t('console.missingDepRepaired'))
    // 短暂延迟，确保进程已完全退出
    await new Promise(r => setTimeout(r, 1500))
    // 属于自动流程，不提示「启动成功」
    await startProcess({ auto: true })
  })
  // ─────────────────────────────────────────────────────────────────────────
}
