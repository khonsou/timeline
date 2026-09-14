#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

type ServiceName = 'customer' | 'admin'

type Options = {
  adminBaseUrl?: string
  baseUrl?: string
  customerBaseUrl?: string
  help: boolean
  json: boolean
  query: string[]
  timeoutMs: number
  token?: string
}

type Route = {
  name: string
  path: string
  service: ServiceName
}

type CliPayload = {
  data?: unknown
  error?: unknown
  meta?: Record<string, unknown>
  ok: boolean
  status_code: number
}

export type ExecutionResult = {
  exitCode: number
  helpText?: string
  payload: CliPayload
}

const ROOT_HELP = `Usage: angrymiao-coin [OPTIONS] <command>

Commands:
  permission current-user  Query current-user permissions
  tags list                Query all tags through the admin API
  tags current-user        Query tags available to the current user

Options:
  --json                          Emit a JSON envelope
  --token TEXT                    Bearer token; overrides ANGRYMIAO_COIN_TOKEN
  --base-url URL                  Default service base URL
  --customer-base-url URL         Customer API base URL
  --admin-base-url URL            Admin API base URL
  --query KEY=VALUE               Repeatable GET query parameter
  --timeout-ms NUMBER             Request timeout in milliseconds (default: 30000)
  -h, --help                      Show help

Environment:
  ANGRYMIAO_COIN_TOKEN
  ANGRYMIAO_COIN_CUSTOMER_BASE_URL
  ANGRYMIAO_COIN_ADMIN_BASE_URL
  ANGRYMIAO_COIN_BASE_URL`

const ROUTES: Record<string, Route> = {
  'permission.current-user': {
    name: 'permission.current-user',
    path: 'permission/current-user',
    service: 'customer',
  },
  'tags.list': {
    name: 'tags.list',
    path: 'tags',
    service: 'admin',
  },
  'tags.current-user': {
    name: 'tags.current-user',
    path: 'task-tag',
    service: 'customer',
  },
}

class CliError extends Error {
  code: string
  statusCode: number

  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

function parseOptions(argv: string[]): { options: Options; positional: string[] } {
  const options: Options = {
    help: false,
    json: false,
    query: [],
    timeoutMs: 30000,
  }
  const positional: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') {
      options.help = true
      continue
    }
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }

    const [name, inlineValue] = argument.slice(2).split('=', 2)
    const value = inlineValue ?? argv[++index]
    if (!value || value.startsWith('--')) {
      throw new CliError('invalid_option', `option --${name} requires a value`)
    }
    if (name === 'token') options.token = value
    else if (name === 'base-url') options.baseUrl = value
    else if (name === 'customer-base-url') options.customerBaseUrl = value
    else if (name === 'admin-base-url') options.adminBaseUrl = value
    else if (name === 'query') options.query.push(value)
    else if (name === 'timeout-ms') {
      const timeoutMs = Number(value)
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new CliError('invalid_option', '--timeout-ms must be a positive integer')
      }
      options.timeoutMs = timeoutMs
    } else {
      throw new CliError('invalid_option', `unknown option --${name}`)
    }
  }

  return { options, positional }
}

function helpFor(positional: string[]): string {
  if (positional[0] === 'permission') {
    return 'Usage: angrymiao-coin permission current-user [OPTIONS]\n\nQuery current-user permissions from the customer API.'
  }
  if (positional[0] === 'tags') {
    return 'Usage: angrymiao-coin tags <list|current-user> [OPTIONS]\n\nlist uses /api/tags; current-user uses /api/task-tag.'
  }
  return ROOT_HELP
}

function parseQuery(pairs: string[]): { params: Record<string, string>; search: URLSearchParams } {
  const params: Record<string, string> = {}
  const search = new URLSearchParams()
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator <= 0) throw new CliError('invalid_query', `query must use KEY=VALUE: ${pair}`)
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    params[key] = value
    search.append(key, value)
  }
  return { params, search }
}

function routeFrom(positional: string[]): Route {
  const key = positional.slice(0, 2).join('.')
  const route = ROUTES[key]
  if (!route || positional.length !== 2) {
    throw new CliError('unknown_command', `unknown command: ${positional.join(' ')}`)
  }
  return route
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]
  return value && value.trim() ? value.trim() : undefined
}

function resolveBaseUrl(route: Route, options: Options, env: Record<string, string | undefined>): string | undefined {
  if (route.service === 'customer') {
    return options.customerBaseUrl ?? options.baseUrl ?? envValue(env, 'ANGRYMIAO_COIN_CUSTOMER_BASE_URL') ?? envValue(env, 'ANGRYMIAO_COIN_BASE_URL')
  }
  return options.adminBaseUrl ?? options.baseUrl ?? envValue(env, 'ANGRYMIAO_COIN_ADMIN_BASE_URL') ?? envValue(env, 'ANGRYMIAO_COIN_BASE_URL')
}

function requestMeta(route: Route, baseUrl: string | undefined, params: Record<string, string>): Record<string, unknown> {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/${route.path}` : null
  return {
    source: 'http',
    service: route.service,
    summary: { command: route.name, endpoint: `GET /api/${route.path}` },
    request: { method: 'GET', path: route.path, url, params },
  }
}

function errorResult(error: CliError, meta?: Record<string, unknown>): ExecutionResult {
  return {
    exitCode: 1,
    payload: {
      ok: false,
      status_code: error.statusCode,
      error: { code: error.code, message: error.message },
      ...(meta ? { meta } : {}),
    },
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function backendError(statusCode: number, body: unknown): unknown {
  if (body && typeof body === 'object') return body
  return { code: 'http_error', message: String(body ?? `HTTP ${statusCode}`) }
}

export async function execute(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ExecutionResult> {
  let parsed: { options: Options; positional: string[] }
  try {
    parsed = parseOptions(argv)
    if (parsed.options.help) return { exitCode: 0, helpText: helpFor(parsed.positional), payload: { ok: true, status_code: 200 } }
    const route = routeFrom(parsed.positional)
    const { params, search } = parseQuery(parsed.options.query)
    const baseUrl = resolveBaseUrl(route, parsed.options, env)
    const token = parsed.options.token ?? envValue(env, 'ANGRYMIAO_COIN_TOKEN')
    const meta = requestMeta(route, baseUrl, params)

    if (!baseUrl) return errorResult(new CliError('missing_base_url', `${route.service} API base URL is required`), meta)
    if (!token) return errorResult(new CliError('auth_required', 'this command requires a Bearer token; use --token or ANGRYMIAO_COIN_TOKEN', 401), meta)

    const url = `${baseUrl.replace(/\/$/, '')}/api/${route.path}${search.toString() ? `?${search}` : ''}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(parsed.options.timeoutMs),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return errorResult(new CliError('request_failed', message, 502), meta)
    }

    const body = await readResponse(response)
    if (!response.ok) {
      return {
        exitCode: 1,
        payload: { ok: false, status_code: response.status, error: backendError(response.status, body), meta },
      }
    }
    return { exitCode: 0, payload: { ok: true, status_code: response.status, data: body, meta } }
  } catch (error) {
    if (error instanceof CliError) return errorResult(error)
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(new CliError('cli_error', message, 500))
  }
}

export function formatOutput(result: ExecutionResult): string {
  if (result.helpText) return result.helpText
  return JSON.stringify(result.payload, null, 2)
}

async function main(): Promise<void> {
  const result = await execute(process.argv.slice(2))
  process.stdout.write(`${formatOutput(result)}\n`)
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
