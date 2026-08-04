import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// No path aliases, deliberately. kite resolved an `@src` alias into a sibling
// checkout, which made it un-runnable by anyone who did not also have that
// checkout — the single biggest obstacle to handing a probe to someone else and
// asking them to run it. This bundle has to stand alone.

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

/** Installed versions, not semver ranges — a report has to name what actually ran. */
function installedVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    try {
      const p = resolve(__dirname, "node_modules", name, "package.json");
      out[name] = JSON.parse(readFileSync(p, "utf8")).version;
    } catch {
      out[name] = `${pkg.dependencies[name]} (not resolved)`;
    }
  }
  return out;
}

export default defineConfig({
  // `pad` uploads a static directory and points a DotNS contenthash at it.
  // There is no server and no origin, so everything must resolve relatively.
  base: "./",
  build: { target: "es2022", outDir: "dist" },
  define: {
    __SDK_VERSIONS__: JSON.stringify(installedVersions()),
    // Distinguishes two builds of the same version. A report that cannot name
    // the exact bundle it came from is not reproducible, and the whole value of
    // this probe is in comparing one run against another.
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
  server: { host: true },
});
