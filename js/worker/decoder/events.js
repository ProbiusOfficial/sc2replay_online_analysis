/**
 * 六个录像流的解码入口。
 *
 * 与官方 `protocolNNNNN.py` 里的 `decode_replay_*` 函数一一对应，**解码器分流
 * 必须照搬**（这是实测确认过的，不是猜的）：
 *
 * | 流                       | 解码器             | 为什么                              |
 * | ------------------------ | ------------------ | ----------------------------------- |
 * | `replay.header`          | VersionedDecoder   | 随补丁演进，带 skip 标记            |
 * | `replay.details`         | VersionedDecoder   | 同上                                |
 * | `replay.tracker.events`  | VersionedDecoder   | 同上（单位/统计事件）              |
 * | `replay.initData`        | BitPackedDecoder   | 与版本强绑定，省掉标记以减小体积    |
 * | `replay.game.events`     | BitPackedDecoder   | 同上                                |
 * | `replay.message.events`  | BitPackedDecoder   | 同上                                |
 *
 * 用错解码器不会立刻报错 —— 会读出一堆看似合理但完全错位的数据。
 */
import { BitPackedBuffer, BitPackedDecoder, CorruptedError, VersionedDecoder, } from "./decoder.js";
/** Python 侧 `_varuint32_value`：从 `SVarUint32` 的 choice 结果里取唯一的值。 */
function varuint32Value(value) {
    if (value !== null && typeof value === "object") {
        for (const inner of Object.values(value)) {
            return Number(inner);
        }
    }
    return 0;
}
/**
 * 解一条事件流。
 *
 * 每条事件的布局：`gameloop 增量 → [userid] → eventid → 事件体`，
 * 事件体之后强制字节对齐（下一条又从字节边界开始）。
 */
function decodeEventStream(decoder, context) {
    const events = [];
    let gameloop = 0;
    while (!decoder.done()) {
        const startBits = decoder.usedBits();
        gameloop += varuint32Value(decoder.instance(context.svaruint32TypeId));
        // `replay_userid_typeid` 解出来是 `{ m_userId: N }` 这样的对象，不是裸数字
        // —— 官方 `_decode_event_stream` 也是原样塞进 `_userid`，照搬。
        let userId;
        if (context.decodeUserId) {
            userId = decoder.instance(context.replayUserIdTypeId);
        }
        const eventId = Number(decoder.instance(context.eventIdTypeId));
        const entry = context.eventTypes[String(eventId)];
        if (!entry) {
            throw new CorruptedError(`未知的事件 id ${eventId}（已读 ${events.length} 条事件后）`);
        }
        const [typeId, eventName] = entry;
        const body = decoder.instance(typeId);
        const event = (body !== null && typeof body === "object" ? body : {});
        event._event = eventName;
        event._eventid = eventId;
        event._gameloop = gameloop;
        if (userId !== undefined)
            event._userid = userId;
        decoder.byteAlign();
        event._bits = decoder.usedBits() - startBits;
        events.push(event);
    }
    return events;
}
/** `replay.header`。用于取 `m_version.m_baseBuild` 与总帧数。 */
export function decodeReplayHeader(selection, contents) {
    const decoder = new VersionedDecoder(contents, selection.tables.TYPE_INFOS);
    return decoder.instance(selection.tables.TYPEIDS.replayHeader);
}
/** `replay.details`。地图名、玩家列表、种族、`m_gameSpeed` 都在这里。 */
export function decodeReplayDetails(selection, contents) {
    const decoder = new VersionedDecoder(contents, selection.tables.TYPE_INFOS);
    return decoder.instance(selection.tables.TYPEIDS.gameDetails);
}
/** `replay.initData`。`m_syncLobbyState` 里也有 `m_gameSpeed`（与 details 一致）。 */
export function decodeReplayInitData(selection, contents) {
    const decoder = new BitPackedDecoder(contents, selection.tables.TYPE_INFOS);
    return decoder.instance(selection.tables.TYPEIDS.replayInitdata);
}
/** `replay.tracker.events`。单位生命周期、玩家统计、位置快照。 */
export function decodeReplayTrackerEvents(selection, contents) {
    const decoder = new VersionedDecoder(contents, selection.tables.TYPE_INFOS);
    return decodeEventStream(decoder, {
        eventIdTypeId: selection.tables.TYPEIDS.trackerEventId,
        eventTypes: selection.tables.TRACKER_EVENT_TYPES,
        decodeUserId: false,
        svaruint32TypeId: selection.tables.TYPEIDS.svaruint32,
        replayUserIdTypeId: selection.tables.TYPEIDS.replayUserId,
    });
}
/** `replay.game.events`。建造与施法命令。 */
export function decodeReplayGameEvents(selection, contents) {
    const decoder = new BitPackedDecoder(contents, selection.tables.TYPE_INFOS);
    return decodeEventStream(decoder, {
        eventIdTypeId: selection.tables.TYPEIDS.gameEventId,
        eventTypes: selection.tables.GAME_EVENT_TYPES,
        decodeUserId: true,
        svaruint32TypeId: selection.tables.TYPEIDS.svaruint32,
        replayUserIdTypeId: selection.tables.TYPEIDS.replayUserId,
    });
}
/** `replay.message.events`。聊天。 */
export function decodeReplayMessageEvents(selection, contents) {
    const decoder = new BitPackedDecoder(contents, selection.tables.TYPE_INFOS);
    return decodeEventStream(decoder, {
        eventIdTypeId: selection.tables.TYPEIDS.messageEventId,
        eventTypes: selection.tables.MESSAGE_EVENT_TYPES,
        decodeUserId: true,
        svaruint32TypeId: selection.tables.TYPEIDS.svaruint32,
        replayUserIdTypeId: selection.tables.TYPEIDS.replayUserId,
    });
}
/**
 * `replay.attributes.events`。地图作者自定的属性（小端、非协议表驱动）。
 *
 * 结构简单到不值得走解码器：`source:u8 / mapNamespace:u32 / count:u32`，
 * 之后是若干个 `namespace:u32 / attrid:u32 / scope:u8 / value[4]` 记录。
 */
export function decodeReplayAttributesEvents(contents) {
    const buffer = new BitPackedBuffer(contents, "little");
    const result = { scopes: {} };
    if (buffer.done())
        return result;
    result.source = Number(buffer.readBits(8));
    result.mapNamespace = Number(buffer.readBits(32));
    buffer.readBits(32); // count：官方读了但没用，照搬。
    while (!buffer.done()) {
        const namespace = Number(buffer.readBits(32));
        const attrid = Number(buffer.readBits(32));
        const scope = Number(buffer.readBits(8));
        // 官方是 `read_aligned_bytes(4)[::-1].strip(b'\x00')`：反转后去掉前导零。
        const raw = buffer.readAlignedBytes(4);
        const value = new Uint8Array([raw[3], raw[2], raw[1], raw[0]]);
        let start = 0;
        while (start < value.length && value[start] === 0)
            start += 1;
        const scopes = (result.scopes[scope] ??= {});
        (scopes[attrid] ??= []).push({ namespace, attrid, value: value.subarray(start) });
    }
    return result;
}
/** `unit_tag_index`：从 unit tag 取索引部分。 */
export function unitTagIndex(unitTag) {
    return (unitTag >> 18) & 0x00003fff;
}
/** `unit_tag_recycle`：从 unit tag 取复用计数部分。 */
export function unitTagRecycle(unitTag) {
    return unitTag & 0x0003ffff;
}
/** 由索引与复用计数拼出 unit tag。 */
export function unitTag(index, recycle) {
    return (index << 18) + recycle;
}
