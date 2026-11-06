import { LicenseManager } from "../packages/licensing/src";
export async function licensedManager(directory: string) { const manager = new LicenseManager(directory); await manager.init(); return { manager }; }
