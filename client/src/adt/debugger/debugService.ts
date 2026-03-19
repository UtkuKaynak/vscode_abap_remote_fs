import { ADTClient, Debuggee, DebugStepType, session_types, isAdtError } from "abap-adt-api"
import { newClientFromKey, cloneClientWithSharedSession } from "./functions"
import { configFromKey } from "../../langClient"
import { log, caughtToString, ignore } from "../../lib"
import { DebugProtocol } from "@vscode/debugprotocol"
import { Disposable, EventEmitter } from "vscode"
import { ContinuedEvent, Source, StoppedEvent, ThreadEvent } from "@vscode/debugadapter"
import { vsCodeUri } from "../../langClient"
import { DebugListener, errorType, THREAD_EXITED } from "./debugListener"
import { getClient } from "../conections"
export const STACK_THREAD_MULTIPLIER = 1000000000000

export interface DebuggerUI {
  Confirmator: (message: string) => Thenable<boolean>
  ShowError: (message: string) => any
}

interface StackFrame extends DebugProtocol.StackFrame {
  stackPosition: number
  stackUri?: string
}

export const idThread = (frameId: number) => Math.floor(frameId / STACK_THREAD_MULTIPLIER)
export const isEnded = (error: any) => errorType(error) === "debuggeeEnded"

export class DebugService {
  private killed = false
  private notifier: EventEmitter<DebugProtocol.Event> = new EventEmitter()
  private listeners: Disposable[] = []
  private _stackTrace: StackFrame[] = []
  public threadId: number = 0
  private _isS4H = false

  constructor(
    private connId: string,
    private _client: ADTClient,
    private listener: DebugListener,
    readonly debuggee: Debuggee,
    private ui: DebuggerUI,
    isS4H = false
  ) {
    this._isS4H = isS4H
  }

  get client() {
    if (this.killed) throw new Error("Disconnected")
    return this._client
  }
  get stackTrace() {
    return this._stackTrace
  }
  private get mode() {
    return this.listener.mode
  }

  private get username() {
    return this.listener.username
  }

  public static async create(
    connId: string,
    ui: DebuggerUI,
    listener: DebugListener,
    debuggee: Debuggee
  ) {
    const conf = await configFromKey(connId)
    if (!conf) throw new Error(`Unable to get config for ${connId}`)

    let client: ADTClient
    let isS4H = false

    // For S4H Public Cloud, we need a separate HTTP client for concurrent requests
    // (listener + attach), but must share the same SAP session.
    //
    // Key insight: The debuggee is bound to the SAP session (identified by cookies).
    // We create a new HTTP client but copy the session cookies from the listener's client.
    // This allows concurrent HTTP requests while staying on the same SAP session.
    // login() and adtCoreDiscovery() are also skipped as they are already done on the main client.

    // We mark it as S4H to skip logout() later (which would invalidate the shared session).
    if (conf.s4hPublicCloud?.enabled) {
      isS4H = true
      // Get the main client that the listener is using
      const mainClient = getClient(connId, false)
      // Create a new client that shares the session (cookies, CSRF token, bearer)
      const newClient = await cloneClientWithSharedSession(mainClient, connId, { timeout: 7200000 })
      if (!newClient) throw new Error(`Unable to create client for ${connId}`)
      newClient.stateful = session_types.stateful
      client = newClient
      log(`DebugService.create: S4H mode, created client sharing session with listener`)
    } else {
      const newClient = await newClientFromKey(connId, { timeout: 7200000 })
      if (!newClient) throw new Error(`Unable to create client for ${connId}`)
      newClient.stateful = session_types.stateful
      client = newClient
      await client.adtCoreDiscovery()
    }

    const service = new DebugService(connId, client, listener, debuggee, ui, isS4H)
    return service
  }

  public async attach() {
    try {
      log(`debuggerAttach: mode=${this.mode}, debuggeeId=${this.debuggee.DEBUGGEE_ID}, username=${this.username}, isS4H=${this._isS4H}`)
      await this.client.debuggerAttach(this.mode, this.debuggee.DEBUGGEE_ID, this.username, true)
      log(`debuggerAttach SUCCEEDED for ${this.debuggee.DEBUGGEE_ID}`)
    } catch (error: any) {
      // Log full error details for debugging
      log(`debuggerAttach FAILED: ${caughtToString(error)}`)
      throw error
    }
    // Fire saveSettings in background - not critical for attach
    log(`debuggerSaveSettings: starting (background)`)
    this.client.debuggerSaveSettings({}).catch(e => {
      log(`debuggerSaveSettings FAILED: ${caughtToString(e)}`)
    })
    try {
      log(`updateStack: starting`)
      await this.updateStack()
      log(`updateStack: completed`)
    } catch (error: any) {
      log(`updateStack FAILED: ${caughtToString(error)}`)
      throw error
    }
    log(`attach(): completed successfully`)
  }

  addListener(listener: (e: DebugProtocol.Event) => any, thisArg?: any) {
    return this.notifier.event(listener, thisArg, this.listeners)
  }

  getStack() {
    return this._stackTrace
  }

  private async baseDebuggerStep(threadId: number, stepType: DebugStepType, url?: string) {
    this.notifier.fire(new ContinuedEvent(threadId))
    if (stepType === "stepRunToLine" || stepType === "stepJumpToLine") {
      if (!url) throw new Error(`Bebugger step${stepType} requires a target`)
      return this.client.debuggerStep(stepType, url)
    }
    return this.client.debuggerStep(stepType)
  }

  public async debuggerStep(stepType: DebugStepType, threadId: number, url?: string) {
    try {
      const res = await this.baseDebuggerStep(threadId, stepType, url)
      await this.updateStack()
      this.notifier.fire(new StoppedEvent("step", threadId))
      return res
    } catch (error) {
      if (!isAdtError(error)) {
        this.ui.ShowError(`Error in debugger stepping: ${caughtToString(error)}`)
      } else {
        if (stepType === "stepRunToLine" || stepType === "stepJumpToLine") throw error
        if (!isEnded(error))
          this.ui.ShowError(error?.message || "unknown error in debugger stepping")
        this.notifier.fire(new ThreadEvent(THREAD_EXITED, threadId))
      }
    }
  }

  private async updateStack() {
    const stackInfo = await this.client.debuggerStackTrace(false).catch(e => {
      log(`debuggerStackTrace FAILED: ${caughtToString(e)}`)
      return undefined
    })
    log(`debuggerStackTrace returned: ${stackInfo ? `${stackInfo.stack?.length || 0} frames` : 'undefined'}`)
    this.listener.variableManager.resetHandle(this.threadId)
    const createFrame = (
      path: string,
      line: number,
      id: number,
      stackPosition: number,
      stackUri?: string
    ) => {
      const name = path.replace(/.*\//, "")
      const source = new Source(name, path)
      const frame: StackFrame = { id, name, source, line, column: 0, stackPosition }
      return frame
    }
    if (stackInfo) {
      const stackp = stackInfo.stack.map(async (s, id) => {
        id = id + this.threadId * STACK_THREAD_MULTIPLIER
        try {
          const path = await vsCodeUri(this.connId, s.uri.uri, true, true)
          const stackUri = "stackUri" in s ? s.stackUri : undefined
          return createFrame(path, s.line, id, s.stackPosition, stackUri)
        } catch (error) {
          log(caughtToString(error))
          return createFrame("unknown", 0, id, NaN)
        }
      })
      this._stackTrace = (await Promise.all(stackp)).filter(s => !!s)
      log(`updateStack: built ${this._stackTrace.length} frames`)
    } else {
      log(`updateStack: no stackInfo, stack trace will be empty`)
    }
  }

  public async logout() {
    if (this.killed) return
    this.killed = true
    // Dispose all event listeners to prevent memory leaks
    this.listeners.forEach(l => l.dispose())
    this.listeners = []
    this.notifier.dispose()

    // S4H: Don't logout - would invalidate main session used by filesystem
    // Following Eclipse ADT pattern: debug sessions share destination with main client
    if (!this._isS4H) {
      // Non-S4H: logout the client (each debug service has its own client)
      await this._client.statelessClone.logout().catch(ignore)
      await this._client.logout()
    }
  }
}
