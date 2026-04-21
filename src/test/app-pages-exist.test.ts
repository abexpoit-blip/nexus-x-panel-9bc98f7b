import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI guard — fails the build if any page referenced by App.tsx (directly
 * or via the lazyPages registry) is missing on disk. Catches the common
 * "deleted page file but forgot to clean the route" regression that
 * otherwise only blows up at runtime as a blank screen.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const PROJECT = resolve(SRC, "..");

function read(rel: string): string {
  return readFileSync(resolve(PROJECT, rel), "utf8");
}

function resolveAlias(spec: string): string | null {
  // We only care about project-local imports: "@/..." (alias for src/) and
  // relative imports. Anything else is a node_module — out of scope.
  if (spec.startsWith("@/")) return resolve(SRC, spec.slice(2));
  if (spec.startsWith("./") || spec.startsWith("../")) return null; // n/a in App.tsx
  return null;
}

function existsAsModule(absNoExt: string): boolean {
  for (const ext of [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]) {
    if (existsSync(absNoExt + ext)) return true;
  }
  return false;
}

describe("App.tsx — every imported page module exists on disk", () => {
  // ---- 1. Direct `import X from "@/pages/..."` lines in App.tsx ----
  const appSrc = read("src/App.tsx");
  const directPageImports = [...appSrc.matchAll(/from\s+["'](@\/pages\/[^"']+)["']/g)].map(m => m[1]);

  it("App.tsx has at least one direct page import (sanity)", () => {
    expect(directPageImports.length).toBeGreaterThan(0);
  });

  for (const spec of directPageImports) {
    it(`direct import resolves: ${spec}`, () => {
      const abs = resolveAlias(spec);
      expect(abs, `Could not resolve alias for ${spec}`).not.toBeNull();
      expect(existsAsModule(abs!), `Missing page file for: ${spec}`).toBe(true);
    });
  }

  // ---- 2. Lazy page registry referenced via `Pages["/path"].L` ----
  const lazySrc = read("src/lib/lazyPages.ts");
  const lazyImports = [...lazySrc.matchAll(/import\(\s*["'](@\/pages\/[^"']+)["']\s*\)/g)].map(m => m[1]);

  it("lazyPages.ts has at least one dynamic page import (sanity)", () => {
    expect(lazyImports.length).toBeGreaterThan(0);
  });

  for (const spec of lazyImports) {
    it(`lazy import resolves: ${spec}`, () => {
      const abs = resolveAlias(spec);
      expect(abs, `Could not resolve alias for ${spec}`).not.toBeNull();
      expect(existsAsModule(abs!), `Missing page file for: ${spec}`).toBe(true);
    });
  }

  // ---- 3. Every Pages["..."] key referenced in App.tsx must exist in the registry ----
  it("every Pages['/...'] key used in App.tsx is defined in lazyPages.ts", () => {
    const usedKeys = [...appSrc.matchAll(/Pages\[\s*["']([^"']+)["']\s*\]/g)].map(m => m[1]);
    const definedKeys = [...lazySrc.matchAll(/^\s*["']([^"']+)["']\s*:/gm)].map(m => m[1]);
    const missing = usedKeys.filter(k => !definedKeys.includes(k));
    expect(missing, `Routes referenced in App.tsx but missing from lazyPages: ${missing.join(", ")}`).toEqual([]);
  });
});