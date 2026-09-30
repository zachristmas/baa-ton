import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { busyPorts, elapsedMs, killLaneProcesses, laneProcesses, orphanShells, parseProcessTable, parseWindowsProcessTable, portListening, readProcessTable } from "../inbox/lane-processes.mjs";
import { readSpawnProbe, recordSpawnProbe, spawnThrottled, startupWait } from "../inbox/spawn-load.mjs";

const INTENT = "/state/herdr-d03-lane-1-startup.json";
const TABLE = [
  `  100     1   5-02:00:00 /bin/zsh -l HOME=/u`,
  `  200   100      10:00 node claude --model x BAA_STARTUP_INTENT=${INTENT} HOME=/u`,
  `  300     1    3:30:00 pnpm dev BAA_STARTUP_INTENT=${INTENT} HOME=/u`,
  `  301   300    3:30:00 vite --port 5173 HOME=/u`,
  `  400     1    3:30:00 pnpm dev BAA_STARTUP_INTENT=${INTENT}.other HOME=/u`,
  `  500     1   2-00:00:01 gitstatusd-darwin-arm64 -s 1 HOME=/u`,
  `  600   555      00:05 grep BAA_STARTUP_INTENT=${INTENT}x`,
].join("\n");

function runPowerShellFixture(script, { timezone } = {}) {
  return spawnSync(process.platform === "win32" ? "powershell.exe" : "pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...(timezone ? { TZ: timezone } : {}) },
  });
}

function requirePowerShell(testContext, result) {
  if (result.error?.code === "ENOENT") {
    testContext.skip("PowerShell runtime unavailable for generated-script integration test");
    return false;
  }
  assert.equal(result.error, undefined, `PowerShell fixture failed to start: ${result.error?.message ?? "unknown error"}`);
  return true;
}

test("a lane's process tree: every process carrying its exact marker, reparented ones too, and their children", () => {
  const rows = parseProcessTable(TABLE);
  assert.equal(elapsedMs("5-02:00:00"), (5 * 24 + 2) * 3_600_000);
  assert.equal(elapsedMs("10:00"), 600_000);
  assert.deepEqual(laneProcesses(rows, INTENT, { self: 999 }).map((row) => row.pid), [200, 300, 301]);
  assert.deepEqual(laneProcesses(rows, INTENT, { self: 301 }).map((row) => row.pid), [200], "never this process or its ancestors");
  assert.deepEqual(laneProcesses(rows, undefined), []);
});

test("retire stops descendants before parents and SIGKILLs stubborn leaf processes", async () => {
  let rows = parseProcessTable(TABLE);
  const signals = [];
  const result = await killLaneProcesses({
    intentPath: INTENT,
    table: async () => rows,
    kill: (pid, name) => {
      signals.push(`${name} ${pid}`);
      if (name === "SIGTERM" && pid !== 301) rows = rows.filter((row) => row.pid !== pid);
      if (name === "SIGKILL") rows = rows.filter((row) => row.pid !== pid);
    },
    delay: async () => undefined,
  });
  assert.deepEqual(signals, ["SIGTERM 200", "SIGTERM 301", "SIGKILL 301", "SIGTERM 300"]);
  assert.deepEqual(result.killed, [301]);
  assert.deepEqual(result.survivors, []);
});

test("process cleanup refuses a candidate-set change before signalling anything", async () => {
  const rows = parseProcessTable(TABLE);
  const signals = [];
  await assert.rejects(killLaneProcesses({ intentPath: INTENT, expectedPids: [200], table: async () => rows, kill: (pid, name) => signals.push(`${name} ${pid}`), delay: async () => undefined }), /process inventory changed before cleanup/);
  assert.deepEqual(signals, []);
});

test("a process spawned after inventory aborts before its parent is signalled", async () => {
  let calls = 0;
  let rows = parseProcessTable(TABLE);
  const signals = [];
  await assert.rejects(killLaneProcesses({ intentPath: INTENT, expectedPids: [200, 300, 301], table: async () => { calls += 1; if (calls === 2) rows = [...rows, { pid: 302, ppid: 300, line: "late child" }]; return rows; }, kill: (pid, name) => signals.push(`${name} ${pid}`), delay: async () => undefined }), /inventory changed during cleanup/);
  assert.deepEqual(signals, []);
});

test("Windows inventory normalizes raw CIM creation dates to invariant UTC round-trip ISO", async () => {
  let script;
  const utc = "2026-09-27T03:15:30.1234560Z";
  const rows = await readProcessTable({ platform: "win32", runPowerShell: async (value) => { script = value; return JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, CreationDate: utc, CommandLine: "node worker.js" }]); } });
  assert.deepEqual(rows, [{ pid: 10, ppid: 1, createdAt: utc, line: "node worker.js" }]);
  assert.match(script, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(script, /CreationDate = Convert-CimCreationDateToUtcIso \$_.CreationDate/);
  assert.match(script, /ParseExact\(\$text\.Substring\(0, 21\), 'yyyyMMddHHmmss\.ffffff'/);
  assert.match(script, /ToUniversalTime\(\)\.ToString\('o', \[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.match(script, /DateTimeStyles\]::RoundtripKind/);
  assert.doesNotMatch(script, /\/bin\/ps/);
  assert.deepEqual(parseWindowsProcessTable("[]"), []);
});

test("Windows stop script validates held-handle identities before handle-bound termination", async () => {
  let rows = [
    { pid: 700, ppid: 1, createdAt: "2026-09-27T03:15:30.1234560Z", line: "claude" },
    { pid: 701, ppid: 700, createdAt: "2026-09-27T03:16:30.0000000Z", line: "node child" },
    { pid: 702, ppid: 1, createdAt: "2026-09-27T03:17:30.0000000Z", line: "unrelated process" },
  ];
  const scripts = [];
  let inventoryScript;
  await readProcessTable({ platform: "win32", runPowerShell: async (script) => { inventoryScript = script; return "[]"; } });
  const result = await killLaneProcesses({
    platform: "win32",
    intentPath: INTENT,
    recordedProcesses: [{ pid: 700, createdAt: rows[0].createdAt }],
    table: async () => rows,
    runPowerShell: async (script) => {
      scripts.push(script);
      const payload = /FromBase64String\('([^']+)'/.exec(script)?.[1];
      const candidates = JSON.parse(Buffer.from(payload, "base64").toString());
      assert.deepEqual(candidates, [{ pid: 701, createdAt: rows[1].createdAt }, { pid: 700, createdAt: rows[0].createdAt }]);
      const normalization = (source) => source.match(/function Convert-CimCreationDateToUtcIso \{[\s\S]*?\n\}/)?.[0];
      assert.ok(normalization(inventoryScript), "inventory has the actual shared normalizer");
      assert.equal(normalization(script), normalization(inventoryScript), "stop uses exactly the inventory's CIM-to-UTC normalization");
      assert.match(script, /\n'@\n\$items =/, "native bindings use a correctly terminated PowerShell here-string");
      assert.match(script, /OpenProcess\(0x00100401, \$false, \[int\]\$item\.pid\)/, "one native process handle is opened with query, terminate, and wait rights");
      assert.match(script, /GetProcessTimes\(\$handle, \[ref\]\$creationTicks/);
      assert.match(script, /Convert-CimCreationDateToUtcIso \(\[datetime\]::FromFileTimeUtc\(\$creationTicks\)\)/);
      assert.match(script, /\[HerdrLaneProcessNative\]::TerminateProcess\(\$candidate\.Handle, 1\)/, "termination uses the exact validated handle");
      assert.match(script, /WaitForSingleObject\(\$candidate\.Handle, 10000\)/);
      assert.match(script, /WaitForSingleObject\(\$_.Handle, 0\)/, "survivors are verified through their held handles");
      assert.doesNotMatch(script, /Stop-Process|taskkill|GetProcessById|TerminateProcess\(\[int\]\$item\.pid/);
      const validateAll = script.indexOf("foreach ($item in $items)");
      const terminate = script.indexOf("::TerminateProcess($candidate.Handle, 1)");
      assert.ok(validateAll >= 0 && terminate > validateAll, "all process handles and start identities are acquired before the first termination call");
      assert.ok(script.indexOf("GetProcessTimes($handle") < script.indexOf("$created = Convert-CimCreationDateToUtcIso"), "start time is read from the newly acquired handle");
      for (const candidate of candidates) assert.equal(rows.find((row) => row.pid === candidate.pid)?.createdAt, candidate.createdAt);
      rows = rows.filter((row) => !candidates.some((candidate) => candidate.pid === row.pid));
      return "";
    },
    delay: async () => undefined,
  });
  assert.deepEqual(result.signalled.map(({ pid }) => pid), [701, 700]);
  assert.deepEqual(result.survivors, []);
  assert.equal(scripts.length, 1);
  assert.ok(rows.some((row) => row.pid === 702), "unrelated same-host process is untouched");
});

test("generated Windows inventory normalizes raw CIM timezone fixtures invariantly under different cultures", async (t) => {
  let inventory;
  await readProcessTable({ platform: "win32", runPowerShell: async (script) => { inventory = script; return "[]"; } });
  assert.match(inventory, /ParseExact\(\$text\.Substring\(0, 21\), 'yyyyMMddHHmmss\.ffffff', \[Globalization\.CultureInfo\]::InvariantCulture/);
  assert.match(inventory, /\[datetimeoffset\]::new\(\$wall, \[timespan\]::FromMinutes\(\$offsetMinutes\)\)\.UtcDateTime/);
  assert.match(inventory, /ToUniversalTime\(\)\.ToString\('o', \[Globalization\.CultureInfo\]::InvariantCulture\)/);
  const fixtures = [
    { ProcessId: 901, ParentProcessId: 1, CreationDate: "20260927031530.123456+000", CommandLine: "fixture-utc" },
    { ProcessId: 902, ParentProcessId: 1, CreationDate: "20260926221530.123456-300", CommandLine: "fixture-offset" },
  ];
  const encodedFixtures = Buffer.from(JSON.stringify(fixtures)).toString("base64");
  const outputs = [];
  for (const [culture, timezone] of [["en-US", "UTC"], ["de-DE", "America/Los_Angeles"]]) {
    const prelude = `[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('${culture}'); ` +
      `$script:fixtureRows = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFixtures}')) | ConvertFrom-Json; ` +
      `function Get-CimInstance { param([string]$ClassName); $script:fixtureRows }; `;
    const result = runPowerShellFixture(`${prelude}\n${inventory}`, { timezone });
    if (!requirePowerShell(t, result)) return;
    assert.equal(result.status, 0, result.stderr);
    const rows = parseWindowsProcessTable(result.stdout);
    assert.deepEqual(rows.map(({ pid, createdAt }) => [pid, createdAt]), [
      [901, "2026-09-27T03:15:30.1234560Z"],
      [902, "2026-09-27T03:15:30.1234560Z"],
    ], `${culture}/${timezone} must produce the same UTC round-trip identity from raw CIM values`);
    outputs.push(rows.map(({ createdAt }) => createdAt));
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test("generated Windows stop script holds and verifies all fake handles before any signal", async (t) => {
  const rows = [
    { pid: 700, ppid: 1, createdAt: "2026-09-27T03:15:30.1234560Z", line: "claude" },
    { pid: 701, ppid: 700, createdAt: "2026-09-27T03:16:30.0000000Z", line: "node child" },
  ];
  let inventoryScript;
  await readProcessTable({ platform: "win32", runPowerShell: async (script) => { inventoryScript = script; return "[]"; } });
  const generated = [];
  await killLaneProcesses({
    platform: "win32", intentPath: INTENT, recordedProcesses: [{ pid: 700, createdAt: rows[0].createdAt }],
    table: async () => rows,
    runPowerShell: async (script) => { generated.push(script); return ""; },
  });
  assert.equal(generated.length, 1);
  const stopScript = generated[0];
  const normalizer = (source) => source.match(/function Convert-CimCreationDateToUtcIso \{[\s\S]*?\n\}/)?.[0];
  assert.equal(normalizer(stopScript), normalizer(inventoryScript), "termination identity uses the inventory's exact invariant normalizer");
  assert.match(stopScript, /OpenProcess\(0x00100401, \$false, \[int\]\$item\.pid\)/);
  assert.match(stopScript, /GetProcessTimes\(\$handle, \[ref\]\$creationTicks/);
  assert.match(stopScript, /\$planned = Convert-CimCreationDateToUtcIso \$item\.createdAt/);
  assert.doesNotMatch(stopScript, /\[string\]\$item\.createdAt/, "ConvertFrom-Json timestamps are normalized, never locale-formatted for comparison");
  assert.match(stopScript, /::TerminateProcess\(\$candidate\.Handle, 1\)/);
  assert.ok(stopScript.indexOf("foreach ($item in $items)") < stopScript.indexOf("foreach ($candidate in $held) { if (![HerdrLaneProcessNative]::TerminateProcess"), "the whole acquisition and start-time verification loop precedes termination");
  assert.doesNotMatch(stopScript, /Stop-Process|taskkill|GetProcessById/);
  const nativeStub = (killLog, parentActual, missingParent) => String.raw`Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
public static class HerdrLaneProcessNative {
  static long Child = DateTime.Parse("2026-09-27T03:16:30.0000000Z", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToFileTimeUtc();
  static long Parent = DateTime.Parse("${parentActual}", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToFileTimeUtc();
  public static IntPtr OpenProcess(uint access, bool inherit, int processId) { return ${missingParent ? "processId == 700 ? IntPtr.Zero : new IntPtr(processId)" : "new IntPtr(processId)"}; }
  public static bool GetProcessTimes(IntPtr process, out long creationTime, out long exitTime, out long kernelTime, out long userTime) { creationTime = process.ToInt32() == 701 ? Child : Parent; exitTime = 0; kernelTime = 0; userTime = 0; return true; }
  public static bool TerminateProcess(IntPtr process, uint exitCode) { File.AppendAllText(${JSON.stringify(killLog)}, process.ToInt32().ToString(CultureInfo.InvariantCulture) + "\n"); return true; }
  public static uint WaitForSingleObject(IntPtr handle, uint milliseconds) { return 0; }
  public static bool CloseHandle(IntPtr handle) { return true; }
}
'@`;
  const nativeBlock = /Add-Type -TypeDefinition @'[\s\S]*?\n'@/;
  const directory = await mkdtemp(join(tmpdir(), "baa-win-process-fixture-"));
  try {
    const killLog = join(directory, "kills.txt");
    for (const [culture, timezone] of [["en-US", "UTC"], ["de-DE", "America/Los_Angeles"]]) {
      await rm(killLog, { force: true });
      const validScript = stopScript.replace(nativeBlock, nativeStub(killLog, rows[0].createdAt, false));
      const valid = runPowerShellFixture(`[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('${culture}');\n${validScript}`, { timezone });
      if (!requirePowerShell(t, valid)) return;
      assert.equal(valid.status, 0, `${culture}/${timezone}: ${valid.stderr}`);
      assert.equal(await readFile(killLog, "utf8"), "701\n700\n", `${culture}/${timezone} uses normalized identities and terminates in planned child-before-parent order`);
    }
    for (const [failure, culture, timezone, parentActual, missingParent] of [
      ["mismatched start time", "de-DE", "America/Los_Angeles", "2025-01-01T00:00:00.0000000Z", false],
      ["missing later handle", "fr-FR", "America/New_York", rows[0].createdAt, true],
    ]) {
      await rm(killLog, { force: true });
      const failingScript = stopScript.replace(nativeBlock, nativeStub(killLog, parentActual, missingParent));
      const result = runPowerShellFixture(`[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('${culture}');\n${failingScript}`, { timezone });
      assert.notEqual(result.status, 0, `${failure} must fail closed`);
      assert.match(result.stderr, /identity changed|handle\/access is unavailable/);
      await assert.rejects(readFile(killLog, "utf8"), { code: "ENOENT" }, `${failure} on the later candidate must result in zero termination calls`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows refuses a later mismatched or missing candidate identity before any stop script runs", async () => {
  for (const failure of ["missing", "mismatched"]) {
    const good = [
      { pid: 820, ppid: 1, createdAt: "root-time", line: `node BAA_STARTUP_INTENT=${INTENT}` },
      { pid: 821, ppid: 820, createdAt: "child-time", line: "wrapper child" },
    ];
    let reads = 0;
    let stopCalls = 0;
    const table = async () => {
      reads += 1;
      if (reads === 1) return good;
      return [good[0], failure === "missing" ? { ...good[1], createdAt: undefined } : { ...good[1], createdAt: "reused-child" }];
    };
    await assert.rejects(killLaneProcesses({
      platform: "win32", intentPath: INTENT, recordedProcesses: [{ pid: 820, createdAt: "root-time" }], expectedPids: [820, 821], table,
      runPowerShell: async () => { stopCalls += 1; },
    }), failure === "missing" ? /candidate PID 821 creation identity is missing/ : /process tree changed before cleanup/);
    assert.equal(stopCalls, 0, `${failure} later identity must prevent every termination`);
  }
});

test("Windows refuses a reused PID between inventory and stop", async () => {
  let calls = 0;
  const table = async () => {
    calls += 1;
    return [{ pid: 810, ppid: 1, createdAt: calls === 1 ? "old-creation" : "new-creation", line: "reused" }];
  };
  await assert.rejects(killLaneProcesses({ platform: "win32", intentPath: INTENT, recordedProcesses: [{ pid: 810, createdAt: "old-creation" }], table, runPowerShell: async () => assert.fail("must refuse before Stop-Process"), delay: async () => undefined }), /was reused/);
});

test("Windows refuses to claim process cleanup without recorded identity or creation-time evidence", async () => {
  await assert.rejects(killLaneProcesses({ platform: "win32", intentPath: INTENT, table: async () => [] }), /cannot enumerate process environments/);
  await assert.rejects(killLaneProcesses({ platform: "win32", intentPath: INTENT, recordedProcesses: [{ pid: 800, createdAt: "old" }], table: async () => [{ pid: 800, ppid: 1, line: "node" }], delay: async () => undefined }), /creation time/);
});

test("ports are checked free after retire", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    assert.equal(await portListening(port), true);
    assert.deepEqual(await busyPorts([port]), [port]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(await busyPorts([port]), []);
});

test("orphaned shells older than a day are reported, live terminal shells are not", () => {
  const found = orphanShells(parseProcessTable(TABLE));
  assert.deepEqual(found.map((item) => item.pid), [100, 500]);
  assert.ok(found.every((item) => item.laneOwned === false), "unmarked shells are not lane-owned");
  assert.equal(orphanShells([{ pid: 9, ppid: 1, ageMs: 2 * 86_400_000, line: "-zsh BAA_STARTUP_INTENT=/x" }])[0].laneOwned, true);
});

test("startup waits scale with the process-start probe; over 2 s dispatch is throttled", async () => {
  assert.equal(startupWait(60_000, undefined), 60_000);
  assert.equal(startupWait(60_000, 50), 60_000, "a fast machine keeps the base wait");
  assert.equal(startupWait(60_000, 40_000), 120_000, "3x the probe");
  assert.equal(startupWait(60_000, 400_000), 300_000, "capped at 5 min");
  assert.equal(spawnThrottled(2_000), false);
  assert.equal(spawnThrottled(2_001), true);
  const directory = await mkdtemp(join(tmpdir(), "baa-probe-"));
  try {
    const env = { HERDR_PLUGIN_CONFIG_DIR: directory };
    recordSpawnProbe({ ms: 31_000, at: "2026-09-27T03:00:00.000Z" }, env);
    assert.equal(JSON.parse(await readFile(join(directory, "spawn-probe.json"), "utf8")).ms, 31_000);
    assert.equal(readSpawnProbe(env, { now: Date.parse("2026-09-27T03:05:00.000Z") }), 31_000);
    assert.equal(readSpawnProbe(env, { now: Date.parse("2026-09-27T03:20:00.000Z") }), undefined, "a stale probe is not used");
    assert.equal(readSpawnProbe({ ...env, BAA_TON_NO_SPAWN_PROBE: "1" }, { now: Date.parse("2026-09-27T03:05:00.000Z") }), undefined);
    await writeFile(join(directory, "spawn-probe.json"), "not json");
    assert.equal(readSpawnProbe(env), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
