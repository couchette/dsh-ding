import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  createPlanner,
  isTopLevelSession,
  normalizeConfig,
  resolvePlayer,
} from '../lib/decide.js'

/** 可控时钟：setTimer/clearTimer/advance 都可预测，不产生真实等待。 */
function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at) {
            dueId = id
            due = timer
          }
        }
        if (due === null) break
        timers.delete(dueId)
        now = due.at
        due.fn()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

function createHarness(overrides = {}) {
  const clock = createClock()
  const plays = []
  const logs = []
  const config = normalizeConfig(overrides)
  const planner = createPlanner({
    config,
    play: (kind, detail) => plays.push({ kind, detail, at: clock.now() }),
    log: (message) => logs.push(message),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, plays, logs, planner }
}

const topSession = { id: 'session-top', header: { origin: undefined } }
const subSession = { id: 'session-child', header: { origin: 'subagent', parentSession: 'session-top', delegationDepth: 1 } }

const turnEnd = (kind, turn = 1) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const turnStart = (turn = 2) => ({ type: 'turn/start', data: { turn } })

test('normalizeConfig 填充默认值', () => {
  const config = normalizeConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.includeSubagents, false)
  assert.deepEqual(config.notify, { turnCompleted: true, turnError: true, approval: true, question: true })
  assert.deepEqual(config.questionToolNames, ['ask_user_question', 'exit_plan_mode'])
  assert.equal(config.approvalGraceMs, 400)
  assert.equal(config.continuationGraceMs, 900)
  assert.equal(config.minIntervalMs, 600)
  assert.equal(config.sound, 'system')
  assert.equal(config.debug, false)
})

test('normalizeConfig 接受合法覆盖并去重工具名', () => {
  const config = normalizeConfig({
    enabled: false,
    includeSubagents: true,
    notify: { turnError: false, question: false },
    questionToolNames: [' ask_user_question ', 'ask_user_question', 'plan_review'],
    approvalGraceMs: 0,
    minIntervalMs: 100,
    sound: '/tmp/x.aiff',
    volume: 0.4,
    debug: true,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.includeSubagents, true)
  assert.deepEqual(config.notify, { turnCompleted: true, turnError: false, approval: true, question: false })
  assert.deepEqual(config.questionToolNames, ['ask_user_question', 'plan_review'])
  assert.equal(config.approvalGraceMs, 0)
  assert.equal(config.sound, '/tmp/x.aiff')
  assert.equal(config.volume, 0.4)
})

test('normalizeConfig 拒绝非法类型', () => {
  for (const bad of [
    { enabled: 'yes' },
    { notify: [] },
    { notify: { approval: 1 } },
    { approvalGraceMs: -1 },
    { minIntervalMs: Number.NaN },
    { questionToolNames: [''] },
    { sound: '' },
    { volume: 2 },
    { debugLogPath: 42 },
  ]) {
    assert.throws(() => normalizeConfig(bad), TypeError, JSON.stringify(bad))
  }
})

test('isTopLevelSession 过滤子代理/团队成员会话', () => {
  assert.equal(isTopLevelSession(topSession), true)
  assert.equal(isTopLevelSession(subSession), false)
  assert.equal(isTopLevelSession({ id: 'x', header: { parentSession: 'p' } }), false)
  assert.equal(isTopLevelSession({ id: 'x', header: { delegationDepth: 2 } }), false)
  assert.equal(isTopLevelSession({ id: 'x' }), true)
})

test('顶层会话 turn/end completed：等 900ms 再响', () => {
  const { clock, plays, planner } = createHarness()
  planner.onSessionEvent(topSession, turnEnd('completed'))
  clock.advance(899)
  assert.equal(plays.length, 0)
  clock.advance(1)
  assert.deepEqual(plays.map((item) => item.kind), ['turn-completed'])
})

test('同一会话紧接着开始新轮次（自动续跑）时取消提示', () => {
  const { clock, plays, planner } = createHarness()
  planner.onSessionEvent(topSession, turnEnd('completed'))
  clock.advance(100)
  planner.onSessionEvent(topSession, turnStart())
  clock.advance(2000)
  assert.equal(plays.length, 0)
  assert.equal(planner.pending().turns, 0)
})

test('error 会响，aborted/blocked/max-tokens/interrupted 不响', () => {
  for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted']) {
    const harness = createHarness()
    harness.planner.onSessionEvent(topSession, turnEnd(kind))
    harness.clock.advance(2000)
    assert.equal(harness.plays.length, 0, kind)
  }
  const { clock, plays, planner } = createHarness()
  planner.onSessionEvent(topSession, turnEnd('error'))
  clock.advance(900)
  assert.deepEqual(plays.map((item) => item.kind), ['turn-error'])
})

test('子代理会话默认不响，includeSubagents 可打开', () => {
  const disabled = createHarness()
  disabled.planner.onSessionEvent(subSession, turnEnd('completed'))
  disabled.clock.advance(2000)
  assert.equal(disabled.plays.length, 0)

  const enabled = createHarness({ includeSubagents: true })
  enabled.planner.onSessionEvent(subSession, turnEnd('completed'))
  enabled.clock.advance(900)
  assert.equal(enabled.plays.length, 1)
})

test('approval/asked 在 400ms 内未决才响', () => {
  const harness = createHarness()
  harness.planner.onSessionEvent(topSession, { type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash' } })
  harness.clock.advance(399)
  assert.equal(harness.plays.length, 0)
  harness.clock.advance(1)
  assert.deepEqual(harness.plays.map((item) => item.kind), ['approval'])
})

test('approval/decided 在宽限期内返回则不响（自动放行）', () => {
  const harness = createHarness()
  harness.planner.onSessionEvent(topSession, { type: 'approval/asked', data: { id: 'approval-2', toolName: 'bash' } })
  harness.clock.advance(50)
  harness.planner.onSessionEvent(topSession, { type: 'approval/decided', data: { id: 'approval-2', outcome: 'allowed-once' } })
  harness.clock.advance(2000)
  assert.equal(harness.plays.length, 0)
  assert.equal(harness.planner.pending().approvals, 0)
})

test('提问工具 tool/call 立即响，普通工具不响', () => {
  const harness = createHarness()
  harness.planner.onSessionEvent(topSession, { type: 'tool/call', data: { name: 'read_file', callId: 'c1' } })
  assert.equal(harness.plays.length, 0)
  harness.planner.onSessionEvent(topSession, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c2' } })
  assert.deepEqual(harness.plays.map((item) => item.kind), ['question'])
  assert.equal(harness.plays[0].detail, 'ask_user_question')
})

test('minIntervalMs 冷却避免连环响', () => {
  const harness = createHarness()
  harness.planner.onSessionEvent(topSession, turnEnd('completed'))
  harness.planner.onSessionEvent({ id: 'session-other', header: {} }, turnEnd('completed'))
  harness.clock.advance(900)
  assert.equal(harness.plays.length, 1)
})

test('notify 开关可单独关闭', () => {
  const harness = createHarness({ notify: { turnCompleted: false, turnError: false, approval: false, question: false } })
  harness.planner.onSessionEvent(topSession, turnEnd('completed'))
  harness.planner.onSessionEvent(topSession, { type: 'approval/asked', data: { id: 'a', toolName: 'bash' } })
  harness.planner.onSessionEvent(topSession, { type: 'tool/call', data: { name: 'ask_user_question' } })
  harness.clock.advance(2000)
  assert.equal(harness.plays.length, 0)
})

test('dispose 清空等待中的计时器', () => {
  const harness = createHarness()
  harness.planner.onSessionEvent(topSession, turnEnd('completed'))
  harness.planner.onSessionEvent(topSession, { type: 'approval/asked', data: { id: 'a', toolName: 'bash' } })
  assert.equal(harness.planner.pending().turns, 1)
  assert.equal(harness.planner.pending().approvals, 1)
  harness.planner.dispose()
  harness.clock.advance(5000)
  assert.equal(harness.plays.length, 0)
  assert.equal(harness.planner.pending().turns, 0)
  assert.equal(harness.planner.pending().approvals, 0)
})

test('resolvePlayer 各平台映射', () => {
  assert.deepEqual(resolvePlayer({ platform: 'darwin', sound: 'system' }), {
    command: '/usr/bin/osascript',
    args: ['-e', 'beep'],
    label: 'macOS 系统警示音',
  })
  assert.deepEqual(resolvePlayer({ platform: 'darwin', sound: '/tmp/a.aiff', volume: 0.5 }), {
    command: '/usr/bin/afplay',
    args: ['-v', '0.5', '/tmp/a.aiff'],
    label: '/tmp/a.aiff',
  })
  assert.equal(resolvePlayer({ platform: 'win32', sound: 'system' })?.command, 'powershell.exe')
  assert.equal(resolvePlayer({ platform: 'win32', sound: '/tmp/a.aiff' })?.command, 'powershell.exe')
  assert.equal(resolvePlayer({ platform: 'win32', sound: "/tmp/it's.aiff" }), null)
  assert.equal(resolvePlayer({ platform: 'linux', sound: 'system' })?.command, 'canberra-gtk-play')
  assert.equal(resolvePlayer({ platform: 'linux', sound: '/tmp/a.oga' })?.command, 'paplay')
  assert.equal(resolvePlayer({ platform: 'aix', sound: 'system' }), null)
})

test('DEFAULT_CONFIG 是冻结的，避免被运行时改坏', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.notify), true)
})
