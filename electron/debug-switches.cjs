// Packaged builds never open a debugging/automation endpoint into the app.
//
// Chromium honours `--remote-debugging-port=…` / `--remote-debugging-pipe`
// (and Node's `--inspect…` flags) from the command line: anything able to
// launch the app with arguments could otherwise drive the interface and its
// IPC. Node's inspect flags are already disabled by an Electron fuse
// (package.json build.electronFuses); Chromium's remote debugging has no fuse,
// so the packaged app removes those switches here, at the very start of the
// main script — before app "ready", when Chromium starts its DevTools server.
// Development builds keep them.

const REMOTE_DEBUGGING_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-debugging-targets",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
];

/**
 * Removes every remote-debugging switch from `commandLine` (Electron's
 * app.commandLine) in a packaged build. Returns the switches it removed.
 */
function disableRemoteDebugging({ isPackaged, commandLine }) {
  if (!isPackaged) return [];
  const removed = [];
  for (const name of REMOTE_DEBUGGING_SWITCHES) {
    if (commandLine.hasSwitch(name)) {
      commandLine.removeSwitch(name);
      removed.push(name);
    }
  }
  return removed;
}

module.exports = { REMOTE_DEBUGGING_SWITCHES, disableRemoteDebugging };
