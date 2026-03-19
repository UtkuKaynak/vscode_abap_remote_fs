import { AbapObjectBase } from "../AbapObject"
import { AbapObjectCreator } from ".."
const tag = Symbol("AbapClass")

@AbapObjectCreator("DDLS/DF", "DCLS/DL", "DDLX/EX", "BDEF/BDO", "SRVD/SRV", "DSFD/SCF", "DFSD/SCF")
export class AbapCds extends AbapObjectBase {
  public [tag] = true
  get extension(): string {
    switch (this.type) {
      case "DDLS/DF":
        return ".ddls.asddls"
      case "DCLS/DL":
        return ".dcls.asdcls"
      case "DDLX/EX":
        return ".ddlx.asddlxs"
      case "BDEF/BDO":
        return ".bdef.asbdef"
      case "SRVD/SRV": // not properly cds but similar syntax
        return ".srvd.srvdsrv"
      case "DSFD/SCF": // CDS scalar function definition
      case "DFSD/SCF": // alternative type code
        return ".dsfd.asdsfd"
    }
    return ".cds" // should never happen...
  }
  get expandable() {
    return false
  }
  set expandable(_: boolean) {
    // ignore
  }
  public async mainPrograms() {
    return []
  }
}
export const isAbapCds = (x: any): x is AbapCds => !!x?.[tag]
