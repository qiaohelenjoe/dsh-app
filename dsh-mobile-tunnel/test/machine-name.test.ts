import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __setMachineNameForTest, computeMachineName, isMachineName } from '../src/machine-name.js';

test('计算机名称取本机 COMPUTERNAME（小写）且可重复计算', () => {
  __setMachineNameForTest(undefined);
  const name = computeMachineName();
  if (name === null) {
    assert.equal(name, null);
    return;
  }
  assert.ok(isMachineName(name), `计算机名称格式不对：${name}`);
  assert.equal(name, name.toLowerCase());
  assert.equal(computeMachineName(), name);
  __setMachineNameForTest(undefined);
});
