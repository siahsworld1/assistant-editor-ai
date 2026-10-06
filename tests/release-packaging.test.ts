// @vitest-environment node
// Release packaging: the app's identity and Electron hardening in package.json,
// the third-party acknowledgements generator, and the afterPack payload audit
// that fails a build containing npm packages or build-machine paths.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ack = require("../scripts/acknowledgements.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const afterPack = require("../scripts/after-pack.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const asar = require("@electron/asar");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const debugSwitches = require("../electron/debug-switches.cjs");

const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const build = pkg.build;

describe("app identity", () => {
  it("is the final product identity, macOS 14+, Apple silicon only", () => {
    expect(build.productName).toBe("Assistant Editor AI");
    expect(build.appId).toBe("com.1855andco.assistanteditorai");
    expect(build.mac.minimumSystemVersion).toBe("14.0");
    for (const target of build.mac.target) expect(target.arch).toEqual(["arm64"]);
  });

  it("is the external beta, published by Eighteen Fifty Five and Company", () => {
    // The project/prerelease version (app.getVersion(), artifact names) …
    expect(pkg.version).toBe("1.0.0-beta.1");
    // … but Apple's bundle versions are digits and periods only.
    expect(build.mac.bundleShortVersion).toBe("1.0.0");
    expect(build.mac.bundleVersion).toBe("1");
    for (const v of [build.mac.bundleShortVersion, build.mac.bundleVersion]) expect(v).toMatch(/^\d+(\.\d+)*$/);
    // DMG/ZIP names keep the prerelease version. The DMG's default name would
    // use bundleShortVersion ("1.0.0"), so it is pinned to ${version}.
    expect(build.dmg.artifactName).toBe("${productName}-${version}-${arch}.${ext}");
    expect(build.dmg.title).toBe("${productName} ${version}");
    for (const opts of [build, build.mac]) expect(opts.artifactName).toBeUndefined(); // ZIP default uses ${version}
    expect(build.copyright).toBe("Copyright © 2026 Eighteen Fifty Five and Company, LLC. All rights reserved.");
  });

  it("declares no device permissions the app never uses", () => {
    for (const key of [
      "NSCameraUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSAudioCaptureUsageDescription",
      "NSBluetoothAlwaysUsageDescription",
      "NSBluetoothPeripheralUsageDescription",
    ]) {
      expect(build.mac.extendInfo).toHaveProperty(key, null); // electron-builder deletes null keys
    }
  });

  it("keeps the Keychain service independent of the bundle id", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KEYCHAIN_SERVICE } = require("../electron/credential-store.cjs");
    expect(KEYCHAIN_SERVICE).toBe("com.1855andco.assistant-editor-ai");
  });
});

describe("app icon", () => {
  const root = path.join(__dirname, "..");
  const icns = readFileSync(path.join(root, build.mac.icon));

  function icnsEntries(buf: Buffer) {
    const entries: Record<string, number | null> = {};
    for (let o = 8; o < buf.length; ) {
      const type = buf.toString("ascii", o, o + 4);
      const len = buf.readUInt32BE(o + 4);
      const isPng = buf.toString("hex", o + 8, o + 12) === "89504e47";
      entries[type] = isPng ? buf.readUInt32BE(o + 8 + 16) : null; // PNG IHDR width
      o += len;
    }
    return entries;
  }

  it("is the approved artwork's .icns with every macOS size", () => {
    expect(build.mac.icon).toBe("assets/icon/AssistantEditorAI.icns");
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const e = icnsEntries(icns);
    // 16, 32 (ARGB) and 16@2x … 512@2x (PNG)
    expect(Object.keys(e)).toEqual(expect.arrayContaining(["ic04", "ic05", "ic11", "ic12", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"]));
    expect([e.ic11, e.ic12, e.ic07, e.ic13, e.ic08, e.ic14, e.ic09, e.ic10]).toEqual([32, 64, 128, 256, 256, 512, 512, 1024]);
  });

  it("keeps a transparent 1024 px master and the supplied source", () => {
    const master = readFileSync(path.join(root, "assets", "icon", "assistant-editor-ai-1024.png"));
    expect(master.toString("hex", 0, 8)).toBe("89504e470d0a1a0a");
    expect([master.readUInt32BE(16), master.readUInt32BE(20)]).toEqual([1024, 1024]);
    expect(master[25]).toBe(6); // colour type 6 = RGBA
    const source = readFileSync(path.join(root, "assets", "icon", "source", "assistant-editor-ai-icon-approved.webp"));
    const script = readFileSync(path.join(root, "scripts", "make-app-icon.py"), "utf8");
    expect(script).toContain(`SOURCE_SHA256 = "${createHash("sha256").update(source).digest("hex")}"`);
  });
});

describe("DMG window", () => {
  const root = path.join(__dirname, "..");
  const dmg = build.dmg;

  /** Width x height of every image (IFD) in a TIFF. */
  function tiffSizes(buf: Buffer) {
    const le = buf.toString("ascii", 0, 2) === "II";
    const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const sizes: Array<[number, number]> = [];
    for (let ifd = u32(4); ifd; ) {
      const n = u16(ifd);
      const tags: Record<number, number> = {};
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        tags[u16(e)] = u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8);
      }
      sizes.push([tags[256], tags[257]]);
      ifd = u32(ifd + 2 + n * 12);
    }
    return sizes;
  }

  it("uses the approved background as a 1x + 2x (Retina) TIFF", () => {
    expect(dmg.background).toBe("assets/dmg/background.tiff");
    const sizes = tiffSizes(readFileSync(path.join(root, dmg.background)));
    expect(sizes).toEqual([
      [768, 512],
      [1536, 1024],
    ]);
    const source = readFileSync(path.join(root, "assets", "dmg", "source", "dmg-background-approved.webp"));
    const script = readFileSync(path.join(root, "scripts", "make-dmg-background.py"), "utf8");
    expect(script).toContain(`SOURCE_SHA256 = "${createHash("sha256").update(source).digest("hex")}"`);
  });

  it("puts the app and the Applications link inside the artwork's two frames", () => {
    // Frames measured on the shipped artwork (assets/dmg/source, 2x pixels / 2
    // = window points): left x 320–647, y 378–671; right x 890–1217, y 377–671.
    const frames = [
      { left: 160, right: 323.5, top: 189, bottom: 335.5 }, // app
      { left: 445, right: 608.5, top: 188.5, bottom: 335.5 }, // Applications
    ];
    expect(dmg.contents.map((c: { type: string }) => c.type)).toEqual(["file", "link"]);
    expect(dmg.contents[1].path).toBe("/Applications");
    const labelHeight = dmg.iconTextSize + 6;
    dmg.contents.forEach((c: { x: number; y: number }, i: number) => {
      const f = frames[i];
      expect(c.x - dmg.iconSize / 2).toBeGreaterThanOrEqual(f.left);
      expect(c.x + dmg.iconSize / 2).toBeLessThanOrEqual(f.right);
      expect(c.y - dmg.iconSize / 2).toBeGreaterThanOrEqual(f.top);
      expect(c.y + dmg.iconSize / 2 + labelHeight).toBeLessThanOrEqual(f.bottom);
      expect(Math.abs(c.x - (f.left + f.right) / 2)).toBeLessThanOrEqual(1);
    });
  });
});

describe("packaged payload", () => {
  it("ships no npm packages: main process and interface server need none", () => {
    expect(build.files).toContain("!node_modules{,/**/*}");
    expect(build.afterPack).toBe("scripts/after-pack.cjs");
    // No auto-updater: no app-update.yml naming the source repository.
    expect(build.publish).toBeNull();
  });

  it("flips the Electron fuses the app can live without", () => {
    expect(build.electronFuses).toEqual({
      // electron/renderer-server.cjs runs the interface server with
      // ELECTRON_RUN_AS_NODE, so this one must stay on.
      runAsNode: true,
      enableCookieEncryption: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      resetAdHocDarwinSignature: true,
    });
    const rendererServer = readFileSync(path.join(__dirname, "..", "electron", "renderer-server.cjs"), "utf8");
    expect(rendererServer).toContain('ELECTRON_RUN_AS_NODE: "1"');
  });
});

describe("main-process hardening", () => {
  const main = readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  it("never enables developer tools in a packaged app", () => {
    expect(main).toContain("const devToolsEnabled = !app.isPackaged;");
    expect(main).not.toMatch(/ASSISTANT_EDITOR_DEV"\]/);
  });
  it("guards redirects as well as navigations, and denies web permissions", () => {
    expect(main).toContain('"will-redirect"');
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
  });
});

describe("remote debugging", () => {
  function fakeCommandLine(switches: string[]) {
    const present = new Set(switches);
    return {
      hasSwitch: (name: string) => present.has(name),
      removeSwitch: (name: string) => present.delete(name),
      present,
    };
  }

  it("is stripped from a packaged app before startup", () => {
    const cl = fakeCommandLine(["remote-debugging-port", "remote-debugging-pipe", "remote-allow-origins", "inspect", "lang"]);
    const removed = debugSwitches.disableRemoteDebugging({ isPackaged: true, commandLine: cl });
    expect(removed).toEqual(["remote-debugging-port", "remote-debugging-pipe", "remote-allow-origins", "inspect"]);
    expect([...cl.present]).toEqual(["lang"]);
  });

  it("covers every Chromium remote-debugging switch", () => {
    for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-debugging-targets", "remote-allow-origins"]) {
      expect(debugSwitches.REMOTE_DEBUGGING_SWITCHES).toContain(name);
    }
  });

  it("stays available in development", () => {
    const cl = fakeCommandLine(["remote-debugging-port"]);
    expect(debugSwitches.disableRemoteDebugging({ isPackaged: false, commandLine: cl })).toEqual([]);
    expect(cl.present.has("remote-debugging-port")).toBe(true);
  });

  it("runs first in the main process", () => {
    const main = readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
    const strip = main.indexOf("disableRemoteDebugging({ isPackaged: app.isPackaged, commandLine: app.commandLine })");
    expect(strip).toBeGreaterThan(0);
    for (const later of ["registerMediaProtocolPrivileges(protocol)", "configureAppIdentity(app)", "app.whenReady()"]) {
      expect(main.indexOf(later)).toBeGreaterThan(strip);
    }
  });
});

describe("Python runtime licences", () => {
  const dir = path.join(__dirname, "..", "licenses", "python-runtime");
  const provenance = JSON.parse(readFileSync(path.join(dir, "PROVENANCE.json"), "utf8"));
  const pin = readFileSync(path.join(__dirname, "..", "scripts", "worker-python.sh"), "utf8");

  it("come from the pinned Python build", () => {
    expect(pin).toContain(`PY_VERSION="${provenance.python}"`);
    expect(pin).toContain(`PBS_RELEASE="${provenance.pythonBuildStandalone}"`);
    for (const sha of Object.values(provenance.sources)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("include every library compiled into libpython, unmodified", () => {
    const names = provenance.components.map((c: { name: string }) => c.name);
    for (const name of ["libffi", "Expat", "mpdecimal", "XZ Utils (liblzma)", "bzip2", "HACL*", "OpenSSL", "SQLite", "libuuid"]) {
      expect(names).toContain(name);
    }
    for (const c of provenance.components) {
      const text = readFileSync(path.join(dir, c.file), "utf8");
      expect(createHash("sha256").update(text).digest("hex")).toBe(c.sha256);
      expect(text.length).toBeGreaterThan(200);
    }
  });
});

describe("acknowledgements", () => {
  it("maps bundled module paths to their package directories", () => {
    expect(ack.packageDirOf("/r/node_modules/react/cjs/react.js")).toBe("/r/node_modules/react");
    expect(ack.packageDirOf("/r/node_modules/@radix-ui/react-slot/dist/index.mjs")).toBe(
      "/r/node_modules/@radix-ui/react-slot",
    );
    expect(ack.packageDirOf("/r/node_modules/a/node_modules/b/x.js")).toBe("/r/node_modules/a/node_modules/b");
    expect(ack.packageDirOf("/r/node_modules/.nitro/vite/x.js")).toBeNull();
    expect(ack.packageDirOf("/r/src/routes/cut.tsx")).toBeNull();
  });

  it("collects licence files, including a dist-info licenses/ folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ae-ack-"));
    writeFileSync(path.join(dir, "LICENSE"), "MIT text");
    writeFileSync(path.join(dir, "README.md"), "not a licence");
    mkdirSync(path.join(dir, "licenses"));
    writeFileSync(path.join(dir, "licenses", "NOTICE.txt"), "notice");
    expect(ack.licenceTexts(dir).map((t: { file: string }) => t.file)).toEqual(["LICENSE", "licenses/NOTICE.txt"]);
  });

  it("renders every section and escapes licence text", () => {
    const html = ack.renderAcknowledgements({
      appName: "Assistant Editor AI",
      appVersion: "1.0.0",
      ffmpegLicences: [{ file: "NOTICE.md", text: "FFmpeg 9.0.2 <source>" }],
      electron: { version: "43.4.0", licence: "MIT" },
      python: {
        version: "3.12.15",
        licence: "PSF",
        staticLibraries: [
          { name: "OpenSSL", version: "3.5.9", license: "Apache-2.0", text: "Apache License" },
          { name: "libffi", version: "3.4.8", license: "MIT", text: "libffi - Copyright (c) 1996-2019 Anthony Green" },
        ],
      },
      workerPkgs: [{ name: "openai", version: "2.48.0", license: "Apache-2.0", homepage: "", texts: [] }],
      npmPkgs: [{ name: "react", version: "19.2.8", license: "MIT", homepage: "", texts: [{ file: "LICENSE", text: "a < b" }] }],
    });
    for (const part of ["FFmpeg", "Electron and Chromium", "LICENSES.chromium.html", "Python 3.12.15", "OpenSSL 3.5.9", "libffi licence", "Anthony Green", "openai 2.48.0", "react 19.2.8"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain("FFmpeg 9.0.2 &lt;source&gt;");
    expect(html).toContain("a &lt; b");
  });
});

describe("afterPack payload audit", () => {
  async function fakeApp(asarFiles: Record<string, string>, extra: Record<string, string> = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "ae-app-"));
    const src = path.join(root, "src");
    for (const [rel, text] of Object.entries(asarFiles)) {
      mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      writeFileSync(path.join(src, rel), text);
    }
    const appDir = path.join(root, "Test.app");
    const resources = path.join(appDir, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    await asar.createPackage(src, path.join(resources, "app.asar"));
    for (const [rel, text] of Object.entries(extra)) {
      mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true });
      writeFileSync(path.join(appDir, rel), text);
    }
    return appDir;
  }

  it("passes a clean app", async () => {
    const appDir = await fakeApp({ "package.json": "{}", "electron/main.cjs": "" });
    expect(afterPack.auditPayload({ appDir, markers: ["/Users/someone/", "/repo/root"] }).problems).toEqual([]);
  });

  it("fails on npm packages, an unpacked asar, or build-machine paths", async () => {
    const appDir = await fakeApp(
      { "package.json": "{}", "node_modules/left-pad/index.js": "" },
      {
        "Contents/Resources/app.asar.unpacked/x": "",
        "Contents/Resources/renderer/manifest.mjs": 'filePath: "/Users/someone/repo/src/a.tsx"',
      },
    );
    const { problems } = afterPack.auditPayload({ appDir, markers: ["/Users/someone/"] });
    expect(problems.join("\n")).toMatch(/node_modules/);
    expect(problems.join("\n")).toMatch(/app\.asar\.unpacked exists/);
    expect(problems.join("\n")).toMatch(/renderer\/manifest\.mjs contains \/Users\/someone\//);
  });
});
