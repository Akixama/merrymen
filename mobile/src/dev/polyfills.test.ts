import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lives under src because that is the only tree vitest.config.ts collects.
 * Guards the one import that killed 0.1.0 on every Android device.
 *
 * `fastestsmallesttextencoderdecoder` publishes two builds. "main" is the NodeJS
 * one, "browser" is the portable one. Metro resolves "browser" for web and
 * "main" for native, so a BARE import hands Android a build whose module scope
 * reads `n.allocUnsafe` off an undefined Buffer and throws before a single line
 * of app code runs. The web preview stays perfect throughout, which is precisely
 * why it shipped.
 *
 * A type checker cannot see this and neither can a web preview. So the shape of
 * the import is asserted directly, and the Node build is checked to confirm the
 * hazard is still real rather than something the package fixed upstream — if it
 * ever is fixed, this test starts failing and someone gets to delete it.
 */
const ROOT = join(__dirname, "..", "..");
const PKG = "fastestsmallesttextencoderdecoder";

describe("polyfills", () => {
  const src = readFileSync(join(ROOT, "polyfills.ts"), "utf8");

  it("imports the portable build by its explicit path, never the bare specifier", () => {
    expect(src).toContain(`${PKG}/EncoderDecoderTogether.min.js`);
    // A bare `import "pkg";` — the regression. The deep path above also contains
    // the package name, so match the quote that ends the specifier.
    expect(src).not.toMatch(new RegExp(`from\\s+["']${PKG}["']|import\\s+["']${PKG}["']`));
  });

  it("still needs to: the package's main is the Node build, and it touches Buffer at module scope", () => {
    const meta = JSON.parse(readFileSync(join(ROOT, "node_modules", PKG, "package.json"), "utf8"));
    expect(meta.main).toContain("NodeJS");
    expect(meta.browser).toBe("EncoderDecoderTogether.min.js");

    const nodeBuild = readFileSync(join(ROOT, "node_modules", PKG, meta.main), "utf8");
    expect(nodeBuild).toContain("allocUnsafe");

    // And the build we DO ship is free of the hazard.
    const portable = readFileSync(join(ROOT, "node_modules", PKG, meta.browser), "utf8");
    expect(portable).not.toContain("allocUnsafe");
    expect(portable).toContain("TextDecoder=");
  });
});
