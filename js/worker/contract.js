/**
 * 解析结果缓存键的版本号（§4.3 `meta` store）。
 * 解析逻辑发生不兼容变更时必须递增，否则 IndexedDB 会返回陈旧结果。
 */
export const PARSER_VERSION = "1";
/** 错误码：便于上层做分支处理，不要靠 message 文案判断。 */
export const ERROR_CODES = {
    notImplemented: "NOT_IMPLEMENTED",
    wasmInitFailed: "WASM_INIT_FAILED",
    parseFailed: "PARSE_FAILED",
    badRequest: "BAD_REQUEST",
};
