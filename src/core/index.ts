/**
 * SageRoute: trajectory-aware model routing for the proxy.
 *
 * Public surface. Everything the server, config loader, and management API need lives
 * here; the internals stay in the sibling modules.
 */

export {
  classifyError,
  digest,
  extractTrajectory,
  looksLikeFailure,
  outputText,
  type Trajectory,
  type TrajectoryStep,
} from "./evidence";
export {
  computeSignals,
  headline,
  renderEvidence,
  PING_PONG_THRESHOLD,
  RECENT_WINDOW,
  REPEAT_ACTION_OBS_THRESHOLD,
  REPEAT_ERROR_CLASS_THRESHOLD,
  type SignalInputs,
  type SignalReport,
} from "./signals";
export {
  HttpSageClient,
  OfflineSageClient,
  SageError,
  type SageChoiceOption,
  type SageClient,
  type SageDecision,
} from "./sage";
export {
  decide,
  INTERVENTION_QUESTION,
  ROUTE_INSTRUCTIONS,
  ROUTE_OPTIONS,
  type LadderState,
  type Verdict,
} from "./policy";
export {
  addTurnCost,
  clearSageRouteSessions,
  getSession,
  listSessions,
  peekSession,
  recordHistory,
  sessionIdFor,
  SESSION_IDLE_MS,
  type RouteHistoryEntry,
  type SageRouteSession,
} from "./session";
export {
  clientFor,
  concreteRequestBody,
  pricingFor,
  routeTurn,
  type RouteTurnResult,
} from "./router";
export {
  resolveSageRouteConfig,
  SAGEROUTE_ACTIONS,
  SAGEROUTE_DEFAULT_ALIAS,
  SAGEROUTE_DEFAULT_ENDPOINT,
  type SageRouteConfig,
  type SageRouteTier,
  type ResolvedSageRouteConfig,
  type SageRouteAction,
} from "./types";
export { sageRouteConfigIssues, sageRouteIdFromRawBody, sageRouteEnabled } from "./resolve";
