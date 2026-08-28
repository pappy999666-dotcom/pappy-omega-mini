import { env } from "../config/env.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxRequests?: number;
}

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number;
  openedAt: number;
  halfOpenRequests: number;
}

const state = new Map<string, CircuitBreakerState>();
let stateChangeHandler: ((name: string, from: CircuitState, to: CircuitState) => void) | undefined;

export function setCircuitBreakerStateChangeHandler(
  handler: (name: string, from: CircuitState, to: CircuitState) => void,
): void {
  stateChangeHandler = handler;
}

function getBreakerState(name: string): CircuitBreakerState {
  let breaker = state.get(name);
  if (!breaker) {
    breaker = {
      state: "CLOSED",
      failures: 0,
      successes: 0,
      lastFailureAt: 0,
      openedAt: 0,
      halfOpenRequests: 0,
    };
    state.set(name, breaker);
  }
  return breaker;
}

function transition(name: string, breaker: CircuitBreakerState, to: CircuitState): void {
  const from = breaker.state;
  if (from === to) return;
  breaker.state = to;
  stateChangeHandler?.(name, from, to);
}

export function isCircuitClosed(name: string): boolean {
  const breaker = getBreakerState(name);
  if (breaker.state === "CLOSED") return true;
  if (breaker.state === "OPEN") {
    if (Date.now() - breaker.openedAt >= env.CIRCUIT_BREAKER_RESET_MS) {
      transition(name, breaker, "HALF_OPEN");
      breaker.halfOpenRequests = 0;
      return true;
    }
    return false;
  }
  return breaker.halfOpenRequests < 3;
}

export function recordCircuitSuccess(name: string): void {
  const breaker = getBreakerState(name);
  if (breaker.state === "HALF_OPEN") {
    breaker.successes++;
    if (breaker.successes >= 3) {
      transition(name, breaker, "CLOSED");
      breaker.failures = 0;
      breaker.successes = 0;
    }
  } else if (breaker.state === "CLOSED") {
    breaker.failures = Math.max(0, breaker.failures - 1);
  }
}

export function recordCircuitFailure(name: string): void {
  const breaker = getBreakerState(name);
  breaker.failures++;
  breaker.lastFailureAt = Date.now();
  if (breaker.state === "HALF_OPEN") {
    transition(name, breaker, "OPEN");
    breaker.openedAt = Date.now();
    return;
  }
  if (breaker.failures >= env.CIRCUIT_BREAKER_THRESHOLD) {
    transition(name, breaker, "OPEN");
    breaker.openedAt = Date.now();
  }
}

export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  options?: CircuitBreakerOptions,
): Promise<T> {
  if (!isCircuitClosed(name)) {
    throw new Error(`Circuit breaker is OPEN for ${name}`);
  }
  try {
    const result = await fn();
    recordCircuitSuccess(name);
    return result;
  } catch (error) {
    recordCircuitFailure(name);
    throw error;
  }
}

export function getCircuitBreakerSnapshot(name: string): {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
} {
  const breaker = getBreakerState(name);
  return {
    state: breaker.state,
    failures: breaker.failures,
    lastFailureAt: breaker.lastFailureAt,
  };
}

export function getAllCircuitBreakerSnapshots(): Record<
  string,
  { state: CircuitState; failures: number; lastFailureAt: number }
> {
  const result: Record<string, { state: CircuitState; failures: number; lastFailureAt: number }> = {};
  for (const [name] of state) {
    result[name] = getCircuitBreakerSnapshot(name);
  }
  return result;
}

export function resetCircuitBreaker(name: string): void {
  state.delete(name);
}

export function resetAllCircuitBreakers(): void {
  state.clear();
}
