// Public surface of the detection engine. Both the on-demand API and the cron
// alert worker import from here; the web UI imports the types.
export * from './types.js';
export * from './constants.js';
export {
  evaluateRepo,
  evaluateAccount,
  cloneConfidence,
  buildCloneMatch,
} from './evaluate.js';
export type { EvaluateAccountInput, CloneSignals } from './evaluate.js';
export { scoreFromFindings, bandForScore, maxBand, isFlagged } from './score.js';
export { REPO_RULES } from './rules/repo-rules.js';
export { ACCOUNT_RULES } from './rules/account-rules.js';
