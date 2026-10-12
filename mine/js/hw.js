// What this machine can do, read from the browser and never guessed.

// The smallest module using a SIMD instruction (i32x4.splat): if it
// validates, the simd128 build will load. Sniffing the user agent instead
// would be a guess about a fact the engine can simply be asked.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export async function detect() {
  const hw = {
    cores: navigator.hardwareConcurrency || 1,
    memoryGb: navigator.deviceMemory || null, // browsers cap this at 8
    simd: false,
    webgpu: false,
    gpu: '',
    limits: null,
  };
  try {
    hw.simd = WebAssembly.validate(SIMD_PROBE);
  } catch {}
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    if (adapter) {
      hw.webgpu = true;
      const i = adapter.info || {};
      hw.gpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'WebGPU adapter';
      hw.limits = {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      };
    }
  } catch {}
  return hw;
}

/**
 * CPU threads to mine with. One core is left alone: it keeps the page, the
 * socket and (once it exists) the GPU's command submission fed, and a tab
 * that stops responding gets closed, which mines nothing.
 */
export const cpuThreads = (hw) => Math.max(1, hw.cores - 1);
