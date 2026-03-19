/**
 * Released Objects Folder
 *
 * This module implements a folder structure for "Released Objects" organized by
 * API stability contracts like EXTEND_IN_CLOUD_DEVELOPMENT, USE_IN_CLOUD_DEVELOPMENT, etc.
 *
 * This is similar to the "Released Objects" view in Eclipse ADT.
 */

import { FileStat, FileType } from "vscode"
import { ADTClient } from "abap-adt-api"
import { Folder } from "abapfs"
import { VirtualFoldersService } from "./virtualFolders"

const releasedFolderTag = Symbol("releasedFolder")
const contractFolderTag = Symbol("contractFolder")
const categoryFolderTag = Symbol("categoryFolder")
const objectTypeFolderTag = Symbol("objectTypeFolder")

/**
 * Represents a leaf object (like a class or interface) in the Released Objects tree
 */
export class ReleasedObject implements FileStat {
  type = FileType.File
  ctime = Date.now()
  mtime = Date.now()
  size = 0

  constructor(
    readonly uri: string,
    readonly objectType: string,
    readonly name: string,
    readonly description?: string,
    readonly packageName?: string
  ) {}
}

/**
 * Represents an object type folder within a category (e.g., "Standard Classes" under "Classes")
 */
export class ObjectTypeFolder extends Folder {
  [objectTypeFolderTag] = true

  constructor(
    readonly vfService: VirtualFoldersService,
    readonly apiFacetId: string,       // actual facet ID for API
    readonly categoryFacetId: string,  // actual facet ID for category
    readonly typeFacetId: string,      // actual facet ID for type
    readonly contractValue: string,
    readonly categoryValue: string,
    readonly typeValue: string,
    readonly label: string,
    readonly count: number
  ) {
    super()
  }

  private loaded = false

  async refresh(): Promise<void> {
    if (this.loaded) return

    try {
      const preselections = new Map<string, string[]>()
      preselections.set(this.apiFacetId, [this.contractValue])
      preselections.set(this.categoryFacetId, [this.categoryValue])
      preselections.set(this.typeFacetId, [this.typeValue])

      const result = await this.vfService.getContents({
        preselections,
        wantedFacets: [],
        withDescriptions: true
      })

      // Add objects
      for (const obj of result.objects) {
        const relObj = new ReleasedObject(
          obj.uri,
          obj.type,
          obj.name,
          obj.description,
          obj.packageName
        )
        // Use object name as filename, ensure uniqueness
        // IMPORTANT: Replace forward slashes with a safe character to avoid path interpretation
        // Namespaced objects like /ATL/CL_BUP_CCARD_CHECK_ISRCRD contain slashes
        let fileName = obj.name.replace(/\//g, "∕")  // Use Unicode fraction slash (U+2215)
        if (this.get(fileName)) {
          fileName = `${fileName} (${obj.type.replace(/\//g, "∕")})`
        }
        this.set(fileName, relObj, false)
      }

      this.loaded = true
    } catch (error) {
      throw error
    }
  }
}

/**
 * Represents a group folder within a contract (e.g., "Classes", "Interfaces")
 * Eclipse ADT calls this "group" - it's the first level of categorization
 */
export class GroupFolder extends Folder {
  [categoryFolderTag] = true  // Keep the tag for backwards compatibility

  constructor(
    readonly vfService: VirtualFoldersService,
    readonly apiFacetId: string,       // actual facet ID for API
    readonly groupFacetId: string,     // actual facet ID for group (Eclipse's "group")
    readonly contractValue: string,
    readonly groupValue: string,
    readonly label: string,
    readonly count: number
  ) {
    super()
  }

  private loaded = false

  async refresh(): Promise<void> {
    if (this.loaded) return

    try {
      const preselections = new Map<string, string[]>()
      preselections.set(this.apiFacetId, [this.contractValue])
      preselections.set(this.groupFacetId, [this.groupValue])

      // Request grouping by "type" facet for the next level
      // This follows Eclipse's hierarchy: api -> group -> type
      const result = await this.vfService.getContents({
        preselections,
        wantedFacets: ["type"],  // Next level is object type
        withDescriptions: true
      })

      // Add subfolders (object types)
      for (const subfolder of result.subfolders) {
        const typeFolder = new ObjectTypeFolder(
          this.vfService,
          this.apiFacetId,
          this.groupFacetId,
          subfolder.facet,  // The subfolder's facet IS the type facet ID
          this.contractValue,
          this.groupValue,
          subfolder.value,
          subfolder.label,
          subfolder.count
        )
        // Include count in display name for consistency with other folder levels
        const displayName = subfolder.count > 0
          ? `${subfolder.label} (${subfolder.count.toLocaleString()})`
          : subfolder.label
        this.set(displayName, typeFolder, false)
      }

      // If no subfolders but objects exist, add objects directly
      if (result.subfolders.length === 0) {
        for (const obj of result.objects) {
          const relObj = new ReleasedObject(
            obj.uri,
            obj.type,
            obj.name,
            obj.description,
            obj.packageName
          )
          // Replace slashes with Unicode fraction slash to avoid path interpretation
          const fileName = obj.name.replace(/\//g, "∕")
          this.set(fileName, relObj, false)
        }
      }

      this.loaded = true
    } catch (error) {
      throw error
    }
  }
}

/**
 * Represents an API contract folder (e.g., "EXTEND_IN_CLOUD_DEVELOPMENT")
 */
export class ContractFolder extends Folder {
  [contractFolderTag] = true

  constructor(
    readonly vfService: VirtualFoldersService,
    readonly apiFacetId: string,  // actual facet ID for API (e.g., "api")
    readonly contractId: string,
    readonly label: string,
    readonly count?: number
  ) {
    super()
  }

  private loaded = false

  async refresh(): Promise<void> {
    if (this.loaded) return

    try {
      const result = await this.vfService.getObjectsByContract(this.contractId)

      // Create subfolders for each group
      // The subfolder.facet tells us the actual group facet ID (should be "group")
      // This follows Eclipse's hierarchy: api -> group -> type
      for (const subfolder of result.subfolders) {
        const groupFolder = new GroupFolder(
          this.vfService,
          this.apiFacetId,
          subfolder.facet,  // The subfolder's facet IS the group facet ID
          this.contractId,
          subfolder.value,
          subfolder.label,
          subfolder.count
        )
        this.set(`${subfolder.label} (${subfolder.count})`, groupFolder, false)
      }

      this.loaded = true
    } catch (error) {
      throw error
    }
  }
}

/**
 * Root folder for "Released Objects" tree
 * Contains API contract folders like EXTEND_IN_CLOUD_DEVELOPMENT, USE_IN_CLOUD_DEVELOPMENT, etc.
 */
export class ReleasedObjectsFolder extends Folder {
  [releasedFolderTag] = true

  private vfService: VirtualFoldersService
  private available: boolean | undefined

  constructor(client: ADTClient) {
    super()
    this.vfService = new VirtualFoldersService(client)
  }

  /**
   * Check if the Released Objects feature is available on this system
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available

    try {
      this.available = await this.vfService.isAvailable()
      return this.available
    } catch {
      this.available = false
      return false
    }
  }

  private loaded = false

  /**
   * Load the API contracts (implements refresh for the Folder interface)
   */
  async refresh(): Promise<void> {
    if (this.loaded) return

    try {
      // Get the actual API facet ID from the server
      const { apiFacet } = await this.vfService.getFacetIdMapping()
      const actualApiFacet = apiFacet || "api"

      const contracts = await this.vfService.getApiContracts()

      for (const contract of contracts) {
        const folder = new ContractFolder(
          this.vfService,
          actualApiFacet,  // Pass the actual API facet ID
          contract.id,
          contract.label,
          contract.count
        )
        // Format: "EXTEND_IN_CLOUD_DEVELOPMENT (1,234)" or just label if no count
        const displayName = contract.count !== undefined
          ? `${contract.label} (${contract.count.toLocaleString()})`
          : contract.label
        this.set(displayName, folder, false)
      }

      this.loaded = true
    } catch (error) {
      // Don't throw - allow graceful degradation
    }
  }

  /**
   * Get the VirtualFoldersService for child folders to use
   */
  getService(): VirtualFoldersService {
    return this.vfService
  }
}

export const isReleasedObjectsFolder = (x: any): x is ReleasedObjectsFolder =>
  !!x?.[releasedFolderTag]

export const isContractFolder = (x: any): x is ContractFolder =>
  !!x?.[contractFolderTag]

export const isGroupFolder = (x: any): x is GroupFolder =>
  !!x?.[categoryFolderTag]

// Alias for backwards compatibility
export const isCategoryFolder = isGroupFolder

// Export GroupFolder as CategoryFolder for backwards compatibility
export { GroupFolder as CategoryFolder }

export const isObjectTypeFolder = (x: any): x is ObjectTypeFolder =>
  !!x?.[objectTypeFolderTag]

export const isReleasedObject = (x: any): x is ReleasedObject =>
  x instanceof ReleasedObject
