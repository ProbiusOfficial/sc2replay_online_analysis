/**
 * 主线程 ↔ 解析 Worker 的消息契约。
 * 对应 plans/ROUTE-C-WASM-REFACTOR-PLAN.md §4.1。
 *
 * `ReplayData` 的形状**只有一个定义处** —— `decoder/replay_data.ts`。
 * 这里直接 re-export，不另写一份：早期版本用 `Record<string, unknown>` 占位，
 * 那种「两边各写一遍」的做法迟早会漂移。
 */
import type { ReplayData } from "./decoder/replay_data.js";

export type { ReplayData };

/**
 * 解析结果缓存键的版本号（§4.3 `meta` store）。
 * 解析逻辑发生不兼容变更时必须递增，否则 IndexedDB 会返回陈旧结果。
 */
export const PARSER_VERSION = "1";

/** 请求解析一份录像。`buffer` 通过 Transferable 移交，调用后主线程不再持有。 */
export type ParseRequest = {
  type: "parse";
  id: string;
  md5: string;
  buffer: ArrayBuffer;
};

/**
 * 请求绕过缓存重新解析。
 *
 * ⚠️ **目前必然失败**：§4.3 的 IndexedDB 缓存层（P2）尚未实现，Worker 手里没有
 * 「md5 → 录像字节」的表，也没有任何缓存可绕。这个请求有意保留在契约里，
 * 但不做假装 —— Worker 会明确回 `NOT_IMPLEMENTED`。
 */
export type SkipRequest = { type: "skipCache"; id: string; md5: string };

/** 冒烟请求：只验证 Worker 通道与 wasm 加载，不做解析。 */
export type PingRequest = { type: "ping"; id: string };

export type WorkerRequest = ParseRequest | SkipRequest | PingRequest;

export type ParseResponse =
  | { type: "ok"; id: string; md5: string; cached: boolean; data: ReplayData }
  | { type: "error"; id: string; md5: string; message: string; code?: string };

/** 冒烟响应。`message` 由 wasm 侧的 `ping()` 产出，用于确认产物确实被加载。 */
export type PongResponse = { type: "pong"; id: string; message: string };

export type WorkerResponse = ParseResponse | PongResponse;

/** 错误码：便于上层做分支处理，不要靠 message 文案判断。 */
export const ERROR_CODES = {
  notImplemented: "NOT_IMPLEMENTED",
  wasmInitFailed: "WASM_INIT_FAILED",
  parseFailed: "PARSE_FAILED",
  badRequest: "BAD_REQUEST",
} as const;
