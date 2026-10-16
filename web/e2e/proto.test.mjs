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

test('heavyhash is a bare name in the GPU class and carries no parameters', () => {
  const j = P.parseJob(job({ algo: { name: 'heavyhash' } }));
  assert.equal(j.cls, 'gpu');
  assert.equal(j.algo.id, P.ALGO.heavyhash);
  assert.deepEqual([j.algo.v10, j.algo.n, j.algo.r, j.algo.pers], [false, 0, 0, null]);
});

test('an algorithm this build does not know parses with no class and no algo', () => {
  // The graceful-degradation path: the pool names something this build cannot
  // place or hash, so the controller warns and stays idle rather than crashing.
  const j = P.parseJob(job({ algo: { name: 'equihash' } }));
  assert.equal(j.cls, null);
  assert.equal(j.algo, null);
  assert.equal(j.name, 'equihash');
});

test('an earn figure parses, and a malformed one is dropped not shown', () => {
  assert.deepEqual(P.parseEarn({ asset: 'nvda', value: 0.0123 }), { asset: 'nvda', value: 0.0123 });
  assert.deepEqual(P.parseEarn({ asset: 'glados', value: 0 }), { asset: 'glados', value: 0 });
  assert.equal(P.parseEarn({ asset: 'nvda', value: '0.0123' }), null, 'value must be a number, not a string');
  assert.equal(P.parseEarn({ asset: 'nvda', value: -1 }), null, 'a negative revenue is nonsense');
  assert.equal(P.parseEarn({ asset: 'nvda', value: Infinity }), null);
  assert.equal(P.parseEarn({ asset: 'nvda', value: NaN }), null);
  assert.equal(P.parseEarn({ value: 1 }), null, 'no asset, no figure');
  assert.equal(P.parseEarn({ asset: '', value: 1 }), null);
  assert.equal(P.parseEarn(null), null);
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

// ---- stress-test additions: each of these failed or was missing before ----

test('yespower jobs whose scratch would exceed the memory cap are refused', () => {
  const big = P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 524288, r: 32 } }));
  assert.ok(big.error && /memory/.test(big.error), big.error);
  const real = P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 4096, r: 32 } }));
  assert.ok(!real.error, 'N=4096 r=32 (16 MiB) is a real coin and must pass');
  assert.ok(P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 1000, r: 8 } })).error, 'N not a power of two');
  assert.ok(P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 2048, r: 40 } })).error, 'r out of range');
  assert.ok(P.parseJob(job({ algo: { name: 'yespower', v10: true, n: 2048, r: 8, pers: 'aa'.repeat(401) } })).error, 'pers over 400 bytes');
});

test('the bridge can be overridden only to a local address', () => {
  const D = 'wss://ws.aperture.institute';
  assert.equal(P.bridgeUrl(null, D), D);
  assert.equal(P.bridgeUrl('ws://127.0.0.1:8080', D), 'ws://127.0.0.1:8080');
  assert.equal(P.bridgeUrl('ws://localhost:9000', D), 'ws://localhost:9000');
  assert.equal(P.bridgeUrl('wss://evil.example', D), D, 'a link must not redirect hashrate elsewhere');
  assert.equal(P.bridgeUrl('ws://127.0.0.1.evil.example', D), D);
  assert.equal(P.bridgeUrl('javascript:alert(1)', D), D);
});

test('keccak-256 matches the published empty and abc digests', () => {
  assert.equal(P.keccak256Hex(new Uint8Array(0)), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(P.keccak256Hex(new TextEncoder().encode('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // Two blocks of rate: 200 bytes crosses the 136-byte block boundary.
  assert.equal(P.keccak256Hex(new Uint8Array(200).fill(0xa3)).length, 64);
});

test('EIP-55: the published checksummed addresses pass, a one-letter case flip fails', () => {
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    assert.equal(P.checkAddress(a).ok, true, a);
  }
  assert.equal(P.checkAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').ok, false, 'one flipped case');
  const lower = P.checkAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  assert.equal(lower.ok, true);
  assert.ok(lower.warn, 'all-lowercase carries no checksum and says so');
  assert.equal(P.checkAddress('0x123').ok, false);
});

test('the submit pacer sends a backlog after a throttled tick, but never more than its burst', () => {
  const p = new P.Pacer(8, 30);
  assert.equal(p.take(0), 30, 'starts full');
  assert.equal(p.take(0), 0);
  assert.equal(p.take(500), 4, 'half a second at 8/s');
  assert.equal(p.take(60_500), 30, 'a minute-long throttle releases a burst, capped');
});
