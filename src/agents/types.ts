export type AgentName = 'coordinator' | 'treasury' | 'market' | 'swap' | 'yield' | 'risk' | 'bridge';
export type RiskTier = 'APPROVE' | 'REVIEW' | 'BLOCK';

export interface AgentPermissions {
  allowedIntents: string[];
  maxTransactionUsdt?: number;
  allowedTokens?: string[];
  allowedContracts?: string[];
}

export interface AgentRequest {
  intent: string;
  params: Record<string, string>;
  userId: string;
}

export interface AgentResponse {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  reasoning?: string;
  riskScore?: number;
  riskTier?: RiskTier;
}

export interface ExecutionReceiptContext {
  source?: string;
  policy?: string;
  reason?: string;
  summary?: string;
  beforeState?: unknown;
  afterState?: unknown;
  signals?: unknown;
}

export interface Agent {
  name: AgentName;
  description: string;
  permissions?: AgentPermissions;
  execute(request: AgentRequest): Promise<AgentResponse>;
}

export interface RouteDecision {
  agent: AgentName;
  intent: string;
  params: Record<string, string>;
  plan?: string[];
  receiptContext?: ExecutionReceiptContext;
  systemActor?: string;
}
