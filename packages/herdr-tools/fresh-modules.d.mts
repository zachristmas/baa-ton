export const MODULES_ROOT: string;
export function modulesVersion(root?: string): string;
export function freshImport(specifier: string, fromUrl: string | URL, version?: string): Promise<any>;
