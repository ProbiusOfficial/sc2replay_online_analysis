//! SC2 录像解析的计算密集内核。
//!
//! 职责边界（见 `plans/ROUTE-C-WASM-REFACTOR-PLAN.md` §2.1）：
//! 协议**解码**留在 TypeScript/JavaScript 侧，本 crate 只承担计算密集部分 ——
//! 因此 SC2 更新协议时不需要改动这里。
//!
//! 目前包含两类工作：
//!
//! 1. **`bzip2_decompress`** —— MPQ 解压。这项职责是在 P1 实测后加进来的：
//!    SC2 录像里的数据并非 zlib，而是 **bzip2**（5 个样本共 53 个压缩块，全部为 bzip2），
//!    而浏览器没有原生 bzip2。它位于每次解析的必经路径上，属于计算密集环节，
//!    放在这里同时满足「不引入未验证的第三方 JS 依赖」与「热路径用 Rust」两个约束。
//! 2. 位置插值 / 轨迹重建 / 热力图聚合 —— P3 落地（§4.2）。
//!
//! ## 结构约定（重要）
//!
//! **纯计算写在 `*_impl` 里，返回 `Result<_, String>`；`#[wasm_bindgen]` 导出层只做
//! 字符串 → `JsValue` 的转换。**
//!
//! 原因：`JsValue` 的构造在 non-wasm32 目标上是未实现的（会直接 panic，见
//! `wasm-bindgen/src/lib.rs` 的 "function not implemented on non-wasm32 targets"）。
//! 一旦把 `JsValue` 写进核心逻辑的返回类型，这些逻辑就**无法在 native 上跑 `cargo test`** ——
//! 而 P1 的验收依赖 native 单测与对拍脚本。保持这个分层，后续 P3 的计算同样受益。
//!
//! P0 遗留的 `ping()` 保留，作为「CI 编译 wasm → 页面加载成功」的链路探针。

use std::io::Read;

use wasm_bindgen::prelude::*;

/// P0 冒烟函数：确认 wasm 模块能被页面加载并调用。
///
/// 返回值带版本号，便于在浏览器控制台确认加载的是本次构建的产物。
#[wasm_bindgen]
pub fn ping() -> String {
    format!("compute.wasm pong (v{})", env!("CARGO_PKG_VERSION"))
}

/// 解压一段 bzip2 流（不含 MPQ 的压缩类型标记字节）。纯计算核心，可 native 测试。
///
/// MPQ 的每个压缩块首字节是压缩类型标记，`bzip2` 为 `0x10`；
/// 调用方需先剥掉该字节再把剩余数据传进来（见 `js/worker/decoder/mpq.ts`）。
pub fn bzip2_decompress_impl(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    bzip2_rs::DecoderReader::new(data)
        .read_to_end(&mut out)
        .map_err(|err| format!("bzip2 解压失败: {err}"))?;
    Ok(out)
}

/// wasm 导出层：把纯核心的错误信息转成 `JsValue`。
///
/// 正确性依据：`scripts/compare-parsers.mjs` 会对 5 个样本的全部 53 个压缩块
/// 逐块比对解压结果的 md5，基准来自 Python 的 `bz2`（即 libbz2）。
#[wasm_bindgen]
pub fn bzip2_decompress(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    bzip2_decompress_impl(data).map_err(|msg| JsValue::from_str(&msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由 Python 的 `bz2.compress` 生成，原文为
    /// `SC2 replay bzip2 decompress self-test payload 0123456789`（56 字节）。
    const FIXTURE: &[u8] = &[
        0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0xf3, 0x0a, 0x3e, 0x09, 0x00,
        0x00, 0x0a, 0x1f, 0x80, 0x40, 0x02, 0x7f, 0xe0, 0x08, 0x00, 0x08, 0x00, 0x3f, 0x26, 0xdc,
        0x30, 0x20, 0x00, 0x50, 0xa0, 0x00, 0x00, 0x00, 0x05, 0x47, 0xa8, 0x7a, 0x9e, 0x93, 0x13,
        0xd4, 0xd3, 0x46, 0x86, 0x7a, 0x52, 0x60, 0xc6, 0x22, 0xa6, 0x97, 0xe6, 0x1a, 0xc6, 0x5b,
        0xaf, 0x13, 0xa5, 0x2f, 0x69, 0x2f, 0xde, 0x15, 0x7a, 0x0e, 0xaa, 0x33, 0xdf, 0xec, 0x34,
        0xb8, 0x89, 0xb1, 0x24, 0x4b, 0x37, 0x10, 0x57, 0x37, 0xe2, 0xee, 0x48, 0xa7, 0x0a, 0x12,
        0x1e, 0x61, 0x47, 0xc1, 0x20,
    ];

    #[test]
    fn ping_carries_version() {
        assert!(ping().starts_with("compute.wasm pong (v"));
    }

    #[test]
    fn bzip2_roundtrip_matches_libbz2() {
        let out = bzip2_decompress_impl(FIXTURE).expect("解压应成功");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "SC2 replay bzip2 decompress self-test payload 0123456789"
        );
    }

    /// 损坏输入必须**干净返回 Err**，不能 panic —— wasm 里 panic 会变成 trap 并毒化实例。
    /// 这一条是实测结论：对头部损坏 / 截断 / 数据区翻转 / 尾部垃圾四类输入逐一验证过，
    /// bzip2-rs 0.1.2 全部走 Err 分支。
    #[test]
    fn bzip2_reports_corrupt_input_cleanly() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("空输入", vec![]),
            ("只有 magic", b"BZh".to_vec()),
            ("非法 block size 字符", vec![0x42, 0x5a, 0x68, 0xff, 0x00]),
            ("完全垃圾", vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
            ("截断到 24 字节", FIXTURE[..24].to_vec()),
            ("截断到 80 字节", FIXTURE[..80].to_vec()),
            ("数据区翻转", {
                let mut d = FIXTURE.to_vec();
                d[50] ^= 0xff;
                d
            }),
        ];
        for (label, input) in cases {
            let result = bzip2_decompress_impl(&input);
            assert!(
                result.is_err(),
                "{label} 应返回 Err，实际得到 {} 字节输出",
                result.map(|v| v.len()).unwrap_or(0)
            );
        }
    }
}
