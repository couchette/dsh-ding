/**
 * dsh-ding —— DeepSeek Harness 提示音插件（Host 侧）。
 *
 * 工作方式：
 *
 *   顶层会话事件 ──> lib/decide.js 决策 ──> spawn 系统命令 ──> 当前系统提示音
 *   （turn/end、approval/asked、tool/call）
 *
 * 默认只在「顶层会话」响：子代理与 Agent Teams 成员的会话（header.origin ===
 * 'subagent'）不响，避免一个任务连环响铃；需要时可以设 includeSubagents: true。
 *
 * 所有监听体都用 try/catch 包住：提示音插件的任何异常都不应该影响 agent 运行。
 *
 * @module dsh-ding
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createPlanner, normalizeConfig, resolvePlayer } from './decide.js'

/** cordis 插件名。 */
export const name = 'dsh-ding'

/** 播放命令的最大存活时间，避免异常进程一直挂着。 */
const PLAYER_TIMEOUT_MS = 5000

/**
 * 挂载插件：读取配置、解析平台播放器、注册事件监听。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} [rawConfig] - profile 传入的配置。
 * @throws {TypeError|Error} 配置非法或自定义音频文件不存在时在加载期失败。
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  const debug = createDebugLog(config, logger)

  if (!config.enabled) {
    debug('dsh-ding: enabled=false，插件不注册监听')
    return
  }

  if (config.sound !== 'system') {
    if (!isAbsolute(config.sound)) throw new Error(`dsh-ding: config.sound 必须是 'system' 或绝对路径：${config.sound}`)
    if (!existsSync(config.sound)) throw new Error(`dsh-ding: 找不到自定义提示音文件：${config.sound}`)
  }

  const player = resolvePlayer({ platform: process.platform, sound: config.sound, volume: config.volume })
  if (player === null) {
    logger?.warn?.(`dsh-ding: 当前平台 ${process.platform} 没有内置播放方式，插件只记录事件不发声`)
    debug(`dsh-ding: 无播放器（platform=${process.platform}）`)
  }

  const play = (kind, detail) => {
    if (player === null) return
    let child
    try {
      child = spawn(player.command, player.args, { stdio: 'ignore', shell: false, windowsHide: true })
    } catch (error) {
      logger?.warn?.(`dsh-ding: 启动播放器失败：${error?.message ?? String(error)}`)
      debug(`dsh-ding: spawn 失败：${error?.message ?? String(error)}`)
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已退出
      }
    }, PLAYER_TIMEOUT_MS)
    timer.unref?.()

    child.once('error', (error) => {
      clearTimeout(timer)
      logger?.warn?.(`dsh-ding: 播放失败（${kind}）：${error?.message ?? String(error)}`)
      debug(`dsh-ding: 播放失败（${kind}）：${error?.message ?? String(error)}`)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detailText = `dsh-ding: 播放命令退出 ${code === null ? signal : code}（${kind}）`
        logger?.warn?.(detailText)
        debug(detailText)
      }
    })
    child.unref?.()
    debug(`dsh-ding: spawn ${player.command} ${player.args.join(' ')}`)
  }

  const planner = createPlanner({ config, play, log: debug })

  ctx.on('session/event', (session, event) => {
    try {
      planner.onSessionEvent(session, event)
    } catch (error) {
      debug(`dsh-ding: session/event 处理失败：${error?.message ?? String(error)}`)
    }
  })

  ctx.effect(() => () => planner.dispose())

  logger?.info?.(`dsh-ding: 已加载（${player === null ? '无播放器' : player.label}；触发 ${describeTriggers(config)}）`)
  debug(`dsh-ding: 加载完成 platform=${process.platform} sound=${config.sound} player=${player?.command ?? 'none'}`)
}

/**
 * 把触发配置压成一行人类可读描述，便于加载日志核对。
 *
 * @param {ReturnType<typeof normalizeConfig>} config - 归一化配置。
 * @returns {string} 描述文本。
 */
function describeTriggers(config) {
  const parts = []
  if (config.notify.turnCompleted) parts.push('完成')
  if (config.notify.turnError) parts.push('报错')
  if (config.notify.approval) parts.push('等待审批')
  if (config.notify.question) parts.push('提问')
  if (parts.length === 0) return '无（全部关闭）'
  return `${parts.join('/')}${config.includeSubagents ? '，含子代理' : '，仅顶层会话'}`
}

/**
 * 创建 debug 日志写入器。
 *
 * 默认路径 `$DSH_HOME/dsh-ding.log`；只有 config.debug 为 true 时才写盘。
 * 写日志失败只记到 ctx.logger，不影响插件其它行为。
 *
 * @param {ReturnType<typeof normalizeConfig>} config - 归一化配置。
 * @param {object | undefined} logger - cordis logger。
 * @returns {(message: string) => void} 写入函数。
 */
function createDebugLog(config, logger) {
  if (!config.debug) return () => {}
  const defaultPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-ding.log')
  const path = config.debugLogPath === '' ? defaultPath : config.debugLogPath
  if (!isAbsolute(path)) {
    logger?.warn?.(`dsh-ding: debugLogPath 不是绝对路径，改用默认路径 ${defaultPath}`)
    return createDebugLog({ ...config, debugLogPath: '' }, logger)
  }
  return (message) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
    } catch (error) {
      logger?.warn?.(`dsh-ding: 写 debug 日志失败：${error?.message ?? String(error)}`)
    }
  }
}
