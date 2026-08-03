/**
 * libheif-js ships no type declarations. Only the surface we actually use is
 * described here — the WASM bundle entry point, which is the one that carries
 * the HEVC decoder that sharp's prebuilt libvips lacks.
 */
declare module 'libheif-js/wasm-bundle.js' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { width: number; height: number; data: Uint8ClampedArray },
      callback: (result: unknown) => void,
    ): void;
  }

  export class HeifDecoder {
    decode(buffer: Uint8Array | Buffer): HeifImage[];
  }

  /** Present because the package is CommonJS; see the interop note in decode.ts. */
  const _default: { HeifDecoder: typeof HeifDecoder } | undefined;
  export default _default;
}
