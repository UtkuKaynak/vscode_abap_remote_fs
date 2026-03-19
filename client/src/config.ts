import {
  ClientConfiguration,
  clientTraceUrl,
  httpTraceUrl,
  SOURCE_CLIENT
} from "vscode-abap-remote-fs-sharedapi"
import {
  workspace,
  QuickPickItem,
  WorkspaceFolder,
  Uri,
  ConfigurationTarget,
  Event,
  ConfigurationChangeEvent
} from "vscode"
import { funWindow as window } from "./services/funMessenger"
import { ADTClient, createSSLConfig, LogCallback } from "abap-adt-api"
import { readFileSync } from "fs"
import { createProxy } from "method-call-logger"
import { mongoApiLogger, mongoHttpLogger, PasswordVault } from "./lib"
import { oauthLogin, s4hPublicCloudLogin, getS4HTicket, getCachedApiUrl } from "./oauth"
import { ADTSCHEME } from "./adt/conections"

const CONFIGROOT = "abapfs"
const REMOTE = "remote"
export type GuiType = "SAPGUI" | "WEBGUI_CONTROLLED" | "WEBGUI_UNSAFE" | "WEBGUI_UNSAFE_EMBEDDED"

export interface RemoteConfig extends ClientConfiguration {
  atcapprover?: string
  atcVariant?: string
  maxDebugThreads?: number
  sapGui?: {
    disabled: boolean
    routerString: string
    // load balancing
    messageServer: string
    messageServerPort: string
    group: string
    // individual server
    server: string
    systemNumber: string
    guiType: GuiType
  }
}
const defaultConfig: Partial<RemoteConfig> = {
  maxDebugThreads: 4,
  allowSelfSigned: false,
  customCA: "",
  diff_formatter: "ADT formatter"
}

export const formatKey = (raw: string) => raw.toLowerCase()
export const connectedRoots = () => {
  const rootmap = new Map<string, WorkspaceFolder>()
  const roots = (workspace.workspaceFolders || []).filter(r => r.uri.scheme === ADTSCHEME)
  for (const r of roots) rootmap.set(formatKey(r.uri.authority), r)
  return rootmap
}
export const getConfig = () => workspace.getConfiguration(CONFIGROOT)
const targetRemotes = (target: ConfigurationTarget) => {
  const remotes = workspace.getConfiguration(CONFIGROOT).inspect(REMOTE)
  const select = () => {
    switch (target) {
      case ConfigurationTarget.Global:
        return remotes?.globalValue || {}
      case ConfigurationTarget.Workspace:
        return remotes?.workspaceValue || {}
      case ConfigurationTarget.WorkspaceFolder:
        return remotes?.workspaceFolderValue || {}
    }
  }
  return select() as Record<"string", RemoteConfig>
}
export const validateNewConfigId = (target: ConfigurationTarget) => {
  const remotes = workspace.getConfiguration(CONFIGROOT)?.[REMOTE] || {}
  const keys = Object.keys(targetRemotes(target)).map(formatKey)
  return (key: string) => {
    if (key.length < 3) return "Connection name must be at least 3 characters long"
    if (!key.match(/^[\w\d-_]+$/i))
      return "Unexpected character. Only letters, numbers, - and _ are allowed"
    if (keys.find(k => k === formatKey(key))) return "Key already in use"
  }
}

export const saveNewRemote = async (cfg: ClientConfiguration, target: ConfigurationTarget) => {
  const validation = validateNewConfigId(target)(cfg.name)
  if (validation) throw new Error(validation)
  const currentConfig = workspace.getConfiguration(CONFIGROOT)
  const remotes = { ...targetRemotes(target), [cfg.name]: cfg }
  return currentConfig.update(REMOTE, remotes, target)
}

const config = (name: string, remote: RemoteConfig) => {
  const conf = { ...defaultConfig, ...remote, name, valid: true }
  // S4H Public Cloud connections don't require username - auth is browser-based
  const isS4HConnection = !!remote.s4hPublicCloud?.enabled
  conf.valid = !!(remote.url && (isS4HConnection || remote.username)) // ✅ SECURITY FIX: Removed password validation from settings
  if (conf.customCA && !conf.customCA.match(/-----BEGIN CERTIFICATE-----/gi))
    try {
      conf.customCA = readFileSync(conf.customCA).toString()
    } catch (e) {
      delete conf.customCA
    }
  return conf
}

async function selectRemoteInt(remotes: RemoteConfig[]) {
  if (remotes.length <= 1) return { remote: remotes[0], userCancel: false }

  const selection = await window.showQuickPick(
    remotes.map(remote => ({
      label: remote.name,
      description: remote.name,
      remote
    })),
    {
      placeHolder: "Please choose an ABAP system",
      ignoreFocusOut: true
    }
  )
  return { remote: selection && selection.remote, userCancel: !selection }
}

interface RootItem extends QuickPickItem {
  root: WorkspaceFolder
}

export async function pickAdtRoot(uri?: Uri) {
  const roots = connectedRoots()
  if (roots.size === 0) throw new Error("No ABAP filesystem mounted in current workspace")

  if (roots.size === 1) return [...roots.values()][0] // no need to pick if only one root is mounted
  if (uri) {
    const root = roots.get(formatKey(uri.authority))
    if (root) return root
  }

  const item = await window.showQuickPick(
    [...roots.values()].map(root => {
      return { label: root.name, root } as RootItem
    }),
    { ignoreFocusOut: true }
  )
  if (item) return item.root
}

function loggedProxy(client: ADTClient, conf: RemoteConfig) {
  if (!clientTraceUrl(conf)) return client
  const logger = mongoApiLogger(conf.name, SOURCE_CLIENT, false)
  const cloneLogger = mongoApiLogger(conf.name, SOURCE_CLIENT, true)
  if (!(logger && cloneLogger)) return client

  const clone = createProxy(client.statelessClone, cloneLogger)

  return createProxy(client, logger, {
    resolvePromises: true,
    getterOverride: new Map([["statelessClone", () => clone]])
  })
}
const httpLogger = (conf: RemoteConfig): LogCallback | undefined => {
  const mongoUrl = httpTraceUrl(conf)
  if (!mongoUrl) return undefined
  return mongoHttpLogger(conf.name, SOURCE_CLIENT)
}

export function createClient(conf: RemoteConfig) {
  const sslconf = conf.url.match(/https:/i)
    ? createSSLConfig(conf.allowSelfSigned, conf.customCA)
    : {}
  sslconf.debugCallback = httpLogger(conf)

  // For S4H Public Cloud, we need to use MYSAPSSO2 cookie instead of Bearer token
  // The reentrance ticket is passed as a cookie, not an Authorization header
  // CRITICAL: S4H Public Cloud has SEPARATE API and UI hosts!
  if (conf.s4hPublicCloud?.enabled) {
    const s4hLogin = s4hPublicCloudLogin(conf)
    if (s4hLogin) {
      // For S4H, use placeholder username and a custom login mechanism
      const username = conf.username || "S4H_SSO_USER"

      // Get the API URL - S4H has separate API and UI hosts
      // The ticket is obtained from UI host but API calls go to API host
      // IMPORTANT: Check cached API URL first (discovered during setup or previous login)
      // The ticket data might not exist yet at client creation time
      const ticketData = getS4HTicket(conf.name)
      const cachedApiUrl = getCachedApiUrl(conf.url)
      const apiUrl = ticketData?.apiUrl || cachedApiUrl || conf.url

      // Shared state between main client and clone
      // This ensures cookies and CSRF token are shared
      const sharedState = {
        ticket: null as string | null,
        csrfToken: null as string | null,
        cookies: new Map<string, string>(),
        loginComplete: false
      }

      // Helper function to override the login method on any ADTClient's httpClient
      const overrideLogin = (httpClient: any, isClone = false) => {
        httpClient.login = async function() {
          // If main client already logged in, clone can reuse the session
          if (isClone && sharedState.loginComplete) {
            // Copy shared state to this client
            this.commonHeaders = this.commonHeaders || {}
            if (sharedState.ticket) {
              this.commonHeaders["MYSAPSSO2"] = sharedState.ticket
            }
            if (sharedState.csrfToken) {
              this.csrfToken = sharedState.csrfToken
            }
            // Copy cookies
            for (const [key, value] of sharedState.cookies) {
              this.cookie.set(key, value)
            }
            return
          }

          // Check if we already have a valid session (SAP_SESSIONID cookie present)
          const currentCookies = this.ascookies?.() || ""
          if (currentCookies.includes("SAP_SESSIONID")) {
            return
          }

          if (this.loginPromise) {
            return this.loginPromise
          }

          this.loginPromise = (async () => {
            try {
              // Get the reentrance ticket via browser SSO
              const ticket = await s4hLogin()

              // Store ticket in shared state
              sharedState.ticket = ticket

              // CRITICAL: Clear ALL existing cookies before S4H authentication
              // Old SAML state cookies can interfere with the MYSAPSSO2 authentication
              this.cookie.clear()

              // Clear any existing auth methods
              this.auth = undefined
              this.bearer = undefined

              // Set the MYSAPSSO2 as BOTH a header AND a cookie (Eclipse ADT does both)
              // The header is the primary auth mechanism for S4H Public Cloud
              this.commonHeaders = this.commonHeaders || {}
              this.commonHeaders["MYSAPSSO2"] = ticket

              // FIX: Cookie format should be just the ticket value, not "MYSAPSSO2=ticket"
              // The cookie.set() method already creates "key=value" format
              this.cookie.set("MYSAPSSO2", ticket)

              // Build query params
              const qs: any = {}
              if (this.client) qs["sap-client"] = this.client
              if (this.language) qs["sap-language"] = this.language

              // CRITICAL: Eclipse ADT sends x-sap-security-session: create to establish a session
              // This tells the SAP server to create a new security session with the provided ticket
              const headers: any = {
                "x-sap-security-session": "create",
                // Also add the sap-adt-purpose header that Eclipse uses
                "sap-adt-purpose": "logon"
              }

              // Fetch CSRF token with the MYSAPSSO2 header and session creation request
              this.csrfToken = "fetch"
              await this._request("/sap/bc/adt/compatibility/graph", { qs, headers })

              // Store session state for sharing with clone
              sharedState.csrfToken = this.csrfToken
              sharedState.loginComplete = true
              // Copy cookies to shared state
              for (const [key, value] of this.cookie) {
                sharedState.cookies.set(key, value)
              }
            } finally {
              this.loginPromise = undefined
            }
          })()

          return this.loginPromise
        }
      }

      // CRITICAL: Use API URL, not the base URL!
      // S4H Public Cloud has separate hosts for UI (browser auth) and API (ADT calls)
      const client = new ADTClient(
        apiUrl,  // Use API URL here!
        username,
        "DUMMY_WILL_BE_OVERRIDDEN", // Password is not used - we override login
        conf.client,
        conf.language,
        sslconf
      )

      // Override the login method on the main client
      overrideLogin(client.httpClient, false)

      // Override statelessClone to ensure cloned clients also use S4H auth
      // This is critical because nodeContents and other APIs use statelessClone
      const originalStatelessCloneGetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(client),
        "statelessClone"
      )

      Object.defineProperty(client, "statelessClone", {
        get: function() {
          // Call the original getter to get/create the clone
          const clone = originalStatelessCloneGetter?.get?.call(this)
          if (clone && !clone._s4hLoginOverridden) {
            // Override login on the clone's httpClient too
            overrideLogin(clone.httpClient, true)
            clone._s4hLoginOverridden = true
          }
          return clone
        },
        configurable: true
      })

      return loggedProxy(client, conf)
    }
  }

  // Standard OAuth or password auth
  const password = oauthLogin(conf) || conf.password
  const username = conf.username || ""
  const client = new ADTClient(
    conf.url,
    username,
    password,
    conf.client,
    conf.language,
    sslconf
  )
  return loggedProxy(client, conf)
}

export class RemoteManager {
  private static instance: RemoteManager
  private connections = new Map<string, RemoteConfig>()
  private vault: PasswordVault

  private constructor() {
    this.vault = PasswordVault.get()
    workspace.onDidChangeConfiguration(this.configChanged, this)
  }
  private configChanged({ affectsConfiguration }: ConfigurationChangeEvent) {
    if (affectsConfiguration(CONFIGROOT)) {
      for (const [key, current] of this.connections.entries()) {
        if (!this.isConnected(key)) this.connections.delete(key)
        else {
          const incoming = this.loadRemote(key)
          if (incoming) {
            // ignore any change to connection details, authentication and monitoring
            current.diff_formatter = incoming.diff_formatter
            current.sapGui = incoming.sapGui
          }
        }
      }
    }
  }

  public static get = () => RemoteManager.instance || (RemoteManager.instance = new RemoteManager())
  public byId(connectionId: string): RemoteConfig | undefined {
    connectionId = formatKey(connectionId)
    return this.connections.get(connectionId)
  }

  public async byIdAsync(connectionId: string): Promise<RemoteConfig | undefined> {
    connectionId = formatKey(connectionId)
    let conn = this.connections.get(connectionId)
    if (!conn) {
      conn = this.loadRemote(connectionId)
      if (!conn) return

      // 🔐 SECURITY FIX: Always get password from secure storage only
      if (!conn.password) {
        conn.password = await this.getPassword(connectionId, conn.username)
      }

      conn.name = connectionId
      this.connections.set(connectionId, conn)
    }
    return conn
  }

  private remoteList(): RemoteConfig[] {
    const userConfig = workspace.getConfiguration(CONFIGROOT)
    const remote = userConfig[REMOTE]
    if (!remote) throw new Error("No destination configured")
    return Object.keys(remote).map(name => config(name, remote[name] as RemoteConfig))
  }

  private loadRemote(connectionId: string) {
    connectionId = formatKey(connectionId)
    return this.remoteList().find(r => formatKey(r.name) === connectionId)
  }

  private isConnected(connectionId: string) {
    return connectedRoots().has(formatKey(connectionId))
  }

  public async selectConnection(
    connectionId?: string,
    filter?: boolean | ((r: RemoteConfig) => boolean)
  ) {
    let remotes = this.remoteList()
    if (filter) {
      if (typeof filter === "boolean") {
        const roots = connectedRoots()
        filter = r => !roots.has(formatKey(r.name))
      }
      remotes = remotes.filter(filter)
    }
    let remote
    if (connectionId) {
      connectionId = formatKey(connectionId)
      remote = remotes.find(r => connectionId === formatKey(r.name))
    }
    if (!remote) {
      const selected = await selectRemoteInt(remotes)
      if (selected.userCancel) return selected
      remote = selected.remote
    }
    if (remote && !remote.password)
      remote.password = await this.getPassword(formatKey(remote.name), remote.username)

    return { remote, userCancel: false }
  }

  public async savePassword(connectionId: string, userName: string, password: string) {
    connectionId = formatKey(connectionId)
    const result = await this.vault.setPassword(`vscode.abapfs.${connectionId}`, userName, password)
    const conn = this.byId(connectionId)
    if (conn) conn.password = password
    return result
  }

  public async clearPassword(connectionId: string, userName: string) {
    await this.vault.deletePassword(`vscode.abapfs.${formatKey(connectionId)}`, userName)
    return true
  }

  public async getPassword(connectionId: string, userName: string) {
    const key = `vscode.abapfs.${formatKey(connectionId)}`
    const password = await this.vault.getPassword(key, userName)
    return password || ""
  }

  public async askPassword(connectionId: string) {
    const conn = this.byId(connectionId)
    if (!conn) return
    const prompt = `Enter password for ${conn.username} on ${connectionId}`
    const password = await window.showInputBox({
      prompt,
      password: true,
      ignoreFocusOut: true
    })
    return password
  }

  // @command(AbapFsCommands.clearPassword)
  public async clearPasswordCmd(connectionId?: string) {
    if (!connectionId) {
      const { remote, userCancel } = await this.selectConnection()
      if (userCancel || !remote) return
      connectionId = remote.name
    }
    if (!connectionId) return
    connectionId = formatKey(connectionId)
    const conn = this.loadRemote(connectionId)
    if (!conn) return // no connection found, should never happen

    // For S4H Public Cloud, also clear the in-memory ticket
    if (conn.s4hPublicCloud?.enabled) {
      const { clearS4HTicket } = await import("./oauth/s4hPublicCloud")
      clearS4HTicket(connectionId)
    }

    // Determine which credential key to clear
    const credentialKey = conn.oauth?.clientId || (conn.s4hPublicCloud?.enabled ? "s4h-ticket" : conn.username)
    const deleted = await this.clearPassword(connectionId, credentialKey)
    if (deleted && !this.isConnected(connectionId)) this.connections.delete(connectionId)
  }
}
