import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const releaseDir = join(projectRoot, 'release')

rmSync(releaseDir, { recursive: true, force: true })
mkdirSync(releaseDir, { recursive: true })
mkdirSync(join(releaseDir, 'data'), { recursive: true })
mkdirSync(join(releaseDir, 'docs'), { recursive: true })

copyRequiredPath('dist')
copyRequiredPath('package.json')
copyRequiredPath('pnpm-lock.yaml')
copyRequiredPath('.env.example')
copyRequiredPath('LLM.md')
copyRequiredPath('docs/usage.md')
copyRequiredPath('docs/state-file.md')

writeFileSync(join(releaseDir, 'data', '.gitkeep'), '\n')
writeFileSync(join(releaseDir, '.npmrc'), 'production=true\n')
writeFileSync(join(releaseDir, 'start.sh'), buildStartScript())
chmodSync(join(releaseDir, 'start.sh'), 0o755)
writeFileSync(join(releaseDir, 'start.cmd'), toWindowsLineEndings(buildWindowsStartScript()))
writeFileSync(join(releaseDir, '使用方式.txt'), buildReadme())

console.log(`[release] prepared at ${releaseDir}`)

function copyRequiredPath(relativePath) {
  const source = join(projectRoot, relativePath)
  const target = join(releaseDir, relativePath)

  if (!existsSync(source)) {
    throw new Error(`Missing required path: ${relativePath}`)
  }

  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (currentSource) => {
      const normalized = currentSource.replace(/\\/g, '/')
      if (normalized.endsWith('/data/proxy-state.json')) return false
      if (normalized.includes('/data/proxy-state.json.')) return false
      return true
    },
  })
}

function buildStartScript() {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "已生成 .env，请先填写 PROXY_API_KEY、DASHSCOPE_API_KEYS、MODEL_IDS 后再重新运行 ./start.sh"
  exit 1
fi

mkdir -p data

if [ ! -d "node_modules" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --prod --frozen-lockfile
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install --prod --frozen-lockfile
  else
    echo "未找到 pnpm 或 corepack，请先安装 Node.js 20+（含 corepack）或 pnpm"
    exit 1
  fi
fi

exec node dist/index.js
`
}

function buildReadme() {
  return `1. 确认机器已安装 Node.js 20 或更高版本。
2. 首次运行：
   - Windows：双击 start.cmd，或在 cmd/PowerShell 里执行 start.cmd
   - macOS / Linux：执行 ./start.sh
3. 如果当前目录没有 .env，会自动从 .env.example 生成一份模板。
4. 打开 .env，至少填写:
   - PROXY_API_KEY
   - DASHSCOPE_API_KEYS
   - MODEL_IDS
5. 再次运行启动脚本：
   - Windows：start.cmd
   - macOS / Linux：./start.sh

说明:
- 首次真正启动时会自动安装运行时依赖
- 首次启动会自动创建新的 data/proxy-state.json
- 运行时依赖不包含原生编译模块，Windows 上不需要额外安装 C++ 编译环境
`
}

function buildWindowsStartScript() {
  return `@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example
  echo Fill PROXY_API_KEY, DASHSCOPE_API_KEYS and MODEL_IDS
  echo Then run start.cmd again
  echo.
  pause
  exit /b 1
)

if not exist "data" mkdir data

if not exist "node_modules" (
  where pnpm >nul 2>nul
  if not errorlevel 1 (
    call pnpm install --prod --frozen-lockfile
    if errorlevel 1 goto :install_failed
    goto :run
  )

  where corepack >nul 2>nul
  if not errorlevel 1 (
    call corepack pnpm install --prod --frozen-lockfile
    if errorlevel 1 goto :install_failed
    goto :run
  )

  echo pnpm or corepack was not found
  echo Install Node.js 20+ or pnpm first
  echo.
  pause
  exit /b 1
)

:run
call node dist\\index.js
set EXIT_CODE=%errorlevel%
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Service exited with code %EXIT_CODE%
  pause
)
exit /b %EXIT_CODE%

:install_failed
echo.
echo Dependency install failed
echo Check Node.js, pnpm and build tools
pause
exit /b 1
`
}

function toWindowsLineEndings(value) {
  return value.replace(/\n/g, '\r\n')
}
