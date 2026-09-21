/**
 * OAuth Phase 0：angrymiao-auth 统一账号登录（Authorization Code + PKCE，纯前端整页跳转）。
 * 规格书：docs/oauth-auth-integration.md（常量/PKCE/命名空间/return_to 校验/错误表均按其实现）。
 *
 * 关键约束：
 *  - 纯内存会话：access token 只放模块内存；refresh token 不保存、不落 localStorage，
 *    页面刷新后重新登录是预期行为（文档 §7.2；跨刷新会话需未来 BFF + HttpOnly Cookie）。
 *  - 与看板密码门完全独立：OAuth access token 绝不用作板级 HMAC token（文档 §8）；
 *    api.ts / PasswordGate 行为本阶段零改动。
 *  - code_verifier / token 不进 URL、日志、看板 doc、localStorage。
 *  - AUTH_ORIGIN 可用 VITE_AUTH_ORIGIN 覆盖（e2e 注入本地 mock；缺省正式地址）。
 */

// ---------------------------------------------------------------------------
// 常量（文档 §3）
// ---------------------------------------------------------------------------
const AUTH_ORIGIN: string = import.meta.env.VITE_AUTH_ORIGIN || 'https://auth.angrymiao.com'
const CLIENT_ID = 'timeline'
const SCOPE = 'profile phone'

// 回调必须包含 base path（生产 VITE_BASE_PATH=/aVoSaywtHjXCA/，文档 §2/§3），与 router.ts 同口径归一化
const BASE_PATH = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
const REDIRECT_URI = `${window.location.origin}${BASE_PATH}/oauth/callback`

/** 进行中的授权请求（文档 §7.1 建议命名空间） */
const PENDING_KEY = 'timeline:oauth:pending'

// ---------------------------------------------------------------------------
// 会话（纯内存）与订阅
// ---------------------------------------------------------------------------
export interface OauthSession {
  accessToken: string
  /** epoch ms；过期即视为无会话 */
  expiresAt: number
  scope: string
}

interface PendingAuth {
  state: string
  code_verifier: string
  return_to: string
}

let session: OauthSession | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

export function subscribeAuth(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getOauthSession(): OauthSession | null {
  return session && session.expiresAt > Date.now() ? session : null
}

export function oauthLogout(): void {
  session = null
  emit()
}

// ---------------------------------------------------------------------------
// PKCE / state 工具（S256，文档 §5）
// ---------------------------------------------------------------------------
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const randomString = (nbytes: number): string => b64url(crypto.getRandomValues(new Uint8Array(nbytes)))

async function sha256b64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return b64url(new Uint8Array(digest))
}

/**
 * return_to 同源校验（文档 §7.1-3）：只接受以 / 开头且非 // 的站内路径（可含 query/hash），
 * 其余（绝对 URL、协议相对、空值、反斜杠伪装等）一律回退 '/'。
 */
export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  return raw
}

// ---------------------------------------------------------------------------
// 发起登录（文档 §7.1 顺序：PKCE → pending → URLSearchParams → 整页跳转）
// ---------------------------------------------------------------------------
export async function startOauthLogin(returnTo?: string): Promise<void> {
  const return_to = sanitizeReturnTo(
    returnTo ?? `${window.location.pathname}${window.location.search}${window.location.hash}`,
  )
  const state = randomString(16)
  const code_verifier = randomString(48) // RFC 7636：43–128 字符；48 字节 → 64 个 b64url 字符
  const code_challenge = await sha256b64url(code_verifier)
  const pending: PendingAuth = { state, code_verifier, return_to }
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // 存储不可用（隐私模式等）：回调会因 pending 缺失而失败并提示重新登录
  }
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge,
    code_challenge_method: 'S256',
  })
  window.location.assign(`${AUTH_ORIGIN}/oauth/authorize?${q.toString()}`)
}

/** 读取并删除 pending OAuth 状态（回调页一次性消费；形状非法按缺失处理） */
export function takePendingAuth(): PendingAuth | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    sessionStorage.removeItem(PENDING_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<PendingAuth>
    if (
      typeof p.state === 'string' &&
      p.state.length > 0 &&
      typeof p.code_verifier === 'string' &&
      p.code_verifier.length > 0 &&
      typeof p.return_to === 'string'
    ) {
      return { state: p.state, code_verifier: p.code_verifier, return_to: sanitizeReturnTo(p.return_to) }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Token exchange（文档 §7.2；错误信息不回显 code / URL 细节，§9）
// ---------------------------------------------------------------------------
export async function exchangeCode(code: string, codeVerifier: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  })
  let res: Response
  try {
    res = await fetch(`${AUTH_ORIGIN}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    throw new Error('网络不可达，请稍后重试')
  }
  if (!res.ok) {
    // 文档 §9：code 过期/重复使用、invalid_code_verifier 等统一引导重新登录
    throw new Error(
      res.status === 400 ? '授权码无效或已过期，请重新登录' : `登录服务异常（HTTP ${res.status}），请稍后重试`,
    )
  }
  const j = (await res.json()) as {
    access_token?: unknown
    token_type?: unknown
    expires_in?: unknown
    scope?: unknown
  }
  if (typeof j.access_token !== 'string' || !j.access_token) {
    throw new Error('登录服务响应异常，请重新登录')
  }
  const expiresIn = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600
  session = {
    accessToken: j.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof j.scope === 'string' ? j.scope : '',
  }
  emit()
}
