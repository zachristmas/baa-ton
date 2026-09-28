export const JOURNAL_PATH: RegExp;
export function journalOrderProblems(beforeText: string | undefined, afterText: string, path?: string): string[];
export function mergeJournalProblems(repo: string, sha: string, base: string, options?: { timeout?: number }): Promise<string[]>;
