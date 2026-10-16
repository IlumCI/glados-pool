// The holding gate, read in the browser so the page can show it before a
// share is ever sent. This is a *reflection* of the real gate, which the pool
// enforces (pool/edge/worker: a wallet under the minimum is paid in $GLaDOS
// whatever it chose). The page cannot be trusted to gate itself, so this only
// locks the controls and names the requirement; the pool decides the payout.
//
// The constants mirror the edge worker's (GLADOS token, chain 4663 RPC,
// GATE_MIN). If the pool's change, change them here too.

export const GLADOS_TOKEN = '0x3d609ecafc6aa7dba67dd7ad1d10b49c52d57777';
export const RPC_4663 = 'https://rpc.mainnet.chain.robinhood.com';
// 1,000,000 whole $GLaDOS, at 18 decimals. Whole tokens, for the message.
export const GATE_WHOLE = 1_000_000n;
export const GATE_WEI = GATE_WHOLE * 10n ** 18n;

// balanceOf(address) -> the wallet's $GLaDOS in wei, or null if the chain could
// not be read. A failed read is null, never zero: not knowing must not be shown
// as "holds nothing", which would tell a real holder they are under the gate.
export async function gladosWei(address, { signal } = {}) {
  const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let res;
  try {
    res = await fetch(RPC_4663, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: GLADOS_TOKEN, data }, 'latest'] }),
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { return null; }
  const hex = j && typeof j.result === 'string' ? j.result : null;
  if (!hex || !/^0x[0-9a-fA-F]*$/.test(hex) || hex === '0x') return null;
  try { return BigInt(hex); } catch { return null; }
}

// Whole $GLaDOS (floored) from wei, for display without decimals.
export const whole = (wei) => wei / 10n ** 18n;
