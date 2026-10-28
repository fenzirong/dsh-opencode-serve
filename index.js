/**
 * dsh-opencode-serve
 *
 * 把 **官方 opencode 客户端进程**（`opencode-cli serve`）注册成 DSH 原生 llm provider。
 *
 * 为什么必须走进程而不是直连 HTTP：
 *   实测 2026-10-28，对 https://opencode.ai/inference/v1 用 5 种客户端指纹
 *   （cli 1.18.31 / 1.19.4 / 2.2.0、desktop 2.2.0、裸无 UA）发同一个免费模型，
 *   全部 429 FreeUsageLimitError；而用官方 2.2.0 CLI 本体（无登录、隔离数据目录）
 *   同一分钟两次成功。差异在运行时连接指纹（Bun/rustls vs Node/undici），不在 UA。
 *   所以：请求必须由 opencode 自己的进程发出。
 *
 * 通道形态（实测）：
 *   opencode-cli serve --port 0
 *     stdout: "server listening on http://127.0.0.1:PORT" + "server password PWD"
 *   认证:   Authorization: Basic base64("opencode:" + PWD)
 *   会话:   POST /api/session {agent, model:{providerID,id}}
 *   提问:   POST /api/session/{id}/prompt {text}     （异步，立即返回 user message）
 *   流:     GET  /api/event (SSE)，按 sessionID 过滤：
 *             session.text.started  {ordinal}
 *             session.text.delta    {ordinal, delta}
 *             session.text.ended    {ordinal, text}
 *             session.step.ended    {finish, tokens, cost}
 *             session.execution.succeeded | session.execution.failed
 *   打断:   POST /api/session/{id}/interrupt
 *
 * 安全：server 跑在隔离的 XDG 根里，配置强制 `permissions: [{action:"tool.use",
 * effect:"deny"}]`，agent 是纯聊天 agent，模型没有本地工具可用。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['llm']

const DEFAULTS = {
  providerId: 'opencode-serve',
  opencodePath: '',
  workdir: '',
  dataRoot: '',
  agentId: 'dsh-chat',
  requestTimeoutMs: 600000,
  models: [],
}

/** 内置免费模型清单（上游 /models 里 -free 的那批）。 */
const FREE_MODELS = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 200000 },
  { id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash Free', contextWindow: 200000 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash Free', contextWindow: 200000 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 262144 },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', contextWindow: 1048576, image: true },
  { id: 'flint-40b-free', name: 'Flint 40B Free' },
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 160000 },
  { id: 'beam-free', name: 'Beam Free', contextWindow: 1048576 },
]

const CONFIG_JSONC = `{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "dsh-chat",
  "permissions": [
    { "action": "tool.use", "resource": "*", "effect": "deny" }
  ],
  "agents": {
    "dsh-chat": {
      "description": "Chat-only bridge for DeepSeek Harness. Never uses local tools.",
      "mode": "primary",
      "system": "You are a plain chat assistant. Never call tools. Answer in the user's language.",
      "permissions": [
        { "action": "tool.use", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
`

// ───────────────────────────── 工具函数 ─────────────────────────────

function dataRootFor(cfg) {
  if (cfg.dataRoot) return cfg.dataRoot
  return join(homedir(), '.dsh', 'opencode-serve')
}

function resolveCli(cfg) {
  if (cfg.opencodePath) return cfg.opencodePath
  if (process.env.APPDATA) {
    const cliRoot = join(process.env.APPDATA, 'ai.opencode.desktop', 'cli')
    if (existsSync(cliRoot)) {
      try {
        for (const d of readdirSync(cliRoot).sort().reverse()) {
          const exe = join(cliRoot, d, 'opencode-cli.exe')
          if (existsSync(exe)) return exe
        }
      } catch {}
    }
  }
  return process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
}

function textOfMessage(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  const out = []
  const push = (v) => { if (typeof v === 'string' && v) out.push(v) }
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b) continue
      if (typeof b === 'string') push(b)
      else if (b.type === 'text') push(b.text)
    }
  }
  if (Array.isArray(m.blocks)) {
    for (const b of m.blocks) { if (b && b.type === 'text') push(b.text) }
  }
  if (Array.isArray(m.parts)) {
    for (const b of m.parts) { if (b && b.type === 'text') push(b.text) }
  }
  return out.join('\n')
}

/** 取最后一条 user 消息的文本。 */
function lastUserText(options) {
  const msgs = options.messages || []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'user') {
      const t = textOfMessage(msgs[i])
      if (t) return t
    }
  }
  return ''
}

// ────────────────────────── server + SSE 管理 ──────────────────────────

function createRuntime(cfg) {
  const root = dataRootFor(cfg)
  const workdir = cfg.workdir || process.cwd()
  let server = null
  let sseAbort = null
  const waiters = new Map()   // opencodeSessionID -> Set<fn>
  const sessions = new Map()  // dshSessionId -> opencodeSessionID
  const authHeader = (pw) => 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64')

  function prepareDirs() {
    mkdirSync(join(root, 'data'), { recursive: true })
    const cfgDir = join(root, 'config', 'opencode')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'opencode.jsonc'), CONFIG_JSONC, 'utf8')
  }

  async function ensureServer() {
    if (server && server.child && server.child.exitCode === null) return server
    prepareDirs()
    const bin = resolveCli(cfg)
    const child = spawn(bin, ['serve', '--port', '0'], {
      cwd: workdir,
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let out = ''
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('opencode serve 启动超时（30s）')), 30000)
      const onData = (chunk) => {
        out += chunk.toString('utf8')
        const mUrl = out.match(/listening on (\S+)/)
        const mPwd = out.match(/password (\S+)/)
        if (mUrl && mPwd) {
          clearTimeout(timer)
          resolve({ url: mUrl[1].replace(/\/+$/, ''), password: mPwd[1] })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', (c) => { out += c.toString('utf8') })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`opencode serve 退出，代码 ${code}：${out.slice(-300)}`))
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    const srv = { child, url: info.url, password: info.password }
    server = srv
    child.once('exit', () => {
      if (server === srv) server = null
      if (sseAbort) { try { sseAbort.abort() } catch {} sseAbort = null }
    })
    startEventStream(srv).catch(() => {})
    return srv
  }

  async function startEventStream(srv) {
    const ctrl = new AbortController()
    sseAbort = ctrl
    let res
    try {
      res = await fetch(srv.url + '/api/event', {
        headers: { authorization: authHeader(srv.password), accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
    } catch { return }
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '{}') continue
          let evt
          try { evt = JSON.parse(payload) } catch { continue }
          const sid = evt && evt.data && evt.data.sessionID
          if (!sid) continue
          const set = waiters.get(sid)
          if (!set) continue
          for (const fn of set) { try { fn(evt) } catch {} }
        }
      }
    } catch { /* aborted */ }
  }

  async function api(srv, path, init) {
    const res = await fetch(srv.url + path, {
      ...init,
      headers: {
        authorization: authHeader(srv.password),
        'content-type': 'application/json',
        accept: 'application/json',
        ...((init && init.headers) || {}),
      },
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) {
      const msg = (json && (json.message || (json.error && json.error.message))) || text.slice(0, 300)
      const err = new Error(`opencode API ${path} → ${res.status}: ${msg}`)
      err.status = res.status
      throw err
    }
    return json
  }

  async function ensureSession(srv, dshSessionId, model) {
    const cached = sessions.get(dshSessionId)
    // 会话中途换模型时必须新建 opencode 会话，否则沿用旧模型
    if (cached && cached.model === model) return cached.sid
    const created = await api(srv, '/api/session', {
      method: 'POST',
      body: JSON.stringify({
        agent: cfg.agentId,
        model: { providerID: 'opencode', id: model },
      }),
    })
    const sid = created && (created.id || (created.data && created.data.id))
    if (!sid) throw new Error('opencode 未返回 session id')
    sessions.set(dshSessionId, { sid, model })
    return sid
  }

  function forget(dshSessionId, sid) {
    const cur = sessions.get(dshSessionId)
    if (cur && (!sid || cur.sid === sid)) sessions.delete(dshSessionId)
  }

  async function interrupt(srv, sid) {
    try {
      await api(srv, `/api/session/${sid}/interrupt`, { method: 'POST', body: '{}' })
    } catch {}
    // 打断后该会话已不可信，丢弃映射
    for (const [k, v] of sessions) if (v.sid === sid) sessions.delete(k)
  }

  function dispose() {
    if (sseAbort) { try { sseAbort.abort() } catch {} sseAbort = null }
    if (server && server.child && server.child.exitCode === null) {
      try { server.child.kill() } catch {}
    }
    server = null
  }

  return { ensureServer, api, ensureSession, forget, waiters, interrupt, dispose, root }
}

// ─────────────────────────────── adapter ───────────────────────────────

function createAdapter(cfg) {
  const rt = createRuntime(cfg)
  const modelList = (cfg.models && cfg.models.length)
    ? cfg.models.map((id) => ({ id, name: id }))
    : FREE_MODELS

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'OpenCode 客户端（后台 serve）' }
    },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    imageRequestTarget(_p, _m, image) {
      const maxBytes = 1048576
      const longest = Math.max(image.width, image.height) || 1
      const scale = Math.min(1, 1568 / longest, Math.sqrt(maxBytes / Math.max(1, image.bytes)))
      return {
        width: Math.max(1, Math.round(image.width * scale)),
        height: Math.max(1, Math.round(image.height * scale)),
        maxBytes,
      }
    },

    async listModels(provider) {
      return modelList.map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        inputModalities: m.image ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const meta = modelList.find((m) => m.id === model) || {}
      return {
        provider,
        id: model,
        name: meta.name || model,
        inputModalities: meta.image ? ['text', 'image'] : ['text'],
        context: { contextWindow: meta.contextWindow || 200000 },
      }
    },

    async prepareCall(provider, model) {
      const resolved = await adapter.resolveModel(provider, model)
      return { model: resolved, stream: (options) => adapter.stream(options) }
    },

    async *stream(options) {
      const model = options.model
      const prompt = lastUserText(options)
      if (!prompt) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_PROMPT', message: '没有可发送的用户消息' } } }
        return
      }

      let srv
      try {
        srv = await rt.ensureServer()
      } catch (err) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER_UNAVAILABLE', message: `opencode serve 起不来：${err && err.message}` } } }
        return
      }

      const dshSession = options.sessionId || 'default'
      let sid
      try {
        sid = await rt.ensureSession(srv, dshSession, model)
      } catch (err) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SESSION_FAILED', message: String((err && err.message) || err), status: err && err.status } } }
        return
      }

      const queue = []
      let notify = null
      let finished = false
      const wake = () => { if (notify) { const n = notify; notify = null; n() } }
      const onEvent = (evt) => { queue.push(evt); wake() }
      let set = rt.waiters.get(sid)
      if (!set) { set = new Set(); rt.waiters.set(sid, set) }
      set.add(onEvent)

      const abortHandler = () => { rt.interrupt(srv, sid).catch(() => {}) }
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true })

      const sendPrompt = (targetSid) => rt.api(srv, `/api/session/${targetSid}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text: prompt }),
      })
      const bailOut = (err) => {
        set.delete(onEvent)
        if (options.signal) options.signal.removeEventListener('abort', abortHandler)
        return { type: 'finish', reason: { kind: 'error', failure: { code: 'PROMPT_FAILED', message: String((err && err.message) || err), status: err && err.status } } }
      }

      try {
        await sendPrompt(sid)
      } catch (err) {
        const stale = err && (err.status === 404 || err.status === 409 || err.status === 401)
        if (!stale) {
          yield bailOut(err)
          return
        }
        // 会话/服务已失效（重启或被清理）：丢弃映射，重建后重试一次
        rt.forget(dshSession, sid)
        try {
          sid = await rt.ensureSession(srv, dshSession, model)
          set.delete(onEvent)
          let retrySet = rt.waiters.get(sid)
          if (!retrySet) { retrySet = new Set(); rt.waiters.set(sid, retrySet) }
          retrySet.add(onEvent)
          set = retrySet
          await sendPrompt(sid)
        } catch (err2) {
          yield bailOut(err2)
          return
        }
      }

      const deadline = Date.now() + (cfg.requestTimeoutMs || 600000)
      const blockIndexByMessage = new Map()
      let nextIndex = 0
      let inputTokens = 0
      let outputTokens = 0
      let finish = 'stop'
      let failure = null

      const indexFor = (key) => {
        if (!blockIndexByMessage.has(key)) blockIndexByMessage.set(key, nextIndex++)
        return blockIndexByMessage.get(key)
      }

      while (!finished) {
        if (options.signal && options.signal.aborted) { finish = 'aborted'; break }
        if (Date.now() > deadline) {
          failure = { code: 'TIMEOUT', message: '等待 opencode 响应超时' }
          finish = 'error'
          await rt.interrupt(srv, sid)
          break
        }
        if (queue.length === 0) {
          await new Promise((resolve) => { notify = resolve; setTimeout(resolve, 1000) })
          continue
        }
        const evt = queue.shift()
        const type = evt.type
        const data = evt.data || {}

        if (type === 'session.text.started') {
          yield { type: 'block-start', index: indexFor(data.assistantMessageID || 'm'), blockType: 'text' }
          continue
        }
        if (type === 'session.text.delta') {
          if (data.delta) yield { type: 'text-delta', index: indexFor(data.assistantMessageID || 'm'), text: data.delta }
          continue
        }
        if (type === 'session.text.ended') {
          yield { type: 'block-end', index: indexFor(data.assistantMessageID || 'm'), block: { type: 'text', text: data.text || '' } }
          continue
        }
        if (type === 'session.step.ended') {
          const t = data.tokens || {}
          inputTokens += t.input || 0
          outputTokens += t.output || 0
          if (data.finish) finish = data.finish
          continue
        }
        if (type === 'session.usage.updated') {
          const t = data.tokens || {}
          inputTokens = t.input || inputTokens
          outputTokens = t.output || outputTokens
          continue
        }
        if (type === 'session.execution.failed') {
          failure = {
            code: (data.error && (data.error.name || data.error.type)) || 'EXECUTION_FAILED',
            message: (data.error && (data.error.message || JSON.stringify(data.error).slice(0, 300))) || 'opencode 执行失败',
          }
          finish = 'error'
          finished = true
          continue
        }
        if (type === 'session.execution.succeeded') {
          finished = true
          continue
        }
      }

      set.delete(onEvent)
      if (set.size === 0) rt.waiters.delete(sid)
      if (options.signal) options.signal.removeEventListener('abort', abortHandler)

      if (inputTokens || outputTokens) {
        yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
      }

      if (failure) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      const kind = finish === 'aborted' ? 'aborted' : finish === 'length' ? 'max-tokens' : 'stop'
      yield { type: 'finish', reason: { kind } }
    },
  }

  return { adapter, runtime: rt }
}

// ─────────────────────────────── 插件入口 ───────────────────────────────

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {})
  const { adapter, runtime } = createAdapter(cfg)

  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([cfg.providerId], adapter)
    return () => {
      try { handle() } catch {}
      try { runtime.dispose() } catch {}
    }
  })
}
