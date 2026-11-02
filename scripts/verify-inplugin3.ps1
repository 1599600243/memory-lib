# IN-PLUGIN-3 一键复核（只读 + 测试，不改任何生产文件）
# 用法: pwsh -File .\scripts\verify-inplugin3.ps1
#
# 2026-10-20 修订（验收岗 5 指出三个真缺陷，已修）：
#   ① 所有 git 命令加 `-c safe.directory`（本机仓库属主是 Administrators，不加会全空）
#   ② 测试改**进程内**跑（`node <file>.test.mjs`）：`node --test` 会起带管道 stdio 的子进程，沙箱里报 spawn EPERM
#   ③ 红测前**校验改前文件真的被覆盖**：字节数/哈希对不上就报 FAIL 并中止，
#      不再出现"git show 失败 → 留成改后文件 → 却打印一个正常字节数 → 红测退化成拿改后测改后"
$ErrorActionPreference = 'Continue'
$REPO  = '.'
$PLUG  = "$REPO\scripts\dsh-memory-capture"
$RED   = "$REPO\scripts\tmp-redcheck"
$BASE  = '81efe7f'          # 改前提交（IN-PLUGIN-2 版本，index.js = 35123B）
$GIT   = { param($a) git -c safe.directory=D:/MemoryLib -C $REPO @a }

function Line($t) { Write-Output ("`n=== $t ===") }

Line "0) 时间 / 主机"
Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; hostname

Line "1) 所验提交与工作树"
& $GIT @('rev-parse','HEAD')
& $GIT @('rev-parse','b503ffd')
& $GIT @('log','-3','--oneline')
$dirty = (& $GIT @('status','--porcelain') | Measure-Object -Line).Lines
Write-Output "未提交改动: $dirty 处"

Line "2) RANK-1 的 recall.mjs 有没有被动过（应无未提交改动、最近一次提交仍是 621b08f）"
# 注意：621b08f 是 **app 仓库**的提交，不在顶层仓库里 —— 必须 -C 到 app
git -c safe.directory=D:/MemoryLib/app -C "$REPO\app" log -1 --oneline -- memory-lib/src/recall.mjs
$mdirty = (git -c safe.directory=D:/MemoryLib/app -C "$REPO\app" status --porcelain -- memory-lib/src/recall.mjs | Measure-Object -Line).Lines
Write-Output "recall.mjs 未提交改动: $mdirty 处（0 = 未动）"

Line "3) 本单改了哪些文件"
& $GIT @('diff','--stat','81efe7f..HEAD','--','scripts/dsh-memory-capture')

Line "4) 绿：当前插件跑插件注入测试（进程内）"
Push-Location $REPO
node scripts\dsh-memory-capture\plugin-inject.test.mjs 2>&1 | Select-String 'IN-PLUGIN-3|^ℹ (tests|pass|fail)|^✖'
Pop-Location

Line "5) 红：把 index.js 换回改前 $BASE 再跑同一套（预期 Q1/Q3/Q5 三条失败）"
if (Test-Path $RED) { Remove-Item $RED -Recurse -Force }
Copy-Item $PLUG $RED -Recurse -Force

# 5.1 写入改前版本
$blob = (& $GIT @('show',"$BASE`:scripts/dsh-memory-capture/index.js")) -join "`n"
Set-Content "$RED\index.js" -Value $blob -Encoding UTF8 -NoNewline

# 5.2 用**语义标记**校验覆盖是否成功（字节数受 CRLF 影响不可靠）：
#     改前版有 `lastUserTexts: []`、没有 `queryTexts: new Map()`；改后版相反。
$redTxt = Get-Content "$RED\index.js" -Raw
$hasOld = $redTxt -match 'lastUserTexts:\s*\[\s*\]'
$hasNew = $redTxt -match 'queryTexts:\s*new Map\(\)'
$okCopy = ($hasOld -and -not $hasNew)
Write-Output ("覆盖校验：含改前标记 lastUserTexts=[] → {0}；含改后标记 queryTexts:new Map() → {1}；判定 {2}" -f $hasOld, $hasNew, $(if ($okCopy) { '✓ 真覆盖成改前版本' } else { '✗ 覆盖失败（红测无效）' }))
if (-not $okCopy) {
  Write-Output "!! 红测判据不成立：$RED\index.js 不是改前版本 —— 不予采信，中止"
  Remove-Item $RED -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "`n== 复核结束（红测未完成）=="; exit 2
}
Write-Output ("字节数参考：改前 blob {0}B / 改后 {1}B" -f [int](& $GIT @('cat-file','-s',"$BASE`:scripts/dsh-memory-capture/index.js")), (Get-Item "$PLUG\index.js").Length)

$env:INPLUGIN2_PLUGIN_DIR = $RED
Push-Location $REPO
node "$RED\plugin-inject.test.mjs" 2>&1 | Select-String 'IN-PLUGIN-3|^ℹ (tests|pass|fail)|^✖'
Pop-Location
Remove-Item Env:\INPLUGIN2_PLUGIN_DIR -ErrorAction SilentlyContinue

Line "6) queryHead / sessionId 是否写进三类日志调用"
Select-String -Path "$PLUG\index.js" -Pattern 'queryHead' | Select-Object -First 8 | ForEach-Object { "  {0}: {1}" -f $_.LineNumber, $_.Line.Trim().Substring(0, [Math]::Min(100, $_.Line.Trim().Length)) }

Line "7) 隔离数据结构是否真是按会话 Map"
Select-String -Path "$PLUG\index.js" -Pattern 'queryTexts|rememberUserText|evictQueryTexts|SESSION_END_EVENTS' | Select-Object -First 10 | ForEach-Object { "  {0}: {1}" -f $_.LineNumber, $_.Line.Trim().Substring(0, [Math]::Min(100, $_.Line.Trim().Length)) }

Line "8) 清理临时目录"
Remove-Item $RED -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ("临时目录已删: " + (-not (Test-Path $RED)))
Write-Output "`n== 复核结束（以上输出可直接引用到验收报告）=="
