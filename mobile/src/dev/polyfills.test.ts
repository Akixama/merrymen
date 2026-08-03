import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Lives under src because that is the only tree vitest.config.ts collects.
 *
 * THE BUG THIS EXISTS FOR: 0.1.0 crashed on launch on every Android device and
 * was flawless in the web preview. `fastestsmallesttextencoderdecoder`'s
 * portable build ends with
 *
 *     E || (r.TextDecoder = x, r.TextEncoder = y)
 *
 * where E is the environment's existing TextEncoder. Hermes has TextEncoder and
 * lacks TextDecoder, so E is truthy and the shim installs NOTHING — leaving
 * TextDecoder undefined and polyfills.ts throwing on its own assertion, before
 * any app code runs. A browser has both natively, so no amount of web testing
 * can reach this.
 *
 * These tests reproduce the HERMES SHAPE on the real global — TextEncoder
 * present, TextDecoder absent — because the shim writes to the real global and
 * ignores any object handed to it.
 */
const ROOT = join(__dirname, "..", "..");
const PKG = "fastestsmallesttextencoderdecoder";

const G = globalThis as unknown as Record<string, unknown>;
const REAL_ENCODER = G.TextEncoder;
const REAL_DECODER = G.TextDecoder;

afterEach(() => {
  G.TextEncoder = REAL_ENCODER;
  G.TextDecoder = REAL_DECODER;
});

/** node has both codecs; strip TextDecoder to look like Hermes. */
async function underHermes(): Promise<(typeof import("../../textCodecs"))["installTextCodecs"]> {
  G.TextEncoder = REAL_ENCODER;
  delete G.TextDecoder;
  // The shim assigns at module scope, so it must be re-evaluated per scenario.
  vi.resetModules();
  return (await import("../../textCodecs")).installTextCodecs;
}

describe("installTextCodecs, on a Hermes-shaped global", () => {
  it("installs a TextDecoder that actually decodes UTF-8", async () => {
    const install = await underHermes();
    expect(typeof G.TextDecoder).toBe("undefined"); // precondition: the bug's shape

    install();

    expect(typeof G.TextDecoder).toBe("function");
    const Decoder = G.TextDecoder as new () => { decode(a: Uint8Array): string };
    expect(new Decoder().decode(new Uint8Array([104, 105, 226, 128, 148]))).toBe("hi—");
  });

  it("leaves the engine's own TextEncoder in place rather than the shim's", async () => {
    const install = await underHermes();
    install();
    expect(G.TextEncoder).toBe(REAL_ENCODER);
  });

  it("PROVES THE BUG: requiring the shim directly, as 0.1.0 did, installs nothing", async () => {
    G.TextEncoder = REAL_ENCODER;
    delete G.TextDecoder;
    vi.resetModules();

    // Exactly what `import "…/EncoderDecoderTogether.min.js"` did before: no
    // hiding of TextEncoder, so the shim's `E ||` guard short-circuits.
    await import("fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js");

    expect(typeof G.TextDecoder).toBe("undefined");
  });

  it("is a no-op when TextDecoder already exists, as in a browser", async () => {
    vi.resetModules();
    const { installTextCodecs } = await import("../../textCodecs");
    installTextCodecs();
    expect(G.TextDecoder).toBe(REAL_DECODER);
    expect(G.TextEncoder).toBe(REAL_ENCODER);
  });
});

describe("the upstream hazards these guards are for", () => {
  const meta = JSON.parse(readFileSync(join(ROOT, "node_modules", PKG, "package.json"), "utf8"));

  it("the shim is still all-or-nothing, gated on a pre-existing TextEncoder", () => {
    const portable = readFileSync(join(ROOT, "node_modules", PKG, meta.browser), "utf8");
    // If upstream ever splits these, this fails and the dance can be deleted.
    expect(portable).toMatch(/\|\|\s*\(\s*\w+\.TextDecoder\s*=\s*\w+\s*,\s*\w+\.TextEncoder\s*=\s*\w+\s*\)/);
  });

  it("main is still the Buffer-touching NodeJS build, so the deep path stays pinned", () => {
    expect(meta.main).toContain("NodeJS");
    expect(readFileSync(join(ROOT, "node_modules", PKG, meta.main), "utf8")).toContain("allocUnsafe");
    expect(readFileSync(join(ROOT, "node_modules", PKG, meta.browser), "utf8")).not.toContain("allocUnsafe");
  });

  it("textCodecs.ts names the portable build explicitly", () => {
    expect(readFileSync(join(ROOT, "textCodecs.ts"), "utf8")).toContain(`${PKG}/EncoderDecoderTogether.min.js`);
  });
});
