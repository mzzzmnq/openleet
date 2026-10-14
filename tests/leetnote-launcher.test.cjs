const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const library = path.join(repo, 'scripts', 'leetnote-launcher-lib.ps1');
const handler = path.join(repo, 'scripts', 'leetnote-launcher.ps1');
const installer = path.join(repo, 'scripts', 'install-leetnote-launcher.ps1');
const quote = value => `'${value.replace(/'/g, "''")}'`;
const windows = process.platform === 'win32';
const powershell = windows && ['pwsh.exe', 'powershell.exe'].find(executable => {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
  return !result.error && result.status === 0;
});

// Mock every registry mutation and service-launch operation. Tests only create
// disposable fixture files; they never install a protocol or start LeetNote.
const mocks = `
$global:registry = @{}
$global:launches = @()
$global:waitCalls = 0
$global:fakeExitCode = 0
$global:logs = @()
function Test-Path {
  [CmdletBinding()] param([string]$LiteralPath, [string]$PathType)
  if ($LiteralPath.StartsWith('HKCU:', [StringComparison]::OrdinalIgnoreCase)) {
    return $global:registry.ContainsKey($LiteralPath)
  }
  if ($PathType) { return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
  return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath
}
function Get-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath)
  if (-not $global:registry.ContainsKey($LiteralPath)) { throw 'Missing fake registry key.' }
  return [pscustomobject]$global:registry[$LiteralPath]
}
function New-Item {
  [CmdletBinding()] param([string]$Path, [switch]$Force)
  if (-not $Path.StartsWith('HKCU:\\Software\\Classes\\openleet-leetnote')) { throw 'Unexpected registry write.' }
  if (-not $global:registry.ContainsKey($Path)) { $global:registry[$Path] = @{} }
}
function Set-Item {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Value)
  $global:registry[$LiteralPath]['DefaultValue'] = $Value
}
function New-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force)
  $global:registry[$LiteralPath][$Name] = $Value
}
function Remove-Item {
  [CmdletBinding()] param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
  if ($LiteralPath -ne 'HKCU:\\Software\\Classes\\openleet-leetnote') { throw 'Unexpected registry removal.' }
  foreach ($key in @($global:registry.Keys)) {
    if ($key -eq $LiteralPath -or $key.StartsWith($LiteralPath + '\\')) { $global:registry.Remove($key) }
  }
}
function Write-OpenLeetLauncherLog { param([string]$Message) $global:logs += $Message }
function Start-Process {
  [CmdletBinding()] param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle,
    [switch]$Wait, [switch]$PassThru, [string]$RedirectStandardOutput, [string]$RedirectStandardError)
  $global:launches += [pscustomobject]@{
    FilePath=$FilePath; Arguments=@($ArgumentList); WorkingDirectory=$WorkingDirectory;
    WindowStyle=$WindowStyle; Wait=[bool]$Wait; PassThru=[bool]$PassThru;
    Stdout=$RedirectStandardOutput; Stderr=$RedirectStandardError
  }
  $result = [pscustomobject]@{ ExitCode=$global:fakeExitCode }
  $result | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { $global:waitCalls++ }
  return $result
}
`;

function runPowerShell(code, options = {}) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'\n. ${quote(library)}\n${mocks}\n${code}`, 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, ...options,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

function withProject(callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openleet launcher test '));
  const project = path.join(temporary, "Leet Note's project");
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'start-all.ps1'), "throw 'Fixture must never execute.'");
  fs.writeFileSync(path.join(project, 'scripts', 'services.ps1'), '# fixture');
  try { return callback(project, temporary); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

const setup = project => `
$null = Set-OpenLeetLauncherRegistration -LeetNotePath ${quote(project)} -HandlerPath ${quote(handler)} -PowerShellPath (Get-OpenLeetPowerShellPath)
`;
const options = { skip: !windows || !powershell };

test('launcher registration quotes paths and only writes the current-user protocol', options, () => withProject(project => {
  const result = runPowerShell(`${setup(project)}
    @{ Keys=@($global:registry.Keys); Root=$global:registry[$OpenLeetProtocolKey];
      Command=$global:registry[(Join-Path $OpenLeetProtocolKey 'shell\\open\\command')].DefaultValue;
      LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress -Depth 5`);
  assert.equal(result.Root.LeetNotePath, project);
  assert.equal(result.Root['URL Protocol'], '');
  assert.equal(result.Root.OpenLeetLauncher, 'openleet-fixed-start-v1');
  assert.ok(result.Keys.every(key => key.startsWith('HKCU:\\Software\\Classes\\openleet-leetnote')));
  assert.ok(result.Command.includes(`-File "${handler}" "%1"`));
  assert.ok(result.Command.includes('-WindowStyle Hidden'));
  assert.equal(result.LaunchCount, 0);
}));

test('launcher rejects commands, query parameters, paths, and unknown actions before starting', options, () => withProject(project => {
  const uris = [
    'openleet-leetnote://stop', 'openleet-leetnote://start?command=calc.exe',
    'openleet-leetnote://start/path', 'openleet-leetnote://start#anything',
    'https://start', 'openleet-leetnote://start" -Command calc.exe',
  ];
  const result = runPowerShell(`${setup(project)}
    $rejected=0
    foreach ($uri in @(${uris.map(quote).join(',')})) {
      try { Invoke-OpenLeetLeetNoteLaunch -LaunchUri $uri | Out-Null } catch { $rejected++ }
    }
    @{ Rejected=$rejected; LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress`);
  assert.equal(result.Rejected, uris.length);
  assert.equal(result.LaunchCount, 0);
}));

test('fixed launch uses start-all.ps1 -Quiet, hidden window, and waits only for the wrapper', options, () => withProject(project => {
  const result = runPowerShell(`${setup(project)}
    $status=Invoke-OpenLeetLeetNoteLaunch -LaunchUri 'openleet-leetnote://start/'
    @{ Status=$status; Launches=@($global:launches); WaitCalls=$global:waitCalls } | ConvertTo-Json -Compress -Depth 5`);
  assert.equal(result.Status, 'started');
  assert.equal(result.Launches.length, 1);
  const launch = result.Launches[0];
  assert.deepEqual(launch.Arguments, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${path.join(project, 'start-all.ps1')}"`, '-Quiet']);
  assert.equal(launch.WorkingDirectory, project);
  assert.equal(launch.WindowStyle, 'Hidden');
  assert.equal(launch.Wait, false);
  assert.equal(launch.PassThru, true);
  assert.equal(result.WaitCalls, 1);
  assert.ok(launch.Stdout.endsWith('openleet-leetnote.start.out.log'));
  assert.ok(launch.Stderr.endsWith('openleet-leetnote.start.err.log'));
}));

test('missing project files and unowned protocols cannot be installed or removed', options, () => withProject((project, temporary) => {
  const incomplete = path.join(temporary, 'incomplete');
  fs.mkdirSync(incomplete);
  fs.writeFileSync(path.join(incomplete, 'start-all.ps1'), '# fixture');
  const result = runPowerShell(`
    $rejected=0
    try { Set-OpenLeetLauncherRegistration -LeetNotePath ${quote(incomplete)} -HandlerPath ${quote(handler)} -PowerShellPath (Get-OpenLeetPowerShellPath) | Out-Null } catch { $rejected++ }
    $emptyAfterInvalid=$global:registry.Count -eq 0
    $global:registry[$OpenLeetProtocolKey]=@{ OpenLeetLauncher='another-app'; LeetNotePath=${quote(project)} }
    try { Set-OpenLeetLauncherRegistration -LeetNotePath ${quote(project)} -HandlerPath ${quote(handler)} -PowerShellPath (Get-OpenLeetPowerShellPath) | Out-Null } catch { $rejected++ }
    try { Remove-OpenLeetLauncherRegistration } catch { $rejected++ }
    @{ Rejected=$rejected; EmptyAfterInvalid=$emptyAfterInvalid; Owner=$global:registry[$OpenLeetProtocolKey].OpenLeetLauncher } | ConvertTo-Json -Compress`);
  assert.equal(result.Rejected, 3);
  assert.equal(result.EmptyAfterInvalid, true);
  assert.equal(result.Owner, 'another-app');
}));

test('wrapper failure releases the launch mutex and a following launch can succeed', options, () => withProject(project => {
  const result = runPowerShell(`${setup(project)}
    $global:fakeExitCode=7
    $failure=''
    try { Invoke-OpenLeetLeetNoteLaunch -LaunchUri 'openleet-leetnote://start' | Out-Null } catch { $failure=$_.Exception.Message }
    $global:fakeExitCode=0
    $status=Invoke-OpenLeetLeetNoteLaunch -LaunchUri 'openleet-leetnote://start'
    @{ Failure=$failure; Status=$status; LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress`);
  assert.match(result.Failure, /exited with code 7/);
  assert.equal(result.Status, 'started');
  assert.equal(result.LaunchCount, 2);
}));

test('uninstallation removes the owned protocol without starting or stopping services', options, () => withProject(project => {
  const result = runPowerShell(`${setup(project)}
    $global:registry['HKCU:\\Software\\Classes\\unrelated']=@{}
    Remove-OpenLeetLauncherRegistration
    @{ Keys=@($global:registry.Keys); LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress`);
  assert.deepEqual(result.Keys, ['HKCU:\\Software\\Classes\\unrelated']);
  assert.equal(result.LaunchCount, 0);
}));

test('installer -WhatIf validates the project and leaves registry unchanged', options, () => withProject(project => {
  const result = runPowerShell(`
    & ${quote(installer)} -LeetNotePath ${quote(project)} -WhatIf | Out-Null
    @{ RegistryCount=$global:registry.Count; LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress`);
  assert.equal(result.RegistryCount, 0);
  assert.equal(result.LaunchCount, 0);
}));

test('handler rejects extra arguments before touching services', options, () => withProject((project, temporary) => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', handler, 'openleet-leetnote://start', 'unexpected'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TEMP: temporary },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /positional parameter|Unexpected extra launcher arguments/);
}));

test('handler records rejected URI errors in its local log', options, () => withProject((project, temporary) => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', handler, 'openleet-leetnote://start?command=calc.exe'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TEMP: temporary },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported launch URI/);
  assert.match(fs.readFileSync(path.join(temporary, 'openleet-leetnote.launcher.log'), 'utf8'), /Unsupported launch URI/);
}));

test('valid URI runs through the actual handler entry point with isolated service and registry mocks', options, () => withProject((project, temporary) => {
  const mutexName = `Local\\openleet-launcher-test-${require('node:crypto').randomUUID()}`;
  const result = runPowerShell(`${setup(project)}
    $env:TEMP=${quote(temporary)}
    function New-Object {
      [CmdletBinding()] param([string]$TypeName, [object[]]$ArgumentList)
      if ($TypeName -eq 'System.Threading.Mutex') { return [System.Threading.Mutex]::new($false, ${quote(mutexName)}) }
      return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
    }
    & ${quote(handler)} -LaunchUri 'openleet-leetnote://start'
    @{ LaunchCount=$global:launches.Count; WaitCalls=$global:waitCalls } | ConvertTo-Json -Compress
  `);
  assert.equal(result.LaunchCount, 1);
  assert.equal(result.WaitCalls, 1);
  assert.match(fs.readFileSync(path.join(temporary, 'openleet-leetnote.launcher.log'), 'utf8'), /start-all.ps1 completed/);
}));

test('a second process skips startup while the first holds the launch mutex', options, () => {
  const mutexName = `Local\\openleet-launcher-test-${require('node:crypto').randomUUID()}`;
  const childCode = `$ErrorActionPreference='Stop'\n. ${quote(library)}\nfunction Get-OpenLeetLauncherMutexName { return ${quote(mutexName)} }\nfunction Get-OpenLeetLauncherRegistration { throw 'Must not inspect registration while busy.' }\nInvoke-OpenLeetLeetNoteLaunch -LaunchUri 'openleet-leetnote://start'`;
  const childEncoded = Buffer.from(childCode, 'utf16le').toString('base64');
  const result = runPowerShell(`
    $mutex=New-Object System.Threading.Mutex($false, ${quote(mutexName)})
    $owns=$mutex.WaitOne(0)
    if (-not $owns) { throw 'Could not acquire the test mutex.' }
    try {
      $status=& ${quote(powershell)} -NoProfile -NonInteractive -EncodedCommand ${quote(childEncoded)}
      if ($LASTEXITCODE -ne 0) { throw 'Child launch-lock test failed.' }
      @{ Status=$status; LaunchCount=$global:launches.Count } | ConvertTo-Json -Compress
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
  `);
  assert.equal(result.Status, 'already-starting');
  assert.equal(result.LaunchCount, 0);
});
