<#
  auto-dev.ps1 —— 任务清单驱动的自动开发循环

  一条任务 = 一次 `opencode run`,跑完用外部命令验证;验证不过就整轮回滚并把任务标成失败。
  设计要点:
    * 验证由脚本执行,不由模型自述 —— 这是整个循环唯一可信的判据
    * 一次只做一条任务,失败绝不阻塞后续任务
    * 全程只在本机分支上提交,永不 push

  用法:
    .\auto-dev.ps1 -DryRun                      # 只打印将要发给模型的 prompt,不调用模型
    .\auto-dev.ps1 -MaxRounds 1                 # 先跑一条看看
    .\auto-dev.ps1 -MaxRounds 10                # 正式跑

  更多参数见下方 param 块,或 .\auto-dev.ps1 -Detailed 看注释帮助。
#>
[CmdletBinding()]
param(
  # 目标仓库(默认当前目录)
  [string]$Repo = (Get-Location).Path,
  # 任务清单,相对 $Repo
  [string]$Tasks = "TASKS.md",
  # 验证命令,退出码 0 视为通过。留空则跳过验证(不推荐)
  [string]$Verify = "node --check openleet.user.js; node --test",
  # 模型,provider/model,可带 #variant
  [string]$Model = "opencode-go/deepseek-v4.1-flash",
  # 使用的 agent 名,留空用默认 primary agent
  [string]$Agent = "auto-dev",
  # 最多执行多少条任务
  [int]$MaxRounds = 5,
  # 单条任务在验证失败后最多重试几次(每次会把上次的失败输出喂回去)
  [int]$Retries = 1,
  # 自动化工作分支
  [string]$Branch = "auto/dev",
  # 只打印 prompt,不调用模型、不改动仓库
  [switch]$DryRun,
  # 不传 --auto(默认会传;传了它就没人能回答权限询问了)
  [switch]$NoAuto,
  # 允许「模型没改任何文件」也算通过(默认不允许,防止验证命令恰好成立造成假阳性)
  [switch]$AllowNoOp
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- 基本检查
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$TasksPath = Join-Path $Repo $Tasks
$LogPath = Join-Path $Repo "auto-dev.log"

function Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message
  Write-Host $line
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

if (-not (Test-Path -LiteralPath $TasksPath)) { throw "找不到任务清单:$TasksPath" }
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { throw "PATH 里找不到 opencode" }

Set-Location $Repo

# ---------------------------------------------------------------- git 环境
git rev-parse --git-dir 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  if ($DryRun) { throw "不是 git 仓库:$Repo" }
  Log "不是 git 仓库,初始化并打基线提交"
  git init | Out-Null
  git add -A
  git -c user.name=auto-dev -c user.email=auto-dev@local commit -m "auto-dev: baseline" | Out-Null
}

$dirty = git status --porcelain
if ($dirty) { throw "工作区不干净,先提交或 stash 再跑。`n$dirty" }

git checkout -B $Branch 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "切到分支 $Branch 失败" }
Log "目标仓库:$Repo"
Log "工作分支:$Branch  模型:$Model  agent:$Agent"

# ---------------------------------------------------------------- 主循环
$lastVerifyOutput = ""
$done = 0
$failed = 0

for ($round = 1; $round -le $MaxRounds; $round++) {
  $lines = @(Get-Content -LiteralPath $TasksPath -Encoding utf8)
  $index = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s*\[ \]\s+\S') { $index = $i; break }
  }
  if ($index -lt 0) { Log "没有未完成任务,收工。"; break }

  # 任务正文 = 勾选行 + 到下一个任务 / 二级标题为止的内容
  $title = ($lines[$index] -replace '^\s*-\s*\[ \]\s+', '').Trim()
  $body = New-Object System.Collections.Generic.List[string]
  for ($j = $index + 1; $j -lt $lines.Count; $j++) {
    if ($lines[$j] -match '^\s*-\s*\[[ x!]\]\s+\S') { break }
    if ($lines[$j] -match '^##\s') { break }
    $body.Add($lines[$j])
  }
  $task = ($title + "`n" + ($body -join "`n")).Trim()
  Log ("-" * 62)
  Log "第 $round/$MaxRounds 条:$title"

  $prompt = @"
你在仓库 $Repo 中工作。只完成下面这一条任务。

【任务】
$task

【硬性要求】
- 先读相关文件再动手。
- 改完必须自己执行一遍验证命令并确认退出码为 0:$Verify
- 不要修改 .github/、密钥文件、部署配置;不要 git push。
- 只交付这一条任务,不要顺手重构无关代码。
- 最后用不超过 5 行说明:改了哪些文件、怎么验证的、有什么遗留问题。
"@

  if ($DryRun) {
    Log "[DryRun] 以下 prompt 不会被发送:"
    Write-Host $prompt
    break
  }

  $ok = $false
  for ($attempt = 1; $attempt -le ($Retries + 1) -and -not $ok; $attempt++) {
    $sendPrompt = $prompt
    if ($attempt -gt 1) {
      Log "第 $attempt 次尝试(附上次验证失败的输出)"
      $sendPrompt += "`n`n【上一次尝试的验证输出(失败)】`n$lastVerifyOutput"
    }

    $runArgs = @("run", "--model", $Model, "--title", "auto-dev: $title")
    if ($Agent) { $runArgs += @("--agent", $Agent) }
    if (-not $NoAuto) { $runArgs += "--auto" }
    $runArgs += $sendPrompt

    $sw = [Diagnostics.Stopwatch]::StartNew()
    & opencode @runArgs 2>&1 | Tee-Object -FilePath $LogPath -Append | Out-Null
    $sw.Stop()
    Log ("opencode run 结束:耗时 {0:N1}s,退出码 {1}" -f $sw.Elapsed.TotalSeconds, $LASTEXITCODE)

    # 模型什么都没改 = 这一条没做成。防止「验证命令恰好成立」造成假阳性。
    $changed = @(git status --porcelain 2>$null)
    if (-not $AllowNoOp -and $changed.Count -eq 0) {
      Log "模型没有产生任何文件改动,按失败处理"
      break
    }

    if (-not $Verify) { $ok = $true; break }

    Log "验证:$Verify"
    $output = & pwsh -NoProfile -Command $Verify 2>&1
    $code = $LASTEXITCODE
    $output | Select-Object -Last 30 | Tee-Object -FilePath $LogPath -Append | Out-Null
    if ($code -eq 0 -and -not ($output -match '^\s*not ok')) {
      $ok = $true
    } else {
      $lastVerifyOutput = ($output | Select-Object -Last 30) -join "`n"
      Log "验证未通过(exit $code)"
    }
  }

  if (-not $ok) {
    $failed++
    Log "本条任务未通过:回滚本轮改动,标记为 [!]"
    git checkout -- . 2>$null
    git clean -fd 2>$null | Out-Null
    # 勾选状态必须和任务一起提交,否则会漏进下一条任务的 commit,并让工作区变脏
    $lines[$index] = $lines[$index] -replace '\[ \]', '[!]'
    Set-Content -LiteralPath $TasksPath -Value $lines -Encoding utf8
    git add -A
    git -c user.name=auto-dev -c user.email=auto-dev@local commit -m "auto-dev: 验证失败,跳过 - $title" 2>&1 | Out-Null
    continue
  }

  $lines[$index] = $lines[$index] -replace '\[ \]', '[x]'
  Set-Content -LiteralPath $TasksPath -Value $lines -Encoding utf8
  git add -A
  git -c user.name=auto-dev -c user.email=auto-dev@local commit -m "auto-dev: $title" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Log "提交失败(可能没有产生改动)" }

  $done++
  Log "完成并提交:$title"
}

Log ("-" * 62)
Log "结束:完成 $done 条,失败 $failed 条。日志:$LogPath"
Log "分支 $Branch 上的提交:"
git --no-pager log --oneline -n 10
