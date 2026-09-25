export const ROOT_QUESTION_AUTO_ANSWER_MS: number;
export type ParsedQuestion = { question: string; options: Array<{ label: string; recommended: boolean }> };
export type AutoAnswerPlan =
  | { eligible: true; answers: Array<{ question: string; answer: string }> }
  | { eligible: false; reason: string };
export function parseQuestions(input: unknown): ParsedQuestion[];
export function autoAnswerPlan(input: unknown): AutoAnswerPlan;
export function autoAnswerText(plan: { answers: Array<{ question: string; answer: string }> }, minutes?: number): string;
export function createQuestionTimers(options?: {
  delayMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: any) => void;
}): {
  start(id: string, onDue: () => void): void;
  settle(id: string): boolean;
  pending(id: string): boolean;
  clear(): void;
};
