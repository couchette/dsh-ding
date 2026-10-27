/**
 * dsh-ding 的决策层：配置归一化、会话/事件过滤、提示调度、平台播放命令构造。
 *
 * 这一层不 import 任何 DSH 服务或 Node 运行时对象，计时器与播放函数都可注入，
 * 因此可以用 `node --test` 直接验证；`lib/index.js` 只负责把 DSH 的 ctx 事件
 * 接到这里，并真正 spawn 系统命令。
 *
 * 触发面（默认全开）：
 * 1. 顶层会话 `turn/end` 且 reason.kind 为 completed / error —— 延迟
 *    continuationGraceMs 后响；若同一会话紧接着开启新轮次（goal 自动续跑），取消。
 * 2. 顶层会话 `approval/asked` —— 延迟 approvalGraceMs 后仍未被
 *    `approval/decided` 解决才响（自动放行的审批不会响）。
 * 3. `tool/call` 的工具名命中 questionToolNames（默认 ask_user_question /
 *    exit_plan_mode）—— 立即响。
 *
 * 子代理/团队成员会话（header.origin === 'subagent'、有 parentSession、
 * delegationDepth > 0）默认不响，避免团队协作时连环响铃。
 *
 * @module dsh-ding/decide
 */

/** 可通过 profile 的 cordis.patch.yml 覆盖的默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关。 */
  enabled: true,
  /** 是否也给子代理/团队成员会话响（默认只响顶层会话）。 */
  includeSubagents: false,
  /** 四类触发分别的开关。 */
  notify: Object.freeze({
    turnCompleted: true,
    turnError: true,
    approval: true,
    question: true,
  }),
  /** 视为「向用户提问」的工具名。 */
  questionToolNames: Object.freeze(['ask_user_question', 'exit_plan_mode']),
  /** 等审批存活多久仍未决才响（毫秒）。 */
  approvalGraceMs: 400,
  /** turn/end 后等多久没有新轮次才开始响（毫秒）。 */
  continuationGraceMs: 900,
  /** 两次响铃之间的最小间隔（毫秒），防止多会话/多事件连响。 */
  minIntervalMs: 600,
  /** `'system'` 表示当前系统提示音；其他值为自定义音频的绝对路径。 */
  sound: 'system',
  /** 自定义音频的播放音量（0–1，仅 afplay 路径生效）。 */
  volume: undefined,
  /** 是否把加载/触发/失败写进 debugLogPath。 */
  debug: false,
  /** debug 日志的绝对路径；留空用 `$DSH_HOME/dsh-ding.log`。 */
  debugLogPath: '',
})

const BOOLEAN_KEYS = ['enabled', 'includeSubagents', 'debug']
const NOTIFY_KEYS = ['turnCompleted', 'turnError', 'approval', 'question']
const DURATION_KEYS = ['approvalGraceMs', 'continuationGraceMs', 'minIntervalMs']

/**
 * 把 profile 传入的原始配置归一化成可用的完整配置。
 *
 * 配置错误直接抛 TypeError（让插件在加载期失败，而不是带病运行），
 * 错误信息里写明是哪个字段。
 *
 * @param {unknown} raw - YAML 里的 config 对象。
 * @returns {typeof DEFAULT_CONFIG & { notify: Record<string, boolean>, questionToolNames: string[] }} 归一化配置。
 * @throws {TypeError} 字段类型不合法时。
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-ding: config 必须是对象')
  }

  const notifyRaw = raw.notify === undefined ? {} : raw.notify
  if (typeof notifyRaw !== 'object' || notifyRaw === null || Array.isArray(notifyRaw)) {
    throw new TypeError('dsh-ding: config.notify 必须是对象')
  }

  const config = {
    enabled: DEFAULT_CONFIG.enabled,
    includeSubagents: DEFAULT_CONFIG.includeSubagents,
    notify: { ...DEFAULT_CONFIG.notify },
    questionToolNames: [...DEFAULT_CONFIG.questionToolNames],
    approvalGraceMs: DEFAULT_CONFIG.approvalGraceMs,
    continuationGraceMs: DEFAULT_CONFIG.continuationGraceMs,
    minIntervalMs: DEFAULT_CONFIG.minIntervalMs,
    sound: DEFAULT_CONFIG.sound,
    volume: undefined,
    debug: DEFAULT_CONFIG.debug,
    debugLogPath: DEFAULT_CONFIG.debugLogPath,
  }

  for (const key of BOOLEAN_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new TypeError(`dsh-ding: config.${key} 必须是布尔值`)
    config[key] = value
  }

  for (const key of NOTIFY_KEYS) {
    const value = notifyRaw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new TypeError(`dsh-ding: config.notify.${key} 必须是布尔值`)
    config.notify[key] = value
  }

  for (const key of DURATION_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`dsh-ding: config.${key} 必须是非负数字（毫秒）`)
    }
    config[key] = value
  }

  if (raw.questionToolNames !== undefined) {
    const names = raw.questionToolNames
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name.trim() === '')) {
      throw new TypeError('dsh-ding: config.questionToolNames 必须是非空字符串数组')
    }
    config.questionToolNames = [...new Set(names.map((name) => name.trim()))]
  }

  if (raw.sound !== undefined) {
    if (typeof raw.sound !== 'string' || raw.sound.trim() === '') {
      throw new TypeError("dsh-ding: config.sound 必须是 'system' 或音频文件绝对路径")
    }
    config.sound = raw.sound.trim()
  }

  if (raw.volume !== undefined) {
    if (typeof raw.volume !== 'number' || !Number.isFinite(raw.volume) || raw.volume < 0 || raw.volume > 1) {
      throw new TypeError('dsh-ding: config.volume 必须是 0–1 之间的数字')
    }
    config.volume = raw.volume
  }

  if (raw.debugLogPath !== undefined) {
    if (typeof raw.debugLogPath !== 'string') throw new TypeError('dsh-ding: config.debugLogPath 必须是字符串')
    config.debugLogPath = raw.debugLogPath
  }

  return config
}

/**
 * 是否顶层会话（不是子代理、不是团队成员）。
 *
 * 依据 Session.header 的 durable 字段：`origin === 'subagent'`、存在
 * `parentSession`、或 `delegationDepth > 0` 都视为派生会话。header 缺失时
 * 按顶层处理（宁可响，不静默丢通知）。
 *
 * @param {{ header?: { origin?: string, parentSession?: unknown, delegationDepth?: number } }} session - 会话对象。
 * @returns {boolean} 顶层会话返回 true。
 */
export function isTopLevelSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return true
  if (header.origin === 'subagent') return false
  if (header.parentSession !== undefined && header.parentSession !== null) return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return true
}

/**
 * 生成一个播放器描述。
 *
 * macOS 默认走 `osascript -e beep`（系统设置的警示音）；自定义音频走 afplay。
 * Windows 默认走 `System.Media.SystemSounds::Asterisk`；Linux 默认走
 * canberra-gtk-play。未知平台返回 null（插件只会记日志，不抛错）。
 *
 * @param {{ platform?: string, sound?: string, volume?: number }} [options] - 平台与音频选项。
 * @returns {{ command: string, args: string[], label: string } | null} 播放器描述。
 */
export function resolvePlayer(options = {}) {
  const platform = options.platform ?? process.platform
  const sound = options.sound ?? 'system'
  const volume = options.volume
  const custom = sound !== 'system'
  const withVolume = (args) => (typeof volume === 'number' ? ['-v', String(volume), ...args] : args)

  if (platform === 'darwin') {
    if (!custom) return { command: '/usr/bin/osascript', args: ['-e', 'beep'], label: 'macOS 系统警示音' }
    return { command: '/usr/bin/afplay', args: withVolume([sound]), label: sound }
  }

  if (platform === 'win32') {
    if (!custom) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()'],
        label: 'Windows 系统提示音',
      }
    }
    if (sound.includes("'")) return null // 不拼不可控的 PowerShell 字符串
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${sound}').PlaySync()`],
      label: sound,
    }
  }

  if (platform === 'linux') {
    if (!custom) return { command: 'canberra-gtk-play', args: ['-i', 'complete'], label: 'Linux 桌面提示音' }
    return { command: 'paplay', args: [sound], label: sound }
  }

  return null
}

/**
 * 创建提示调度器。
 *
 * @param {object} options - 依赖注入。
 * @param {ReturnType<typeof normalizeConfig>} options.config - 归一化后的配置。
 * @param {(kind: string, detail?: string) => void} options.play - 真正播放（测试里换成记录函数）。
 * @param {(message: string) => void} [options.log] - 调试日志回调。
 * @param {() => number} [options.now] - 当前时间毫秒。
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] - 计时器。
 * @param {(timer: unknown) => void} [options.clearTimer] - 取消计时器。
 * @returns {{ onSessionEvent: (session: object, event: object) => void, dispose: () => void, pending: () => { turns: number, approvals: number } }} 调度器。
 */
export function createPlanner(options) {
  const { config, play, log = () => {}, now = () => Date.now() } = options
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  if (typeof play !== 'function') throw new TypeError('dsh-ding: planner 需要 play() 函数')

  /** 每个会话等待中的 turn/end 提示。 */
  const pendingTurns = new Map()
  /** 每个 approval id 等待中的审批提示。 */
  const pendingApprovals = new Map()
  let lastPlayAt = Number.NEGATIVE_INFINITY
  let disposed = false

  const safeLog = (message) => {
    try {
      log(message)
    } catch {
      // 日志失败不能影响通知
    }
  }

  const disarm = (table, id) => {
    if (!table.has(id)) return false
    try {
      clearTimer(table.get(id))
    } catch {
      // 计时器已触发时 clear 可能失败，忽略
    }
    table.delete(id)
    return true
  }

  const arm = (table, id, delayMs, onFire) => {
    disarm(table, id)
    const timer = setTimer(() => {
      table.delete(id)
      if (disposed) return
      try {
        onFire()
      } catch (error) {
        safeLog(`dsh-ding: 定时触发失败：${error?.message ?? String(error)}`)
      }
    }, Math.max(0, delayMs))
    if (typeof timer?.unref === 'function') timer.unref()
    table.set(id, timer)
  }

  const ding = (kind, detail) => {
    if (disposed) return false
    const at = now()
    if (at - lastPlayAt < config.minIntervalMs) {
      safeLog(`dsh-ding: 跳过 ${kind}（${config.minIntervalMs}ms 冷却中）`)
      return false
    }
    lastPlayAt = at
    safeLog(`dsh-ding: 播放 ${kind}${detail === undefined || detail === '' ? '' : ` (${detail})`}`)
    try {
      play(kind, detail)
    } catch (error) {
      safeLog(`dsh-ding: 播放失败：${error?.message ?? String(error)}`)
    }
    return true
  }

  const sessionKey = (session) => (typeof session?.id === 'string' ? session.id : 'unknown-session')

  const onTurnEnd = (session, event) => {
    const reason = event?.data?.reason?.kind
    const enabled = reason === 'completed' ? config.notify.turnCompleted : reason === 'error' ? config.notify.turnError : false
    if (!enabled) return
    const kind = reason === 'completed' ? 'turn-completed' : 'turn-error'
    const turn = event?.data?.turn
    arm(pendingTurns, sessionKey(session), config.continuationGraceMs, () => ding(kind, `turn=${turn}`))
  }

  const onTurnStart = (session) => {
    if (disarm(pendingTurns, sessionKey(session))) {
      safeLog('dsh-ding: 跳过 turn 提示（同一会话紧接着开始了新轮次）')
    }
  }

  const onApprovalAsked = (session, event) => {
    if (!config.notify.approval) return
    const id = event?.data?.id
    const key = typeof id === 'string' && id !== '' ? id : `${sessionKey(session)}:approval`
    const toolName = event?.data?.toolName
    arm(pendingApprovals, key, config.approvalGraceMs, () => ding('approval', typeof toolName === 'string' ? toolName : undefined))
  }

  const onApprovalDecided = (event) => {
    const id = event?.data?.id
    if (typeof id === 'string' && id !== '') disarm(pendingApprovals, id)
  }

  const onToolCall = (event) => {
    if (!config.notify.question) return
    const name = event?.data?.name
    if (typeof name !== 'string' || !config.questionToolNames.includes(name)) return
    ding('question', name)
  }

  return {
    onSessionEvent(session, event) {
      if (disposed || !config.enabled) return
      if (!config.includeSubagents && !isTopLevelSession(session)) return
      switch (event?.type) {
        case 'turn/end':
          onTurnEnd(session, event)
          return
        case 'turn/start':
          onTurnStart(session)
          return
        case 'approval/asked':
          onApprovalAsked(session, event)
          return
        case 'approval/decided':
          onApprovalDecided(event)
          return
        case 'tool/call':
          onToolCall(event)
          return
        default:
          return
      }
    },
    dispose() {
      disposed = true
      for (const timer of pendingTurns.values()) {
        try {
          clearTimer(timer)
        } catch {
          // ignore
        }
      }
      pendingTurns.clear()
      for (const timer of pendingApprovals.values()) {
        try {
          clearTimer(timer)
        } catch {
          // ignore
        }
      }
      pendingApprovals.clear()
    },
    /** 仅供测试/诊断：当前等待中的计时器数量。 */
    pending() {
      return { turns: pendingTurns.size, approvals: pendingApprovals.size }
    },
  }
}
