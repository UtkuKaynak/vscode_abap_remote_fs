import {
  ADTClient,
  Debuggee,
  isDebugListenerError,
  DebuggingMode,
  isAdtError,
  session_types
} from "abap-adt-api"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { log, caughtToString, ignore } from "../../lib"
import { DebugProtocol } from "@vscode/debugprotocol"
import { Disposable, EventEmitter } from "vscode"
import { getOrCreateClient, getClient } from "../conections"
import { homedir } from "os"
import { join } from "path"
import { StoppedEvent, TerminatedEvent, ThreadEvent } from "@vscode/debugadapter"
import { v1 } from "uuid"
import { getWinRegistryReader } from "./winregistry"
import { context } from "../../extension"
import { DebugService, isEnded } from "./debugService"
import { cloneClientWithSharedSession } from "./functions"
import { BreakpointManager } from "./breakpointManager"
import { VariableManager } from "./variableManager"
import { configFromKey } from "../../langClient"
import { newClientFromKey } from "./functions"

type ConflictResult = { with: "none" } | { with: "other" | "myself"; message?: string }

const ATTACHTIMEOUT = "autoAttachTimeout"
const sessionNumbers = new Map<string, number>()

export const THREAD_EXITED = "exited"

export interface DebuggerUI {
  Confirmator: (message: string) => Thenable<boolean>
  ShowError: (message: string) => any
}

const getOrCreateIdeId = (): string => {
  const ideId = context.workspaceState.get("adt.ideId")
  if (typeof ideId === "string") return ideId
  const newIdeId = v1().replace(/-/g, "").toUpperCase()
  context.workspaceState.update("adt.ideId", newIdeId)
  return newIdeId
}

const getOrCreateTerminalId = async () => {
  if (process.platform === "win32") {
    const reg = getWinRegistryReader()
    const terminalId =
      reg && reg("HKEY_CURRENT_USER", "Software\\SAP\\ABAP Debugging", "TerminalID")
    if (!terminalId) throw new Error("Unable to read terminal ID from windows registry")
    return terminalId
  } else {
    const cfgpath = join(homedir(), ".SAP/ABAPDebugging")
    const cfgfile = join(cfgpath, "terminalId")
    try {
      return readFileSync(cfgfile).toString("utf8")
    } catch (error) {
      const terminalId = v1().replace(/-/g, "").toUpperCase()
      if (!existsSync(cfgpath)) mkdirSync(cfgpath, { recursive: true })
      writeFileSync(cfgfile, terminalId)
      return terminalId
    }
  }
}

export const errorType = (err: any): string | undefined => {
  try {
    const exceptionType = err?.properties?.["com.sap.adt.communicationFramework.subType"]
    if (!exceptionType && `${err.response.body}`.match(/Connection timed out/)) return ATTACHTIMEOUT
    return exceptionType
  } catch (error) {
    /**/
  }
}

const isConflictError = (e: any) =>
  (errorType(e) || "").match(/conflictNotification|conflictDetected/)

export class DebugListener {
  readonly ideId: string
  private active: boolean = false
  private killed = false
  private notifier: EventEmitter<DebugProtocol.Event> = new EventEmitter()
  private listeners: Disposable[] = []
  readonly mode: DebuggingMode
  readonly breakpointManager
  readonly variableManager
  sessionNumber: number
  private services = new Map<number, DebugService>()
  listening = false
  private currentThreadId?: number
  private threadCreation?: Promise<void>
  maxThreads = 4
  private _isS4H = false

  public get client() {
    if (this.killed) throw new Error("Disconnected")
    return this._client
  }

  /**
   * Returns true if this is an S4H Public Cloud connection.
   * Used by BreakpointManager to determine which client to use for breakpoint operations.
   */
  public get isS4H() {
    return this._isS4H
  }

  activeServices() {
    return [...this.services]
  }

  constructor(
    readonly connId: string,
    private _client: ADTClient,
    readonly terminalId: string,
    readonly username: string,
    terminalMode: boolean,
    private ui: DebuggerUI,
    isS4H = false
  ) {
    this.sessionNumber = (sessionNumbers.get(connId) || 0) + 1
    sessionNumbers.set(connId, this.sessionNumber)
    this.ideId = getOrCreateIdeId()
    this.mode = terminalMode ? "terminal" : "user"
    if (!this.username) this.username = _client.username.toUpperCase()
    this.breakpointManager = new BreakpointManager(this)
    this.variableManager = new VariableManager(this)
    this._isS4H = isS4H
  }

  public static async create(
    connId: string,
    ui: DebuggerUI,
    username: string,
    terminalMode: boolean
  ) {
    const conf = await configFromKey(connId)
    const isS4H = !!conf?.s4hPublicCloud?.enabled

    // For S4H: Get main client (not clone) so listener and attach use same session
    // This is critical because the debuggee is registered on the session that calls
    // debuggerListen(), and must be attached from the same session.
    // getOrCreateClient defaults to clone=true, so we need clone=false for S4H.
    const client = await getOrCreateClient(connId, !isS4H)
    if (!client) throw new Error(`Unable to get client for ${connId}`)
    const terminalId = await getOrCreateTerminalId()
    return new DebugListener(connId, client, terminalId, username, terminalMode, ui, isS4H)
  }

  addListener(listener: (e: DebugProtocol.Event) => any, thisArg?: any) {
    return this.notifier.event(listener, thisArg, this.listeners)
  }

  service(threadid: number): DebugService {
    const service = this.services.get(threadid)
    if (!service) throw new Error(`No service for threadid ${threadid}`)
    this.currentThreadId = threadid
    return service
  }
  async currentservice() {
    await this.threadCreation
    return this.service(this.currentThreadId || 0)
  }
  hasService(threadid: number): boolean {
    return this.services.has(threadid)
  }

  private async stopListener(norestart = true) {
    if (norestart) {
      this.active = false
    }
    // For S4H: use main client to match the session used for listening
    // This ensures we delete the listener from the same session that created it
    const c = this._isS4H ? this._client : this._client.statelessClone
    return c.debuggerDeleteListener(this.mode, this.terminalId, this.ideId, this.username)
  }

  /**
   * Clear all external breakpoints from the server for this user/terminal/ide.
   * This is used on S4H restart to ensure old breakpoints from previous sessions
   * don't interfere with the new session. VS Code will re-send all breakpoints
   * via setBreakPointsRequest after the debug session starts.
   *
   * Eclipse ADT achieves this with BreakpointsSynchronizationMode.FULL with an empty
   * breakpoint list, which tells SAP "sync to this (empty) list = delete everything".
   *
   * abap-adt-api parameters:
   * debuggerSetBreakpoints(mode, terminalId, ideId, clientId, breakpoints, user, scope, systemDebugging, deactivated, syncScopeUri)
   * When syncScopeUri is empty string, it triggers <syncScope mode="full"> which syncs all breakpoints.
   */
  private async clearAllExternalBreakpoints(): Promise<void> {
    const client = this._isS4H ? this._client : this._client.statelessClone

    // Call debuggerSetBreakpoints with empty array and empty syncScopeUri (triggers full sync)
    // This tells SAP to sync its breakpoints to our list (empty), effectively deleting all
    try {
      await client.debuggerSetBreakpoints(
        this.mode,
        this.terminalId,
        this.ideId,
        `clear:${this.connId}`,  // clientId - just needs to be unique
        [],                       // empty breakpoint list - SAP will sync to this (delete all)
        this.username,
        "external",               // scope - external breakpoints (not debugger session breakpoints)
        false,                    // systemDebugging - false for normal debugging
        false,                    // deactivated - false, we want active breakpoints
        ""                        // syncScopeUri - empty string triggers mode="full" sync
      )
      log(`clearAllExternalBreakpoints: successfully cleared external breakpoints`)
    } catch (error) {
      // Log but don't throw - this is a best-effort cleanup
      log(`clearAllExternalBreakpoints: error (continuing anyway): ${caughtToString(error)}`)
    }
  }

  /**
   * Get the client to use for debug listener operations.
   *
   * For S4H Public Cloud: Use main client directly to ensure the debuggee
   * is registered on the same session that will be used for attach.
   * The statelessClone creates a separate session, which causes "invalidDebuggee"
   * errors because the debuggee doesn't exist in the attach client's session.
   *
   * For other auth types: Use statelessClone as before (separate session for listener)
   */
  private getListenerClient() {
    return this._isS4H ? this._client : this._client.statelessClone
  }

  private debuggerListen() {
    try {
      this.listening = true
      const listenerClient = this.getListenerClient()
      log(`debuggerListen: isS4H=${this._isS4H}, usingMainClient=${listenerClient === this._client}`)
      return listenerClient.debuggerListen(
        this.mode,
        this.terminalId,
        this.ideId,
        this.username
      )
    } finally {
      this.listening = false
    }
  }

  private async hasConflict(): Promise<ConflictResult> {
    // For S4H: use main client (can't create new clients with MYSAPSSO2)
    // For non-S4H: create a fresh client to check for conflicts (original behavior)
    const client = this._isS4H
      ? this.client
      : (await newClientFromKey(this.connId)) || this.client
    try {
      await client.debuggerListeners(this.mode, this.terminalId, this.ideId, this.username)
    } catch (error: any) {
      if (isConflictError(error)) return { with: "other", message: error?.properties?.conflictText }
      throw error
    }
    try {
      await client.debuggerListeners(this.mode, this.terminalId, "", this.username)
    } catch (error: any) {
      if (isConflictError(error))
        return { with: "myself", message: error?.properties?.conflictText }
      throw error
    }
    return { with: "none" }
  }

  public async fireMainLoop(): Promise<boolean> {
    try {
      // For S4H: Clear ALL external breakpoints from the server FIRST
      // This is needed because on restart, old breakpoints from previous sessions might still
      // exist on SAP side. Eclipse ADT uses BreakpointsSynchronizationMode.FULL which syncs
      // the server's breakpoints to match the IDE's breakpoints. Since we're starting fresh,
      // we clear everything and let VS Code re-send all breakpoints via setBreakPointsRequest.
      // We do this BEFORE stopListener to ensure the session is in a known-good state.
      if (this._isS4H) {
        log(`fireMainLoop: S4H mode - clearing old external breakpoints from server`)
        await this.clearAllExternalBreakpoints().catch(e =>
          log(`fireMainLoop: failed to clear old breakpoints (non-fatal): ${caughtToString(e)}`)
        )
      }

      // Following Eclipse ADT pattern: Always clean up any existing listener before starting
      // This clears stale debuggees from previous sessions that used the same ideId/terminalId
      // Eclipse calls stopWaitingForDebuggeeSessions() in scheduleCleanupAndRestartJob()
      log(`fireMainLoop: cleaning up any existing listener before starting`)
      await this.stopListener().catch(e => log(`fireMainLoop: cleanup ignored (expected if no existing listener): ${caughtToString(e)}`))

      const conflict = await this.hasConflict()
      switch (conflict.with) {
        case "myself":
          await this.stopListener()
          this.mainLoop()
          return true
        case "other":
          const resp = await this.ui.Confirmator(
            `${conflict.message || "Debugger conflict detected"} Take over debugging?`
          )
          if (resp) {
            await this.stopListener(false)
            this.mainLoop()
            return true
          }
          return false
        case "none":
          this.mainLoop()
          return true
      }
    } catch (error) {
      this.ui.ShowError(`Error listening to debugger: ${caughtToString(error)}`)
      return false
    }
  }

  private async mainLoop() {
    this.active = true
    try {
      const cfg = await configFromKey(this.connId)
      this.maxThreads = cfg.maxDebugThreads || 4
    } catch (error) {
      this.maxThreads = 4
    }
    let startTime = 0
    while (this.active) {
      try {
        log(`Debugger ${this.sessionNumber} listening on connection  ${this.connId}`)
        startTime = new Date().getTime()
        const debuggee = await this.debuggerListen()
        if (!debuggee || !this.active) continue
        log(`Debugger ${this.sessionNumber} disconnected`)
        if (isDebugListenerError(debuggee)) {
          log(`Debugger ${this.sessionNumber} reconnecting to ${this.connId}`)
          // reconnect
          break
        }
        log(`Debugger ${this.sessionNumber} on connection  ${this.connId} reached a breakpoint`)
        // For S4H: We MUST wait for attach to complete before restarting listener
        // Since S4H uses the same client for listener and attach, concurrent
        // requests would interfere. The debuggerListen POST and debuggerAttach POST
        // cannot run in parallel on the same session.
        if (this._isS4H) {
          await this.onBreakpointReached(debuggee)
        } else {
          // For non-S4H: Start attach in background, listener can restart immediately
          // (they use different clients so no conflict)
          this.onBreakpointReached(debuggee)
        }
      } catch (error) {
        if (!this.active) return
        if (!isAdtError(error)) {
          this.ui.ShowError(`Error listening to debugger: ${caughtToString(error)}`)
        } else {
          // autoAttachTimeout
          const exceptionType = errorType(error)
          switch (exceptionType) {
            case "conflictNotification":
            case "conflictDetected":
              const txt =
                error?.properties?.conflictText || "Debugger terminated by another session/user"
              this.ui.ShowError(txt)
              await this.stopDebugging(false)
              break
            case ATTACHTIMEOUT:
              // this.refresh()
              break
            default:
              const elapsed = new Date().getTime() - startTime
              if (elapsed < 50000) {
                // greater is likely a timeout
                const quit = await this.ui.Confirmator(
                  `Error listening to debugger: ${caughtToString(error)} Close session?`
                )
                if (quit) await this.stopDebugging()
              }
          }
        }
      }
    }
  }

  private async stopThread(threadid: number) {
    const thread = this.services.get(threadid)
    this.services.delete(threadid)
    if (this.currentThreadId === threadid) this.currentThreadId = undefined
    if (thread) {
      await this.breakpointManager.removeAllBreakpoints(thread).catch(ignore)
      await thread.client.debuggerStep("stepContinue").catch(ignore)
      await thread.logout()
    }
  }

  private async onBreakpointReached(debuggee: Debuggee) {
    log(`>>> onBreakpointReached START`)
    try {
      // Log debuggee details for debugging
      log(`onBreakpointReached: debuggeeId=${debuggee.DEBUGGEE_ID}, user=${debuggee.DEBUGGEE_USER}, program=${debuggee.PRG_CURR}, line=${debuggee.LINE_CURR}, isAttachImpossible=${debuggee.IS_ATTACH_IMPOSSIBLE}`)

      if (this.services.size >= this.maxThreads) return this.resume(debuggee)
      log(`onBreakpointReached: creating DebugService...`)
      const service = await DebugService.create(this.connId, this.ui, this, debuggee)
      log(`onBreakpointReached: DebugService created successfully`)
      const threadid = this.nextthreadid()
      service.threadId = threadid
      this.services.set(threadid, service)
      const creation = (async () => {
        log(`onBreakpointReached: calling service.attach()...`)
        await service.attach()
        log(`onBreakpointReached: service.attach() completed`)
        service.addListener(e => {
          if (e instanceof ThreadEvent && e.body.reason === THREAD_EXITED) this.stopThread(threadid)
          this.notifier.fire(e)
        })
        this.currentThreadId = threadid
        this.notifier.fire(new StoppedEvent("breakpoint", threadid))
      })()
      this.threadCreation = creation.finally(() => (this.threadCreation = undefined))
      await creation
      log(`onBreakpointReached: completed successfully`)
      log(`<<< onBreakpointReached END (success)`)
    } catch (error: any) {
      // Check if this is an "invalidDebuggee" error - this happens when we receive
      // a stale debuggee from a previous session. The debuggee was registered on a
      // different SAP session that no longer exists, so we can't attach to it.
      // In this case, just log and continue listening - don't stop the debugger.
      const errType = errorType(error)
      log(`<<< onBreakpointReached CATCH: errorType=${errType}, error=${caughtToString(error)}`)
      if (errType === "invalidDebuggee") {
        log(`Skipping stale debuggee ${debuggee.DEBUGGEE_ID} (invalidDebuggee error - likely from a previous session)`)
        // Try to resume/cleanup the stale debuggee
        await this.resume(debuggee).catch(e => log(`Failed to resume stale debuggee: ${e}`))
        return  // Continue listening
      }

      log(`onBreakpointReached: stopping debugging due to error`)
      await this.stopDebugging()
    }
  }

  private async resume(debuggee: Debuggee) {
    log(`resume: starting for debuggeeId=${debuggee.DEBUGGEE_ID}`)
    try {
      let client: ADTClient

      // For S4H Public Cloud, create a client sharing the session with the listener
      // This allows concurrent HTTP requests while staying on the same SAP session
      if (this._isS4H) {
        const mainClient = getClient(this.connId, false)
        const clonedClient = await cloneClientWithSharedSession(mainClient, this.connId)
        if (!clonedClient) throw new Error("Failed to clone client for resume")
        clonedClient.stateful = session_types.stateful
        client = clonedClient
        log(`resume: S4H mode, using cloned client sharing session`)
      } else {
        const existingClient = await newClientFromKey(this.connId)
        if (!existingClient) throw new Error("Failed to connect to debuggee")
        existingClient.stateful = session_types.stateful
        client = existingClient
      }

      try {
        log(`resume: calling debuggerAttach...`)
        await client.debuggerAttach(this.mode, debuggee.DEBUGGEE_ID, this.username, true)
        log(`resume: attach succeeded, stepping continue...`)
        while (true) await client.debuggerStep("stepContinue")
      } catch (error) {
        if (isEnded(error)) {
          log(`resume: debuggee ended (normal)`)
          return
        }
        log(`resume: attach/step error: ${caughtToString(error)}`)
      } finally {
        // S4H: Don't logout - would invalidate shared session used by filesystem
        if (!this._isS4H) {
          client.logout()
        }
      }
    } catch (error) {
      log(`resume: outer error: ${caughtToString(error)}`)
      await this.stopDebugging()
    }
  }

  nextthreadid(): number {
    if (this.services.size === 0) return 1
    const indexes = [...this.services.keys()]
    const max = Math.max(...indexes)
    if (max < this.services.size) for (let i = 1; i < max; i++) if (!this.services.has(i)) return i
    return max + 1
  }

  public async stopDebugging(stopDebugger = true) {
    this.active = false
    this.notifier.fire(new TerminatedEvent())
  }

  public async logout() {
    this.active = false
    if (this.killed) return
    this.killed = true

    // For S4H: Clear all external breakpoints on logout
    // This ensures breakpoints don't interfere with the next session,
    // especially if the user changes the debug user.
    if (this._isS4H) {
      log(`logout: S4H mode - clearing external breakpoints`)
      await this.clearAllExternalBreakpoints().catch(e =>
        log(`logout: failed to clear breakpoints (non-fatal): ${caughtToString(e)}`)
      )
    }

    if (this.listening) await this.stopListener().catch(ignore)
    else {
      try {
        const conflict = await this.hasConflict()
        if (conflict.with === "myself") await this.stopListener().catch(ignore)
      } catch (error) {
        // Ignore errors during logout - we're just trying to clean up
      }
    }
    const stopServices = [...this.services.keys()].map(s => this.stopThread(s))
    const proms: Promise<any>[] = [...stopServices]

    await Promise.all(proms)

    // Dispose all event listeners to prevent memory leaks
    this.listeners.forEach(l => l.dispose())
    this.listeners = []
    this.notifier.dispose()
  }
}
