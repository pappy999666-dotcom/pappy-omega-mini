import { parentPort } from "node:worker_threads";
import {
  computeAutopromoteOccurrences,
  AutopromoteComputeInput,
  AutopromoteComputeResult,
} from "./autopromote-compute.js";

if (!parentPort) {
  throw new Error("This module must be run as a worker thread.");
}

parentPort.on("message", (msg: { id: number; type: string; payload: unknown }) => {
  const { id, type, payload } = msg;
  try {
    let result: unknown;
    switch (type) {
      case "autopromote:compute":
        result = computeAutopromoteOccurrences(payload as AutopromoteComputeInput);
        break;
      default:
        throw new Error(`Unknown CPU task type: ${type}`);
    }
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
