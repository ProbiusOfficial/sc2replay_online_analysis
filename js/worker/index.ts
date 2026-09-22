/**
 * 主线程侧的解析调用层。
 *
 * 职责：管理 Worker 生命周期与请求/响应配对。所有解析与计算都在 Worker 里发生，
 * 主线程不接触协议解码，也不做数值计算 —— 这是 §1.3「解析阻塞主线程」的修复点。
 *
 * 契约见 `plans/ROUTE-C-WASM-REFACTOR-PLAN.md` §4.1。
 * P0 阶段仅 `ping()` 是真实可用的；`parseReplay` / `skipCache` 会由 Worker
 * 明确返回 `NOT_IMPLEMENTED`，不会假装成功。
 */
import {
  type ParseResponse,
  type PingRequest,
  type PongResponse,
  type SkipRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./contract.js";

const WORKER_URL = new URL("./parse.worker.js", import.meta.url);

interface PendingEntry {
  resolve: (response: WorkerResponse) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<string, PendingEntry>();

function nextId(): string {
  seq += 1;
  return `r${seq}`;
}

function getWorker(): Worker {
  if (worker) return worker;

  const instance = new Worker(WORKER_URL, { type: "module", name: "sc2-parse" });

  instance.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    entry.resolve(response);
  });

  instance.addEventListener("error", (event) => {
    // Worker 整体崩溃：把在途请求全部失败掉，避免调用方永久挂起。
    const err = new Error(event.message || "解析 Worker 发生未捕获错误");
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      entry.reject(err);
    }
    worker = null;
  });

  worker = instance;
  return instance;
}

function request<T extends WorkerResponse>(
  message: WorkerRequest,
  transfer: Transferable[] = [],
): Promise<T> {
  const instance = getWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(message.id, {
      resolve: resolve as (response: WorkerResponse) => void,
      reject,
    });
    instance.postMessage(message, transfer);
  });
}

/** P0 冒烟：确认 Worker 通道与 wasm 加载都正常。 */
export function ping(id: string = nextId()): Promise<PongResponse> {
  const message: PingRequest = { type: "ping", id };
  return request<PongResponse>(message);
}

/**
 * 请求解析一份录像。`buffer` 以 Transferable 移交，返回后主线程不再持有该 ArrayBuffer。
 */
export function parseReplay(
  buffer: ArrayBuffer,
  md5: string,
  id: string = nextId(),
): Promise<ParseResponse> {
  const message: WorkerRequest = { type: "parse", id, md5, buffer };
  return request<ParseResponse>(message, [buffer]);
}

/** 绕过 IndexedDB 缓存，强制重新解析。 */
export function skipCache(md5: string, id: string = nextId()): Promise<ParseResponse> {
  const message: SkipRequest = { type: "skipCache", id, md5 };
  return request<ParseResponse>(message);
}

/** 释放 Worker。批量任务结束后调用，避免常驻线程占内存。 */
export function terminateWorker(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
  pending.clear();
}

export { PARSER_VERSION } from "./contract.js";
