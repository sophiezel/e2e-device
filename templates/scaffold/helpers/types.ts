/**
 * Common types for e2e-device diagnostic collection.
 */

export interface ProblemStack {
  timestamp: string;
  errorType: string;
  errorMessage: string;
  callStack?: string;
  screenshotPath?: string;
  domSnapshot?: string;
  networkLog?: any[];
  extra?: Record<string, unknown>;
}

export interface ReproductionPath {
  deviceModel: string;
  osVersion: string;
  webViewVersion: string;
  networkCondition: string;
  stepsToReproduce: string[];
  probability: string;
  extra?: Record<string, unknown>;
}

export interface SuggestedFix {
  caseId: string;
  approaches: string[];
  risk: string;
  estimatedEffort: string;
  references: string[];
}

export interface CaseRecord {
  caseId: string;
  outcome: string;
  rootCause?: string;
  message?: string;
  problemStack?: ProblemStack;
  reproductionPath?: ReproductionPath;
  suggestedFixes?: SuggestedFix[];
  recordedAt: string;
  extra?: Record<string, unknown>;
}
