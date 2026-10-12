// The protocol helpers, without a browser: node --test web/e2e/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../mine/js/proto.js';

const job = (o = {}) => ({ slot: 1, job: 'a', header: '00'.repeat(80), target: 'ff'.repeat(32), algo: { name: 'yespower', v10: true, n: 2048, r: 8 }, ...o });

test('a yespower job parses with its parameters and lands in the CPU class', () => {
  const j = P.parseJob(job({ algo: { name: 'yespower', v10: false, n: 4096, r: 16, pers: '4a61' } }));
  assert.equal(j.cls, 'cpu');
  assert.deepEqual([j.algo.v10, j.algo.n, j.algo.r, [...j.algo.pers]], [false, 4096, 16, [0x4a, 0x61]]);
});

test('yespower without its parameters is refused, not defaulted', () => {
  assert.ok(P.parseJob(job({ algo: { name: 'yespower', n: 2048, r: 8 } })).error);
  assert.ok(P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 2048, r: 8, pers: 'zz' } })).error);
});

test('malformed headers and targets are refused', () => {
  assert.ok(P.parseJob(job({ header: '00'.repeat(79) })).error);
  assert.ok(P.parseJob(job({ target: '0g' + 'ff'.repeat(31) })).error);
  assert.ok(P.parseJob(job({ slot: '1' })).error);
});

test('an algorithm this build cannot hash parses with a class and no algo', () => {
  const j = P.parseJob(job({ algo: { name: 'heavyhash' } }));
  assert.equal(j.cls, 'gpu');
  assert.equal(j.algo, null);
});

test('ranges cover 2^32 exactly, contiguously, with no overlap', () => {
  for (const k of [1, 3, 7, 15]) {
    const r = P.ranges(k);
    assert.equal(r[0].start, 0);
    assert.equal(r[k - 1].end, 2 ** 32);
    for (let i = 1; i < k; i++) assert.equal(r[i].start, r[i - 1].end);
  }
});

test('workers spread across CPU slots as evenly as possible', () => {
  assert.deepEqual([...P.assign(7, [1, 4]).values()], [4, 3]);
  assert.equal(P.assign(3, []).size, 0);
});

test('the target comparison reads the digest little-endian, equal passes', () => {
  const t = new Uint8Array(32); t[1] = 0x10;
  const d = new Uint8Array(32); d[30] = 0x10;
  assert.ok(P.belowTarget(d, t));
  d[0] = 0xff; assert.ok(!P.belowTarget(d, t), 'a low byte above an equal prefix is over');
});

test('nonces go on the wire as 8 big-endian hex digits', () => {
  assert.equal(P.nonceHex(0x1f8c04b2), '1f8c04b2');
  assert.equal(P.nonceHex(5), '00000005');
  assert.equal(JSON.parse(P.submit(7, 'a3f1', 0xdeadbeef, { x: 1 })).params.nonce, 'deadbeef');
});

test('addresses must be 0x and 40 hex digits', () => {
  assert.ok(P.isAddress('0x' + 'aB'.repeat(20)));
  assert.ok(!P.isAddress('0x' + 'a'.repeat(39)));
  assert.ok(!P.isAddress('a'.repeat(42)));
});

test('neoscrypt is GPU class and parses with a bare name', () => {
  const j = P.parseJob({ slot: 3, job: 'n', header: '00'.repeat(80), target: 'ff'.repeat(32), algo: { name: 'neoscrypt' } });
  assert.equal(j.cls, 'gpu');
  assert.equal(j.algo.id, P.ALGO.neoscrypt);
});
