/**
 * S4/HANA Public Cloud Authentication Module
 *
 * Implements browser-based authentication for SAP S/4HANA Public Cloud
 * using the reentrance ticket mechanism.
 *
 * Flow (matching Eclipse ADT):
 * 1. Call /sap/public/bc/icf/virtualhost to discover API and UI URLs
 * 2. Start local HTTP server on port 52842 (fixed port used by Eclipse ADT)
 * 3. Open browser to: https://{UI_HOST}/sap/bc/adt/core/http/reentranceticket
 *    with redirect-url parameter pointing to localhost
 * 4. User authenticates via browser (SAML/IAS SSO)
 * 5. SAP redirects to localhost with reentrance-ticket parameter
 * 6. Use the ticket with the API URL (not UI URL!) for ADT API calls
 *
 * IMPORTANT: S4H Public Cloud has SEPARATE API and UI hosts!
 * - UI Host: https://my418012.s4hana.cloud.sap (for browser auth)
 * - API Host: https://my418012-api.s4hana.cloud.sap (for ADT API calls)
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"
import open from "open"
import { RemoteConfig, formatKey, RemoteManager } from "../config"
import { log } from "../lib"

const S4H_PORT = 52842
const S4H_REDIRECT_PATH = "/adt/redirect"
const TICKET_PARAM = "reentrance-ticket"
const TICKET_ENDPOINT = "/sap/bc/adt/core/http/reentranceticket"
const VIRTUALHOST_ENDPOINT = "/sap/public/bc/icf/virtualhost"

// In-memory storage for reentrance tickets and API URLs
const tickets = new Map<string, S4HTicketData>()
// Also store tickets by URL for setup-to-connection flow
const ticketsByUrl = new Map<string, S4HTicketData>()
const pendingLogins = new Map<string, Promise<string>>()
// Cache for discovered API URLs
const apiUrlCache = new Map<string, string>()

export interface S4HTicketData {
  ticket: string
  timestamp: number
  apiUrl?: string  // The actual API URL to use for ADT calls
}

interface S4HLoginServer {
  server: http.Server
  port: number
  close: () => void
}

/**
 * Response from /sap/public/bc/icf/virtualhost endpoint
 */
interface VirtualHostInfo {
  relatedUrls?: {
    API?: string
    UI?: string
  }
}

/**
 * Discover the API and UI URLs for an S4H system
 * Eclipse ADT calls this BEFORE authentication to determine the correct hosts
 *
 * @param baseUrl The user-provided URL (e.g., https://my418012.s4hana.cloud.sap)
 * @returns Object with apiUrl and uiUrl, or null if discovery fails
 */
export async function discoverS4HUrls(baseUrl: string): Promise<{ apiUrl: string; uiUrl: string } | null> {
  const normalizedBase = baseUrl.replace(/\/$/, "")

  // Check cache first
  const cached = apiUrlCache.get(normalizedBase)
  if (cached) {
    return { apiUrl: cached, uiUrl: normalizedBase }
  }

  const discoveryUrl = `${normalizedBase}${VIRTUALHOST_ENDPOINT}`

  return new Promise((resolve) => {
    const parsedUrl = new URL(discoveryUrl)

    const req = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      },
      rejectUnauthorized: true  // S4H Cloud should have valid certs
    }, (res) => {
      let data = ""

      res.on("data", (chunk) => {
        data += chunk
      })

      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const info: VirtualHostInfo = JSON.parse(data)
            if (info.relatedUrls?.API) {
              const apiUrl = info.relatedUrls.API.replace(/\/$/, "")
              const uiUrl = info.relatedUrls.UI?.replace(/\/$/, "") || normalizedBase

              // Cache the API URL
              apiUrlCache.set(normalizedBase, apiUrl)

              resolve({ apiUrl, uiUrl })
              return
            }
          } catch (e) {
            // Parse error, fall through
          }
        }

        // If discovery fails or no separate URLs, use the same URL for both
        resolve(null)
      })
    })

    req.on("error", () => {
      resolve(null)
    })

    req.setTimeout(10000, () => {
      req.destroy()
      resolve(null)
    })

    req.end()
  })
}

/**
 * Get the API URL for a connection (from cache or discovery)
 */
export function getApiUrl(connId: string): string | undefined {
  const ticketData = tickets.get(formatKey(connId))
  return ticketData?.apiUrl
}

/**
 * Get cached API URL by base URL
 */
export function getCachedApiUrl(baseUrl: string): string | undefined {
  return apiUrlCache.get(baseUrl.replace(/\/$/, ""))
}

/**
 * Get stored ticket for a connection
 */
export function getS4HTicket(connId: string): S4HTicketData | undefined {
  return tickets.get(formatKey(connId))
}

/**
 * Store ticket for a connection
 */
export function setS4HTicket(connId: string, ticket: string, apiUrl?: string): void {
  const key = formatKey(connId)
  tickets.set(key, {
    ticket,
    timestamp: Date.now(),
    apiUrl
  })
}

/**
 * Clear ticket for a connection
 */
export function clearS4HTicket(connId: string): void {
  tickets.delete(formatKey(connId))
}

/**
 * Create a local HTTP server to receive the reentrance ticket callback
 */
function createLoginServer(): Promise<S4HLoginServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${S4H_PORT} is already in use. Please close any application using this port.`))
      } else {
        reject(err)
      }
    })

    server.listen(S4H_PORT, "127.0.0.1", () => {
      log(`S4H login server started on port ${S4H_PORT}`)
      resolve({
        server,
        port: S4H_PORT,
        close: () => {
          server.close()
          log("S4H login server closed")
        }
      })
    })
  })
}

/**
 * Wait for the reentrance ticket callback
 */
function waitForTicket(server: S4HLoginServer, timeoutMs: number = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error("S4/HANA login timed out. Please try again."))
    }, timeoutMs)

    server.server.on("request", (req, res) => {
      const parsedUrl = url.parse(req.url || "", true)

      if (parsedUrl.pathname === S4H_REDIRECT_PATH) {
        const ticket = parsedUrl.query[TICKET_PARAM]

        if (ticket && typeof ticket === "string") {
          clearTimeout(timeout)

          // Send success response to browser
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Login Successful</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  background: linear-gradient(135deg, #0a74da 0%, #1a4d7c 100%);
                  color: white;
                }
                .container {
                  text-align: center;
                  padding: 40px;
                  background: rgba(255,255,255,0.1);
                  border-radius: 16px;
                  backdrop-filter: blur(10px);
                }
                .checkmark {
                  font-size: 64px;
                  margin-bottom: 20px;
                }
                h1 { margin: 0 0 10px 0; }
                p { margin: 0; opacity: 0.9; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="checkmark">&#10004;</div>
                <h1>Login Successful!</h1>
                <p>You can close this window and return to VS Code.</p>
              </div>
              <script>setTimeout(() => window.close(), 3000);</script>
            </body>
            </html>
          `)

          server.close()
          resolve(ticket)
        } else {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Login Failed</title></head>
            <body>
              <h1>Login Failed</h1>
              <p>No reentrance ticket received. Please try again.</p>
            </body>
            </html>
          `)
        }
      } else {
        // Handle other requests (e.g., favicon)
        res.writeHead(404)
        res.end()
      }
    })
  })
}

/**
 * Build the S4/HANA authentication URL
 */
function buildAuthUrl(baseUrl: string): string {
  const redirectUrl = `http://localhost:${S4H_PORT}${S4H_REDIRECT_PATH}`
  const timestamp = Date.now()
  return `${baseUrl}${TICKET_ENDPOINT}?redirect-url=${encodeURIComponent(redirectUrl)}&_=${timestamp}`
}

/**
 * Perform browser-based S4/HANA Public Cloud login
 * Returns the reentrance ticket
 *
 * IMPORTANT: This function handles its own deduplication via pendingLogins map.
 * The map is checked synchronously before any async work to prevent race conditions.
 */
function performS4HLogin(conf: RemoteConfig): Promise<string> {
  const connId = formatKey(conf.name)

  // SYNCHRONOUS check and set - this prevents race conditions
  // Check if there's already a pending login for this connection
  const pending = pendingLogins.get(connId)
  if (pending) {
    log(`Waiting for pending S4H login for ${connId}`)
    return pending
  }

  // Create the promise and immediately register it BEFORE any async work
  const loginPromise = (async () => {
    try {
      log(`Starting S4H Public Cloud login for ${conf.name}`)

      // CRITICAL: Discover API URL FIRST (Eclipse ADT does this)
      // S4H Public Cloud has separate API and UI hosts
      const urls = await discoverS4HUrls(conf.url)
      const apiUrl = urls?.apiUrl

      // Start local server
      const server = await createLoginServer()

      // Build auth URL and open browser (use the base URL, not API URL for browser auth)
      const authUrl = buildAuthUrl(conf.url)
      log(`Opening browser for S4H authentication: ${authUrl}`)

      await open(authUrl)

      // Wait for callback with ticket
      const ticket = await waitForTicket(server)

      log(`S4H login successful for ${conf.name}`)

      // Store the ticket WITH the API URL
      setS4HTicket(connId, ticket, apiUrl)

      return ticket
    } finally {
      pendingLogins.delete(connId)
    }
  })()

  // Register SYNCHRONOUSLY before returning
  pendingLogins.set(connId, loginPromise)
  return loginPromise
}

/**
 * Get a valid ticket, refreshing if necessary
 * This is called by the BearerFetcher function passed to ADTClient
 */
async function getValidTicket(conf: RemoteConfig): Promise<string> {
  const connId = formatKey(conf.name)

  // FIRST: Check if there's already a pending login - this prevents race conditions
  const pending = pendingLogins.get(connId)
  if (pending) {
    return pending
  }

  const stored = getS4HTicket(connId)

  // Check if we have a stored ticket by connection ID
  // Note: Reentrance tickets are session-based and typically valid for 30-60 minutes
  // The ADT API will return 401 if the ticket is expired, triggering re-authentication
  if (stored) {
    return stored.ticket
  }

  // Check if we have a ticket stored by URL (from setup flow)
  // This prevents double browser authentication
  const normalizedUrl = conf.url.toLowerCase().replace(/\/$/, "")

  const storedByUrl = ticketsByUrl.get(normalizedUrl)
  if (storedByUrl) {
    // Move the ticket to the connection ID map and clear from URL map
    setS4HTicket(connId, storedByUrl.ticket)
    ticketsByUrl.delete(normalizedUrl)
    return storedByUrl.ticket
  }

  // No stored ticket, perform login
  return performS4HLogin(conf)
}

/**
 * Create an S4H Public Cloud login function for the ADTClient
 * Returns a BearerFetcher function that can be passed to the ADTClient constructor
 */
export function s4hPublicCloudLogin(conf: RemoteConfig): (() => Promise<string>) | undefined {
  if (!conf.s4hPublicCloud?.enabled) return undefined

  return async () => {
    const ticket = await getValidTicket(conf)
    return ticket
  }
}

/**
 * Save ticket to vault for persistence (optional)
 */
export async function saveS4HTicketToVault(conf: RemoteConfig, ticket: string): Promise<void> {
  if (!conf.s4hPublicCloud?.saveCredentials) return

  try {
    const manager = RemoteManager.get()
    await manager.savePassword(conf.name, "s4h-ticket", ticket)
    log(`S4H ticket saved to vault for ${conf.name}`)
  } catch (error) {
    log(`Failed to save S4H ticket to vault: ${error}`)
  }
}

/**
 * Load ticket from vault (optional)
 */
export async function loadS4HTicketFromVault(conf: RemoteConfig): Promise<string | undefined> {
  if (!conf.s4hPublicCloud?.saveCredentials) return undefined

  try {
    const manager = RemoteManager.get()
    const ticket = await manager.getPassword(conf.name, "s4h-ticket")
    if (ticket) {
      log(`S4H ticket loaded from vault for ${conf.name}`)
      setS4HTicket(conf.name, ticket)
      return ticket
    }
  } catch (error) {
    log(`Failed to load S4H ticket from vault: ${error}`)
  }

  return undefined
}

/**
 * Force re-authentication by clearing stored ticket
 */
export async function reauthenticateS4H(conf: RemoteConfig): Promise<string> {
  const connId = formatKey(conf.name)
  clearS4HTicket(connId)
  return performS4HLogin(conf)
}

/**
 * Result of S4H setup authentication
 */
export interface S4HSetupResult {
  ticket: string
  systemId: string
  client: string
  username: string
  language: string
  languages: string[]
  apiUrl?: string  // The actual API URL to use for ADT calls
}

/**
 * Extract tenant ID from S4H URL
 * e.g., https://my418012.s4hana.cloud.sap -> my418012
 */
function extractTenantId(url: string): string {
  const match = url.match(/https?:\/\/([^.]+)\.s4hana\./i)
  return match ? match[1].toUpperCase() : "S4H"
}

/**
 * Perform S4H login for connection setup
 * Opens browser, gets ticket, and returns basic connection info
 * System info will be retrieved when the connection is actually established
 */
export async function performS4HLoginForSetup(baseUrl: string): Promise<S4HSetupResult | undefined> {
  try {
    log(`Starting S4H Public Cloud setup for ${baseUrl}`)

    // CRITICAL: Discover API URL FIRST (Eclipse ADT does this)
    // S4H Public Cloud has separate API and UI hosts
    const urls = await discoverS4HUrls(baseUrl)
    const apiUrl = urls?.apiUrl

    // Start local server
    const server = await createLoginServer()

    // Build auth URL and open browser
    const authUrl = buildAuthUrl(baseUrl)
    log(`Opening browser for S4H authentication: ${authUrl}`)

    await open(authUrl)

    // Wait for callback with ticket
    const ticket = await waitForTicket(server)

    log(`S4H login successful, ticket received`)

    // Store ticket by URL so it can be retrieved when establishing the connection
    // This prevents the browser from opening twice (once during setup, once during connect)
    const normalizedUrl = baseUrl.toLowerCase().replace(/\/$/, "")
    ticketsByUrl.set(normalizedUrl, {
      ticket,
      timestamp: Date.now(),
      apiUrl  // Store the API URL with the ticket
    })

    // Extract tenant ID from URL as a reasonable default for connection name
    const tenantId = extractTenantId(baseUrl)

    // Return basic info - actual system details will be retrieved on first connection
    return {
      ticket,
      systemId: tenantId,
      client: "080", // Default S4H Public Cloud client
      username: "", // Will be determined on connection
      language: "en",
      languages: ["en", "de"], // Common defaults
      apiUrl  // Include the API URL in the result
    }
  } catch (error) {
    log(`S4H setup failed: ${error}`)
    throw error
  }
}
