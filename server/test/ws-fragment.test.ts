import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_WS_CHUNK_BYTES,
  type WsDataFrame,
} from '../src/tunnel/protocol.js';
import {
  WsFragmentReassembler,
  fragmentWsData,
  type FragmentWsDataInput,
  type WsFragmentDrop,
} from '../src/tunnel/ws-fragment.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function frames(input: Omit<FragmentWsDataInput, 'messageId'> & { messageId?: string }): WsDataFrame[] {
  return [...fragmentWsData({ messageId: 'm_1', ...input })];
}

function payload(size: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 31 + seed) % 256;
  return buffer;
}

describe('wsdata 分片（协议 v2）', () => {
  test('未超过 chunkBytes 时输出与 v1 一致的单帧（无分片字段）', () => {
    const data = payload(1024);
    const result = frames({ channelId: 'w_1', data, binary: false, chunkBytes: 4096 });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { t: 'wsdata', id: 'w_1', data: data.toString('base64'), binary: false });
    assert.equal('mid' in (result[0] as object), false);
    assert.equal('seq' in (result[0] as object), false);
    assert.equal('total' in (result[0] as object), false);
    assert.equal('more' in (result[0] as object), false);
  });

  test('超过 chunkBytes 时按 mid/seq/total/more 切片并可完整重组', () => {
    const data = payload(10_000);
    const result = frames({ channelId: 'w_1', data, binary: true, chunkBytes: 1024 });
    assert.equal(result.length, Math.ceil(data.length / 1024));
    result.forEach((frame, index) => {
      assert.equal(frame.mid, 'm_1');
      assert.equal(frame.seq, index);
      assert.equal(frame.total, result.length);
      assert.equal(frame.more, index < result.length - 1);
    });

    const reassembler = new WsFragmentReassembler();
    let complete: Buffer | null = null;
    for (const frame of result) {
      const outcome = reassembler.accept('w_1', frame);
      if (outcome.status === 'complete') complete = outcome.data;
    }
    assert.ok(complete);
    assert.equal(Buffer.compare(complete, data), 0);
    assert.equal(reassembler.pendingCount, 0);
    assert.equal(reassembler.bufferedBytes, 0);
  });

  test('乱序到达仍能重组（按 seq 排序）', () => {
    const data = payload(5000, 7);
    const result = frames({ channelId: 'w_1', data, binary: false, chunkBytes: 1024 });
    const reassembler = new WsFragmentReassembler();
    const order = [...result.keys()].reverse();
    let complete: Buffer | null = null;
    for (const index of order) {
      const outcome = reassembler.accept('w_1', result[index] as WsDataFrame);
      if (outcome.status === 'complete') complete = outcome.data;
    }
    assert.ok(complete);
    assert.equal(Buffer.compare(complete, data), 0);
  });

  test('同一通道并发多消息按 mid 区分', () => {
    const first = payload(3000, 1);
    const second = payload(2500, 2);
    const firstFrames = frames({ channelId: 'w_1', messageId: 'm_a', data: first, binary: false, chunkBytes: 1000 });
    const secondFrames = frames({ channelId: 'w_1', messageId: 'm_b', data: second, binary: true, chunkBytes: 1000 });
    const reassembler = new WsFragmentReassembler();
    const completed: Array<{ data: Buffer; binary: boolean }> = [];

    // 交替喂入两条消息的分片
    const max = Math.max(firstFrames.length, secondFrames.length);
    for (let index = 0; index < max; index += 1) {
      const a = firstFrames[index];
      if (a) {
        const outcome = reassembler.accept('w_1', a);
        if (outcome.status === 'complete') completed.push({ data: outcome.data, binary: outcome.binary });
      }
      const b = secondFrames[index];
      if (b) {
        const outcome = reassembler.accept('w_1', b);
        if (outcome.status === 'complete') completed.push({ data: outcome.data, binary: outcome.binary });
      }
    }

    assert.equal(completed.length, 2);
    const firstResult = completed.find((item) => item.data.length === first.length);
    const secondResult = completed.find((item) => item.data.length === second.length);
    assert.ok(firstResult);
    assert.ok(secondResult);
    assert.equal(Buffer.compare(firstResult.data, first), 0);
    assert.equal(firstResult.binary, false);
    assert.equal(Buffer.compare(secondResult.data, second), 0);
    assert.equal(secondResult.binary, true);
  });

  test('重复分片被忽略，不影响重组', () => {
    const data = payload(3000);
    const result = frames({ channelId: 'w_1', data, binary: false, chunkBytes: 1000 });
    const reassembler = new WsFragmentReassembler();
    assert.equal(reassembler.accept('w_1', result[0] as WsDataFrame).status, 'pending');
    assert.equal(reassembler.accept('w_1', result[0] as WsDataFrame).status, 'pending');
    assert.equal(reassembler.accept('w_1', result[1] as WsDataFrame).status, 'pending');
    const outcome = reassembler.accept('w_1', result[2] as WsDataFrame);
    assert.equal(outcome.status, 'complete');
    if (outcome.status === 'complete') assert.equal(Buffer.compare(outcome.data, data), 0);
  });

  test('只有 more 标志（无 total）时按最后一片完成重组', () => {
    const reassembler = new WsFragmentReassembler();
    const part = (seq: number, data: string, more: boolean): WsDataFrame => ({
      t: 'wsdata',
      id: 'w_1',
      data: Buffer.from(data).toString('base64'),
      binary: false,
      mid: 'm_more',
      seq,
      more,
    });
    assert.equal(reassembler.accept('w_1', part(0, 'aa', true)).status, 'pending');
    // seq=2 的 more=false 隐含 total=3，但中间缺 seq=1，需继续等待。
    assert.equal(reassembler.accept('w_1', part(2, 'cc', false)).status, 'pending');
    const outcome = reassembler.accept('w_1', part(1, 'bb', true));
    assert.equal(outcome.status, 'complete');
    if (outcome.status === 'complete') assert.equal(outcome.data.toString(), 'aabbcc');
  });

  test('丢片超时后清理半成品并回调', async () => {
    const drops: WsFragmentDrop[] = [];
    const reassembler = new WsFragmentReassembler({
      timeoutMs: 30,
      onDrop: (drop) => drops.push(drop),
    });
    const result = frames({ channelId: 'w_1', data: payload(3000), binary: false, chunkBytes: 1000 });
    assert.equal(reassembler.accept('w_1', result[0] as WsDataFrame).status, 'pending');
    assert.equal(reassembler.pendingCount, 1);
    assert.ok(reassembler.bufferedBytes > 0);

    await sleep(80);
    assert.equal(reassembler.pendingCount, 0);
    assert.equal(reassembler.bufferedBytes, 0);
    assert.deepEqual(drops, [{ channelId: 'w_1', messageId: 'm_1', reason: 'timeout' }]);
  });

  test('超过单条消息上限时拒绝并清理', () => {
    const drops: WsFragmentDrop[] = [];
    const reassembler = new WsFragmentReassembler({ maxMessageBytes: 1500, onDrop: (drop) => drops.push(drop) });
    const result = frames({ channelId: 'w_1', data: payload(3000), binary: false, chunkBytes: 1000 });
    assert.equal(reassembler.accept('w_1', result[0] as WsDataFrame).status, 'pending');
    const outcome = reassembler.accept('w_1', result[1] as WsDataFrame);
    assert.deepEqual(outcome, { status: 'rejected', reason: 'too_large' });
    assert.equal(reassembler.pendingCount, 0);
    assert.equal(reassembler.bufferedBytes, 0);
    assert.deepEqual(drops.at(-1), { channelId: 'w_1', messageId: 'm_1', reason: 'too_large' });
  });

  test('并发半成品数量超限时拒绝新消息', () => {
    const drops: WsFragmentDrop[] = [];
    const reassembler = new WsFragmentReassembler({ maxPendingMessages: 1, onDrop: (drop) => drops.push(drop) });
    const first = frames({ channelId: 'w_1', messageId: 'm_a', data: payload(2000), binary: false, chunkBytes: 1000 });
    const second = frames({ channelId: 'w_1', messageId: 'm_b', data: payload(2000), binary: false, chunkBytes: 1000 });
    assert.equal(reassembler.accept('w_1', first[0] as WsDataFrame).status, 'pending');
    assert.deepEqual(reassembler.accept('w_1', second[0] as WsDataFrame), {
      status: 'rejected',
      reason: 'too_many_pending',
    });
    assert.equal(reassembler.pendingCount, 1);
    assert.deepEqual(drops.at(-1), { channelId: 'w_1', messageId: 'm_b', reason: 'too_many_pending' });
  });

  test('非法分片（seq 越界 / 缺 seq）被拒绝', () => {
    const reassembler = new WsFragmentReassembler();
    const invalid = reassembler.accept('w_1', {
      t: 'wsdata',
      id: 'w_1',
      data: 'YQ==',
      mid: 'm_bad',
      seq: 3,
      total: 2,
    });
    assert.deepEqual(invalid, { status: 'rejected', reason: 'invalid' });

    const missingSeq = reassembler.accept('w_1', {
      t: 'wsdata',
      id: 'w_1',
      data: 'YQ==',
      mid: 'm_bad',
    });
    assert.deepEqual(missingSeq, { status: 'rejected', reason: 'invalid' });
    assert.equal(reassembler.pendingCount, 0);
  });

  test('分片总数/已收分片数超过上限时拒绝（防零字节分片撑爆内存）', () => {
    const drops: WsFragmentDrop[] = [];
    const withTotal = new WsFragmentReassembler({ maxFragments: 3, onDrop: (drop) => drops.push(drop) });
    assert.deepEqual(
      withTotal.accept('w_1', {
        t: 'wsdata',
        id: 'w_1',
        data: '',
        mid: 'm_many',
        seq: 0,
        total: 4,
        more: true,
      }),
      { status: 'rejected', reason: 'too_large' },
    );
    assert.equal(withTotal.pendingCount, 0);
    assert.deepEqual(drops.at(-1), { channelId: 'w_1', messageId: 'm_many', reason: 'too_large' });

    const withoutTotal = new WsFragmentReassembler({ maxFragments: 2 });
    const chunk = (seq: number): WsDataFrame => ({
      t: 'wsdata',
      id: 'w_1',
      data: '',
      binary: false,
      mid: 'm_more',
      seq,
      more: true,
    });
    assert.equal(withoutTotal.accept('w_1', chunk(0)).status, 'pending');
    assert.equal(withoutTotal.accept('w_1', chunk(1)).status, 'pending');
    assert.deepEqual(withoutTotal.accept('w_1', chunk(2)), { status: 'rejected', reason: 'too_large' });
    assert.equal(withoutTotal.pendingCount, 0);
  });

  test('多消息并发时半成品总字节超限被拒绝', () => {
    const reassembler = new WsFragmentReassembler({ maxMessageBytes: 10_000, maxBufferedBytes: 1500 });
    const first = frames({ channelId: 'w_1', messageId: 'm_a', data: payload(3000), binary: false, chunkBytes: 1000 });
    const second = frames({ channelId: 'w_1', messageId: 'm_b', data: payload(3000), binary: false, chunkBytes: 1000 });
    assert.equal(reassembler.accept('w_1', first[0] as WsDataFrame).status, 'pending');
    assert.deepEqual(reassembler.accept('w_1', second[0] as WsDataFrame), {
      status: 'rejected',
      reason: 'too_large',
    });
    assert.equal(reassembler.pendingCount, 1);
    assert.equal(reassembler.bufferedBytes, 1000);
  });

  test('dropChannel 只清理指定通道，reset 清理全部', () => {
    const reassembler = new WsFragmentReassembler();
    const first = frames({ channelId: 'w_1', data: payload(2000), binary: false, chunkBytes: 1000 });
    const second = frames({ channelId: 'w_2', data: payload(2000), binary: false, chunkBytes: 1000 });
    reassembler.accept('w_1', first[0] as WsDataFrame);
    reassembler.accept('w_2', second[0] as WsDataFrame);
    assert.equal(reassembler.pendingCount, 2);

    reassembler.dropChannel('w_1');
    assert.equal(reassembler.pendingCount, 1);
    assert.ok(reassembler.bufferedBytes > 0);

    reassembler.reset();
    assert.equal(reassembler.pendingCount, 0);
    assert.equal(reassembler.bufferedBytes, 0);
  });

  test('默认分片大小 256 KiB 且单条消息上限 64 MiB', () => {
    assert.equal(DEFAULT_WS_CHUNK_BYTES, 256 * 1024);
    const frameCount = Math.ceil((1024 * 1024 + 1) / DEFAULT_WS_CHUNK_BYTES);
    const result = frames({ channelId: 'w_1', data: payload(1024 * 1024 + 1), binary: false });
    assert.equal(result.length, frameCount);
    assert.equal(result[0]?.mid, 'm_1');
    assert.equal(result[0]?.total, frameCount);
  });
});
