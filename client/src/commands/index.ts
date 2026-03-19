export * from "./registry"
// Import commands.ts to ensure @command decorators are executed during module load
export { openObject } from "./commands"
