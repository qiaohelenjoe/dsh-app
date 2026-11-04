import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  WsFragmentReassembler,
  fragmentWsData,
  type WsDataFrame,
  type WsFragmentDrop,
} from '../src/ws-fragment.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function payload(size: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 17 + seed) % 256;
  return buffer;
}

function frames(channelId: string, messageId: string, data: Buffer, chunkBytes: number): WsDataFrame[] {
  return [...fragmentWsData({ channelId, messageId, data, binary: false, chunkBytes })];
}

describe('插件侧 wsdata 分片', () => {
  test('分片后可完整重组（与 server 侧同构）', () => {
    const data = payload(8000);
    const parts = frames('w_1', 'm_1', data, 1000);
    assert.equal(parts.length, 8);
    const reassembler = new WsFragmentReassembler();
    let complete: Buffer | null = null;
    for (const part of [...parts].reverse()) {
      const outcome = reassembler.accept('w_1', part);
      if (outcome.status === 'complete') complete = outcome.data;
    }
    assert.ok(complete);
    assert.equal(Buffer.compare(complete, data), 0);
  });

  test('丢片超时清理半成品', async () => {
    const drops: WsFragmentDrop[] = [];
    const reassembler = new WsFragmentReassembler({ timeoutMs: 20, onDrop: (drop) => drops.push(drop) });
    const parts = frames('w_1', 'm_1', payload(3000), 1000);
    reassembler.accept('w_1', parts[0] as WsDataFrame);
    assert.equal(reassembler.pendingCount, 1);
    await sleep(60);
    assert.equal(reassembler.pendingCount, 0);
    assert.equal(reassembler.bufferedBytes, 0);
    assert.equal(drops[0]?.reason, 'timeout');
  });

  test('分片总数超过上限时拒绝', () => {
    const reassembler = new WsFragmentReassembler({ maxFragments: 2 });
    assert.deepEqual(
      reassembler.accept('w_1', {
        t: 'wsdata',
        id: 'w_1',
        data: '',
        mid: 'm_many',
        seq: 0,
        total: 3,
        more: true,
      }),
      { status: 'rejected', reason: 'too_large' },
    );
    assert.equal(reassembler.pendingCount, 0);
  });

  test('并发半成品总字节超限时拒绝', () => {
    const reassembler = new WsFragmentReassembler({ maxMessageBytes: 10_000, maxBufferedBytes: 1500 });
    const first = frames('w_1', 'm_a', payload(3000), 1000);
    const second = frames('w_1', 'm_b', payload(3000), 1000);
    assert.equal(reassembler.accept('w_1', first[0] as WsDataFrame).status, 'pending');
    assert.deepEqual(reassembler.accept('w_1', second[0] as WsDataFrame), {
      status: 'rejected',
      reason: 'too_large',
    });
    assert.equal(reassembler.pendingCount, 1);
    assert.equal(reassembler.bufferedBytes, 1000);
  });

  test('超过单条消息上限时拒绝', () => {
    const reassembler = new WsFragmentReassembler({ maxMessageBytes: 1500 });
    const parts = frames('w_1', 'm_1', payload(3000), 1000);
    reassembler.accept('w_1', parts[0] as WsDataFrame);
    assert.deepEqual(reassembler.accept('w_1', parts[1] as WsDataFrame), {
      status: 'rejected',
      reason: 'too_large',
    });
    assert.equal(reassembler.pendingCount, 0);
  });
});
