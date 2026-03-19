/**
 * Virtual Folders API for Released Objects
 *
 * This module implements the SAP ADT Virtual Folders API used for the "Released Objects" tree.
 * The API provides access to objects organized by their API release contracts like:
 * - EXTEND_IN_CLOUD_DEVELOPMENT
 * - USE_IN_CLOUD_DEVELOPMENT
 * - USE_IN_AMDP
 * etc.
 */

import { ADTClient } from "abap-adt-api"
import { log } from "../lib"

// Content types for Virtual Folders API
const CONTENT_TYPE_VF_REQUEST = "application/vnd.sap.adt.repository.virtualfolders.request.v1+xml"
const CONTENT_TYPE_VF_RESULT = "application/vnd.sap.adt.repository.virtualfolders.result.v1+xml"
// The facets endpoint uses a different content type
const CONTENT_TYPE_FACETS = "application/vnd.sap.adt.facets.v1+xml"

// API endpoints
const VF_FACETS_PATH = "/sap/bc/adt/repository/informationsystem/virtualfolders/facets"
const VF_CONTENTS_PATH = "/sap/bc/adt/repository/informationsystem/virtualfolders/contents"
// Alternative endpoint using selection query parameter (seen in atom:link responses)
const VF_BASE_PATH = "/sap/bc/adt/repository/informationsystem/virtualfolders"

/**
 * A facet value represents one option within a facet (e.g., "EXTEND_IN_CLOUD_DEVELOPMENT" within "apiContract")
 */
export interface VirtualFolderFacetValue {
  id: string
  label: string
  count?: number
}

/**
 * A facet represents a filter category (e.g., "apiContract", "objectType", "package")
 */
export interface VirtualFolderFacet {
  id: string
  label: string
  values: VirtualFolderFacetValue[]
  /** Can this facet be used for structuring (organizing) results? */
  isForStructuring?: boolean
  /** Can this facet be used for filtering? */
  isForFiltering?: boolean
  /** Is this facet hierarchical? */
  isHierarchical?: boolean
}

/**
 * An object in the virtual folders result
 */
export interface VirtualFolderObject {
  uri: string
  type: string
  name: string
  description?: string
  packageName?: string
}

/**
 * A subfolder in the virtual folders result
 */
export interface VirtualFolderSubfolder {
  facet: string
  value: string
  label: string
  count: number
}

/**
 * Result from the virtual folders contents API
 */
export interface VirtualFoldersResult {
  subfolders: VirtualFolderSubfolder[]
  objects: VirtualFolderObject[]
  totalCount: number
}

/**
 * Parameters for querying virtual folders contents
 */
export interface VirtualFoldersQueryParams {
  /** Facet preselections - map of facet ID to array of selected values */
  preselections?: Map<string, string[]>
  /** Which facets to include in response subfolders */
  wantedFacets?: string[]
  /** Object name search pattern (default: "*") */
  objectSearchPattern?: string
  /** Whether to include short descriptions */
  withDescriptions?: boolean
}

/**
 * Parse XML response for facets
 * The actual response format uses:
 * - vf:facet with key="..." displayName="..." isForStructuring="..." isForFiltering="..." attributes
 * - vf:value with key="..." displayName="..." count="..." attributes (optional children)
 */
function parseFacetsXml(xml: string): VirtualFolderFacet[] {
  const facets: VirtualFolderFacet[] = []

  // Match facets with namespace prefix (vf:facet) or without
  // The facet element might be self-closing or have content
  // Attributes: key, displayName, isForStructuring, isForFiltering, isHierarchical
  const facetRegex = /<(?:vf:)?facet([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:vf:)?facet>)/gi

  const facetMatches = xml.matchAll(facetRegex)

  for (const match of facetMatches) {
    const attrs = match[1]
    const facetContent = match[2] || ""

    // Extract key (required)
    const keyMatch = attrs.match(/key="([^"]*)"/)
    if (!keyMatch) continue
    const facetId = keyMatch[1]

    // Extract displayName (optional, fallback to key)
    const displayNameMatch = attrs.match(/displayName="([^"]*)"/)
    const facetLabel = displayNameMatch ? displayNameMatch[1] : facetId

    // Extract boolean attributes
    const isForStructuringMatch = attrs.match(/isForStructuring="([^"]*)"/)
    const isForFilteringMatch = attrs.match(/isForFiltering="([^"]*)"/)
    const isHierarchicalMatch = attrs.match(/isHierarchical="([^"]*)"/)

    const isForStructuring = isForStructuringMatch ? isForStructuringMatch[1] === "true" : true // default true per XSD
    const isForFiltering = isForFilteringMatch ? isForFilteringMatch[1] === "true" : true // default true per XSD
    const isHierarchical = isHierarchicalMatch ? isHierarchicalMatch[1] === "true" : undefined

    const values: VirtualFolderFacetValue[] = []

    // Match values with namespace prefix or without (if facet has content)
    if (facetContent) {
      const valueRegex = /<(?:vf:)?value[^>]*?(?:key|id)="([^"]*)"[^>]*?(?:displayName|label)="([^"]*)"(?:[^>]*?count="([^"]*)")?[^>]*?\/?>/gi
      const valueMatches = facetContent.matchAll(valueRegex)
      for (const valueMatch of valueMatches) {
        values.push({
          id: valueMatch[1],
          label: valueMatch[2],
          count: valueMatch[3] ? parseInt(valueMatch[3], 10) : undefined
        })
      }
    }

    facets.push({
      id: facetId,
      label: facetLabel,
      values,
      isForStructuring,
      isForFiltering,
      isHierarchical
    })
  }

  return facets
}

/**
 * Extended result from the virtual folders contents API
 * Includes additional metadata like links and preselection info
 */
export interface VirtualFoldersResultExtended extends VirtualFoldersResult {
  /** Link for next level selection (from atom:link with virtualfolders/selection relation) */
  selectionLink?: string
  /** Preselection info from response */
  preselectionInfo: Array<{ facet: string; hasChildrenOfSameFacet: boolean }>
}

/**
 * Parse XML response for virtual folders contents
 *
 * Based on EMF model (virtualfolders.ecore):
 * - VirtualFoldersResult has objectCount attribute and contains:
 *   - virtualFolder elements (for subfolders)
 *   - object elements (for leaf objects)
 *   - preselectionInfo elements (metadata about which facets can be drilled into)
 *   - atom:link elements (navigation links)
 *
 * - VirtualFolder attributes: counter, displayName, facet, hasChildrenOfSameFacet, name, text
 * - Object attributes: expandable, name, package, text, type, version + links children
 */
function parseContentsXml(xml: string): VirtualFoldersResultExtended {
  const subfolders: VirtualFolderSubfolder[] = []
  const objects: VirtualFolderObject[] = []
  const preselectionInfo: Array<{ facet: string; hasChildrenOfSameFacet: boolean }> = []
  let totalCount = 0
  let selectionLink: string | undefined

  // Parse total count (objectCount attribute on virtualFoldersResult)
  const countMatch = xml.match(/objectCount="(\d+)"/)
  if (countMatch) {
    totalCount = parseInt(countMatch[1], 10)
  }

  // Parse preselectionInfo elements
  const preselectionInfoRegex = /<(?:vfs:)?preselectionInfo([^>]*)\/?>/gi
  const preselectionInfoMatches = xml.matchAll(preselectionInfoRegex)
  for (const match of preselectionInfoMatches) {
    const attrs = match[1]
    const facetMatch = attrs.match(/facet="([^"]*)"/)
    const hasChildrenMatch = attrs.match(/hasChildrenOfSameFacet="([^"]*)"/)
    if (facetMatch) {
      preselectionInfo.push({
        facet: facetMatch[1],
        hasChildrenOfSameFacet: hasChildrenMatch ? hasChildrenMatch[1] === "true" : false
      })
    }
  }

  // Parse atom:link with virtualfolders/selection relation
  const selectionLinkRegex = /<(?:atom:)?link[^>]*rel="[^"]*virtualfolders\/selection[^"]*"[^>]*href="([^"]*)"[^>]*\/?>/gi
  const selectionLinkMatch = selectionLinkRegex.exec(xml)
  if (selectionLinkMatch) {
    selectionLink = selectionLinkMatch[1]
  }

  // Parse virtualFolder elements (subfolders)
  // Attributes: counter, displayName, facet, hasChildrenOfSameFacet, name, text
  // The regex needs to handle attributes in any order
  // IMPORTANT: Use word boundary or explicit space/> after "virtualFolder" to avoid matching "virtualFoldersResult"
  const virtualFolderRegex = /<(?:vfs:)?virtualFolder(?:\s|>)([^>]*)(?:\/>|>[\s\S]*?<\/(?:vfs:)?virtualFolder>)/gi
  const virtualFolderMatches = xml.matchAll(virtualFolderRegex)
  for (const match of virtualFolderMatches) {
    const attrs = match[1]
    const facetMatch = attrs.match(/facet="([^"]*)"/)
    const nameMatch = attrs.match(/name="([^"]*)"/)
    const displayNameMatch = attrs.match(/displayName="([^"]*)"/)
    const textMatch = attrs.match(/text="([^"]*)"/)
    const counterMatch = attrs.match(/counter="([^"]*)"/)

    if (facetMatch && nameMatch) {
      subfolders.push({
        facet: facetMatch[1],
        value: nameMatch[1],
        label: displayNameMatch ? displayNameMatch[1] : (textMatch ? textMatch[1] : nameMatch[1]),
        count: counterMatch ? parseInt(counterMatch[1], 10) : 0
      })
    }
  }

  // Parse object elements
  // Attributes: expandable, name, package, text, type, version
  // Links are child elements but we extract URI from links
  const objectRegex = /<(?:vfs:)?object([^>]*)(?:\/>|>([\s\S]*?)<\/(?:vfs:)?object>)/gi
  const objectMatches = xml.matchAll(objectRegex)
  for (const match of objectMatches) {
    const attrs = match[1]
    const content = match[2] || ""

    const nameMatch = attrs.match(/name="([^"]*)"/)
    const typeMatch = attrs.match(/type="([^"]*)"/)
    const textMatch = attrs.match(/text="([^"]*)"/)
    const packageMatch = attrs.match(/package="([^"]*)"/)

    // Extract URI from atom:link with rel="self" or first link
    let uri = ""
    const linkMatch = content.match(/<(?:atom:)?link[^>]*href="([^"]*)"[^>]*\/>/)
    if (linkMatch) {
      uri = linkMatch[1]
    }

    if (nameMatch && typeMatch) {
      objects.push({
        uri,
        type: typeMatch[1],
        name: nameMatch[1],
        description: textMatch ? textMatch[1] : undefined,
        packageName: packageMatch ? packageMatch[1] : undefined
      })
    }
  }

  return { subfolders, objects, totalCount, selectionLink, preselectionInfo }
}

/**
 * Build XML request body for virtual folders contents query
 *
 * Based on EMF model from Eclipse ADT (virtualfolders.ecore):
 * - Namespace: http://www.sap.com/adt/ris/virtualFolders with prefix "vfs"
 * - VirtualFoldersRequest has:
 *   - preselection: child elements (0..*)
 *   - facetorder: child element (ALWAYS included, even if empty)
 *   - objectSearchPattern: attribute
 *
 * - PreselectedFacet has:
 *   - facet: attribute (required)
 *   - value: child elements (1..*) - VALUES ARE UPPERCASED per Eclipse behavior
 *
 * - FacetOrder has:
 *   - facet: child elements (1..*)
 *
 * IMPORTANT: Eclipse ADT ALWAYS includes facetorder element and ALWAYS
 * uppercases preselection values. This matches AdtRisVirtualFoldersSearchService.java
 * and VirtualFolderContentProvider.java behavior.
 */
function buildContentsRequestXml(params: VirtualFoldersQueryParams): string {
  const searchPattern = params.objectSearchPattern || "*"

  // Build preselection child elements
  // IMPORTANT: Eclipse uppercases all preselection values
  let preselectionElements = ""
  if (params.preselections && params.preselections.size > 0) {
    for (const [facet, values] of params.preselections) {
      // Each preselection has a facet attribute and value child elements
      // Values are uppercased per Eclipse behavior (VirtualFolderContentProvider.createParameters)
      const valueElements = values.map(v => `<vfs:value>${v.toUpperCase()}</vfs:value>`).join("")
      preselectionElements += `<vfs:preselection facet="${facet}">${valueElements}</vfs:preselection>`
    }
  }

  // Build facetorder child element
  // IMPORTANT: Eclipse ALWAYS includes facetorder, even if empty
  // This matches AdtRisVirtualFoldersSearchService.getContentInternal behavior
  let facetorderElement = "<vfs:facetorder/>"
  if (params.wantedFacets && params.wantedFacets.length > 0) {
    const facetElements = params.wantedFacets.map(f => `<vfs:facet>${f}</vfs:facet>`).join("")
    facetorderElement = `<vfs:facetorder>${facetElements}</vfs:facetorder>`
  }

  // Combine into full request - always include facetorder
  return `<?xml version="1.0" encoding="UTF-8"?><vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders" objectSearchPattern="${searchPattern}">${preselectionElements}${facetorderElement}</vfs:virtualFoldersRequest>`
}

/**
 * Service for accessing the Virtual Folders API
 */
export class VirtualFoldersService {
  private cachedFacets: VirtualFolderFacet[] | null = null

  constructor(private client: ADTClient) {}

  /**
   * Clear cached facets (useful for debugging)
   */
  clearCache(): void {
    this.cachedFacets = null
  }

  /**
   * Check if the virtual folders API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Try to fetch facets - if it fails, the API is not available
      const facets = await this.getFacets()
      log(`[Released Objects] Facets API returned ${facets.length} facets`)
      return facets.length > 0
    } catch (error) {
      log(`[Released Objects] Facets API not available: ${error}`)
      return false
    }
  }

  /**
   * Get available facets for filtering (cached)
   */
  async getFacets(): Promise<VirtualFolderFacet[]> {
    if (this.cachedFacets) {
      return this.cachedFacets
    }

    const response = await (this.client as any).httpClient.request(VF_FACETS_PATH, {
      method: "GET",
      headers: {
        Accept: CONTENT_TYPE_FACETS
      }
    })

    if (response.status >= 400) {
      throw new Error(`Failed to get virtual folder facets: ${response.status}`)
    }

    this.cachedFacets = parseFacetsXml(response.body)
    log(`[Released Objects] Loaded ${this.cachedFacets.length} facets`)
    return this.cachedFacets
  }

  /**
   * Get the facet IDs for API, group, and type
   * Based on Eclipse ADT's FacetProviderBase.java:
   * - api: API release state
   * - group: Object groups/categories (Classes, Interfaces, etc.)
   * - type: Specific object types (CLAS, INTF, etc.)
   */
  async getFacetIdMapping(): Promise<{
    apiFacet: string | null
    groupFacet: string | null
    typeFacet: string | null
    structuringFacets: string[]
  }> {
    const facets = await this.getFacets()

    // Find all facets that can be used for structuring
    const structuringFacets = facets
      .filter(f => f.isForStructuring !== false)
      .map(f => f.id)

    // Find API facet (Eclipse uses "api")
    let apiFacet: string | null = null
    const apiNames = ["api", "apicontract", "releasecontract", "releasestate"]
    for (const name of apiNames) {
      const found = facets.find(f => f.id.toLowerCase() === name)
      if (found) {
        apiFacet = found.id
        break
      }
    }

    // Find group facet - Eclipse uses "group" for object categories
    // This is what Eclipse uses for folder hierarchy (Classes, Interfaces, etc.)
    let groupFacet: string | null = null
    const groupNames = ["group", "objectgroup", "objgroup", "category", "objectcategory"]
    for (const name of groupNames) {
      const found = facets.find(f => f.id.toLowerCase() === name)
      if (found) {
        groupFacet = found.id
        break
      }
    }

    // Find type facet - Eclipse uses "type" for specific object types
    let typeFacet: string | null = null
    const typeNames = ["type", "objecttype", "objtype", "obj_type", "object_type"]
    for (const name of typeNames) {
      const found = facets.find(f => f.id.toLowerCase() === name)
      if (found) {
        typeFacet = found.id
        break
      }
    }

    return { apiFacet, groupFacet, typeFacet, structuringFacets }
  }

  /**
   * Get the facet IDs for object categorization (group and type)
   * Based on Eclipse ADT naming conventions
   */
  async getGroupAndTypeFacetIds(): Promise<{ groupFacet: string | null; typeFacet: string | null }> {
    const { groupFacet, typeFacet } = await this.getFacetIdMapping()
    return { groupFacet, typeFacet }
  }

  /**
   * Get virtual folders contents with optional filtering
   */
  async getContents(params: VirtualFoldersQueryParams = {}): Promise<VirtualFoldersResultExtended> {
    const body = buildContentsRequestXml(params)

    // Build query string
    const qs: Record<string, string> = {}
    if (params.withDescriptions === false) {
      qs.ignoreShortDescriptions = "true"
    }

    const response = await (this.client as any).httpClient.request(VF_CONTENTS_PATH, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE_VF_REQUEST,
        Accept: CONTENT_TYPE_VF_RESULT
      },
      body,
      qs
    })

    if (response.status >= 400) {
      log(`[Released Objects] Contents API error: ${response.status}, body: ${response.body?.substring?.(0, 500)}`)
      throw new Error(`Failed to get virtual folder contents: ${response.status}`)
    }

    // Log start of response to see structure (preselectionInfo, links, virtualFolder elements)
    const responseStart = response.body?.substring?.(0, 3000)
    log(`[Released Objects] Response start:\n${responseStart}`)

    const result = parseContentsXml(response.body)
    log(`[Released Objects] Contents result: ${result.subfolders.length} subfolders, ${result.objects.length} objects, total=${result.totalCount}`)

    // Log additional info for debugging hierarchy issues
    if (result.preselectionInfo.length > 0) {
      log(`[Released Objects] PreselectionInfo: ${JSON.stringify(result.preselectionInfo)}`)
    }
    if (result.selectionLink) {
      log(`[Released Objects] SelectionLink: ${result.selectionLink}`)
    }

    return result
  }

  /**
   * Get API release contracts with counts (convenience method)
   * Returns the available API stability contracts like EXTEND_IN_CLOUD_DEVELOPMENT, USE_IN_CLOUD_DEVELOPMENT, etc.
   *
   * Uses the contents API to get counts for each contract.
   */
  async getApiContracts(): Promise<VirtualFolderFacetValue[]> {
    const { apiFacet } = await this.getFacetIdMapping()
    const actualApiFacet = apiFacet || "api"

    // Query the contents API with wantedFacets=[api] to get virtualFolder elements with counts
    // This is how Eclipse gets the contract list with counts
    const result = await this.getContents({
      wantedFacets: [actualApiFacet],
      withDescriptions: true
    })

    // Convert subfolders to VirtualFolderFacetValue format
    if (result.subfolders.length > 0) {
      return result.subfolders.map(sf => ({
        id: sf.value,
        label: sf.label,
        count: sf.count
      }))
    }

    // Fallback: try to get from facets API (without counts)
    const facets = await this.getFacets()
    const apiContractFacet = facets.find(f =>
      f.id === "apiContract" ||
      f.id === "releaseContract" ||
      f.id === "releasestate" ||
      f.id === "apistate" ||
      f.id === "api" ||
      f.id.toLowerCase().includes("release") ||
      f.id.toLowerCase().includes("contract")
    )

    if (apiContractFacet) {
      if (apiContractFacet.values.length > 0) {
        return apiContractFacet.values
      }

      try {
        const values = await this.getFacetValues(apiContractFacet.id)
        return values
      } catch (e) {
        log(`[Released Objects] Failed to fetch facet values: ${e}`)
      }
    }

    return []
  }

  /**
   * Fetch values for a specific facet using the properties API
   */
  async getFacetValues(facetId: string): Promise<VirtualFolderFacetValue[]> {
    const path = `/sap/bc/adt/repository/informationsystem/properties/values?data=${facetId}`

    const response = await (this.client as any).httpClient.request(path, {
      method: "GET",
      headers: {
        Accept: "application/xml, application/vnd.sap.adt.properties.values.v1+xml"
      }
    })

    if (response.status >= 400) {
      throw new Error(`Failed to get facet values: ${response.status}`)
    }

    // Parse the values response
    return this.parseFacetValuesXml(response.body)
  }

  /**
   * Parse facet values from the properties API response
   */
  private parseFacetValuesXml(xml: string): VirtualFolderFacetValue[] {
    const values: VirtualFolderFacetValue[] = []

    // Format 1: namedItemList with nested elements
    // <nameditem:namedItem>
    //   <nameditem:name>EXTEND_IN_KEY_USER_APPS</nameditem:name>
    //   <nameditem:description>Extend in Key User Apps</nameditem:description>
    // </nameditem:namedItem>
    const namedItemRegex = /<(?:\w+:)?namedItem[^>]*>([\s\S]*?)<\/(?:\w+:)?namedItem>/gi
    const namedItemMatches = xml.matchAll(namedItemRegex)
    for (const match of namedItemMatches) {
      const content = match[1]
      const nameMatch = content.match(/<(?:\w+:)?name[^>]*>([^<]*)<\/(?:\w+:)?name>/i)
      const descMatch = content.match(/<(?:\w+:)?description[^>]*>([^<]*)<\/(?:\w+:)?description>/i)
      if (nameMatch) {
        values.push({
          id: nameMatch[1],
          label: descMatch ? descMatch[1] : nameMatch[1],
          count: undefined
        })
      }
    }

    // Format 2: attribute-based (fallback)
    // <value key="..." displayName="..."/>
    // <prop:value key="..." text="..."/>
    // <item id="..." name="..."/>
    if (values.length === 0) {
      const valueRegex = /<(?:\w+:)?(?:value|item)[^>]*?(?:key|id)="([^"]*)"[^>]*?(?:displayName|text|name)="([^"]*)"(?:[^>]*?count="([^"]*)")?[^>]*?\/?>/gi
      const attrMatches = xml.matchAll(valueRegex)
      for (const match of attrMatches) {
        values.push({
          id: match[1],
          label: match[2],
          count: match[3] ? parseInt(match[3], 10) : undefined
        })
      }
    }

    return values
  }

  /**
   * Get virtual folders using the selection parameter approach
   * This uses the endpoint: /sap/bc/adt/repository/informationsystem/virtualfolders?selection=api:VALUE
   *
   * This is an alternative approach seen in the atom:link returned by the server
   */
  async getVirtualFoldersWithSelection(selection: string): Promise<VirtualFoldersResultExtended> {
    const path = `${VF_BASE_PATH}?selection=${encodeURIComponent(selection)}`

    const response = await (this.client as any).httpClient.request(path, {
      method: "GET",
      headers: {
        Accept: CONTENT_TYPE_VF_RESULT
      }
    })

    if (response.status >= 400) {
      throw new Error(`Failed to get virtual folders with selection: ${response.status}`)
    }

    return parseContentsXml(response.body)
  }

  /**
   * Get objects for a specific API contract
   * Uses dynamic facet IDs from the server
   *
   * When we select an API contract (like USE_IN_CLOUD_DEVELOPMENT), we want
   * the server to organize results by group (e.g., "Classes", "Interfaces").
   *
   * Based on Eclipse ADT behavior:
   * 1. Preselect the API facet with the contract value (uppercased)
   * 2. Request grouping by the "group" facet
   */
  async getObjectsByContract(contract: string): Promise<VirtualFoldersResultExtended> {
    const { apiFacet, groupFacet } = await this.getFacetIdMapping()
    const actualApiFacet = apiFacet || "api"
    const actualGroupFacet = groupFacet || "group"

    // Build preselections with the API contract
    const preselections = new Map<string, string[]>()
    preselections.set(actualApiFacet, [contract])

    // Request grouping by the "group" facet (like Eclipse does)
    // This should return virtualFolder elements instead of flat objects
    const result = await this.getContents({
      preselections,
      wantedFacets: [actualGroupFacet],
      withDescriptions: true
    })

    log(`[Released Objects] getObjectsByContract(${contract}): ${result.subfolders.length} subfolders, ${result.objects.length} objects`)

    return result
  }

  /**
   * Follow a selection link URL to get the next level of results
   * Used for navigating the hierarchy via atom:link URLs
   */
  async followSelectionLink(linkUrl: string): Promise<VirtualFoldersResultExtended> {
    const response = await (this.client as any).httpClient.request(linkUrl, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE_VF_REQUEST,
        Accept: CONTENT_TYPE_VF_RESULT
      },
      body: buildContentsRequestXml({})
    })

    if (response.status >= 400) {
      throw new Error(`Failed to follow selection link: ${response.status}`)
    }

    return parseContentsXml(response.body)
  }
}

// Cache for virtual folders services per client
const servicesCache = new WeakMap<ADTClient, VirtualFoldersService>()

/**
 * Get or create a VirtualFoldersService for the given client
 */
export function getVirtualFoldersService(client: ADTClient): VirtualFoldersService {
  let service = servicesCache.get(client)
  if (!service) {
    service = new VirtualFoldersService(client)
    servicesCache.set(client, service)
  }
  return service
}
