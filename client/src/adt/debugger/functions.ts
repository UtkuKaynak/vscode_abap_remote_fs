import { ADTClient, ClientOptions, createSSLConfig } from "abap-adt-api"
import { ClientConfiguration } from "vscode-abap-remote-fs-sharedapi"
import { formatKey } from "../../config"
import { configFromKey } from "../../langClient"
import { futureToken } from "../../oauth"
import { createHash } from "crypto"
import { log } from "../../lib"

export const md5 = (s: string) => createHash("md5").update(s).digest("hex")

function createFetchToken(conf: ClientConfiguration) {
  if (conf.oauth) return () => futureToken(formatKey(conf.name)) as Promise<string>
}

export async function newClientFromKey(key: string, options: Partial<ClientOptions> = {}) {
  const conf = await configFromKey(key)
  if (conf) {
    const sslconf = conf.url.match(/https:/i)
      ? { ...options, ...createSSLConfig(conf.allowSelfSigned, conf.customCA) }
      : options
    const pwdOrFetch = createFetchToken(conf) || conf.password
    const client = new ADTClient(
      conf.url,
      conf.username,
      pwdOrFetch,
      conf.client,
      conf.language,
      sslconf
    )
    return client
  }
}

/**
 * Create a new ADTClient that shares the session with an existing client.
 *
 * This is used for S4H debugging where we need a separate HTTP client for
 * concurrent requests (listener + attach) but must use the same SAP session.
 *
 * The new client:
 * - Uses the same OAuth token (via shared fetcher)
 * - Copies cookies from the source client (same SAP session)
 * - Copies CSRF token
 * - Does NOT call login() (which would invalidate shared session)
 *
 * @param sourceClient The client to copy session from
 * @param key Connection key for config lookup
 * @param options Additional client options
 */
export async function cloneClientWithSharedSession(
  sourceClient: ADTClient,
  key: string,
  options: Partial<ClientOptions> = {}
): Promise<ADTClient | undefined> {
  const conf = await configFromKey(key)
  if (!conf) return undefined

  const sslconf = conf.url.match(/https:/i)
    ? { ...options, ...createSSLConfig(conf.allowSelfSigned, conf.customCA) }
    : options

  // For S4H Public Cloud, use dummy password like the main client does
  // We'll copy the session state (cookies, CSRF, bearer) from the source client
  const pwdOrFetch = createFetchToken(conf) || conf.password || "DUMMY_SESSION_CLONE"
  const username = conf.username || "S4H_SSO_USER"

  // Create new client - but don't call login()
  const newClient = new ADTClient(
    conf.url,
    username,
    pwdOrFetch,
    conf.client,
    conf.language,
    sslconf
  )

  // Copy session state from source client
  // Access private members via any cast - needed to share session
  const sourceHttp = sourceClient.httpClient as any
  const newHttp = newClient.httpClient as any

  // Copy cookies (Map) - this includes SAP_SESSIONID which identifies the SAP session
  if (sourceHttp.cookie && newHttp.cookie) {
    sourceHttp.cookie.forEach((value: string, key: string) => {
      newHttp.cookie.set(key, value)
    })
    log(`cloneClientWithSharedSession: copied ${sourceHttp.cookie.size} cookies`)
  }

  // Copy commonHeaders - this includes CSRF token AND MYSAPSSO2 for S4H auth
  // CRITICAL for S4H: The MYSAPSSO2 header is the authentication token
  if (sourceHttp.commonHeaders) {
    newHttp.commonHeaders = { ...sourceHttp.commonHeaders }
    log(`cloneClientWithSharedSession: copied commonHeaders (includes CSRF and MYSAPSSO2)`)
  }

  // Copy bearer token if present (for OAuth)
  if (sourceHttp.bearer) {
    newHttp.bearer = sourceHttp.bearer
    log(`cloneClientWithSharedSession: copied bearer token`)
  }

  // CRITICAL: Establish a new stateful session linked to the existing authentication
  // This creates a new security session that shares the MYSAPSSO2 auth but has its own state
  // This is what the working version did - without this, SAP sees us as a different session
  try {
    const qs: any = {}
    if (conf.client) qs["sap-client"] = conf.client
    if (conf.language) qs["sap-language"] = conf.language

    // Set CSRF token to "fetch" to get a fresh one for this new session
    newHttp.csrfToken = "fetch"

    // Make a request with x-sap-security-session: create to establish the stateful session
    log(`cloneClientWithSharedSession: establishing new security session...`)
    await newHttp._request("/sap/bc/adt/compatibility/graph", {
      qs,
      headers: { "x-sap-security-session": "create" }
    })
    log(`cloneClientWithSharedSession: security session established successfully`)
  } catch (error) {
    log(`cloneClientWithSharedSession: failed to establish security session: ${error}`)
    // Continue anyway - the session might still work
  }

  return newClient
}
