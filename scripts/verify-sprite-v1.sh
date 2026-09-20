#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

required=(
  git git-lfs bun node corepack tsc python3 rg jq sqlite3 cmake ninja clang
  ld.lld google-chrome ffmpeg convert compare vulkaninfo Xvfb websocat rustc
  cargo rustup wasm-bindgen wasm-pack wasm-opt codex claude muse
)

missing=()
for command_name in "${required[@]}"; do
  if ! command -v "$command_name" >/dev/null; then
    missing+=("$command_name")
  fi
done

if ((${#missing[@]})); then
  printf 'Missing required commands: %s\n' "${missing[*]}" >&2
  exit 1
fi

if [[ "$(bun --version)" != "1.4.2" ]]; then
  echo "Expected Bun 1.4.2, found $(bun --version)." >&2
  exit 1
fi

if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  echo "Expected Node.js 24 LTS, found $(node --version)." >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  echo "Rust WebAssembly target is not installed." >&2
  exit 1
fi

credential_files=(
  "$HOME/.codex/auth.json"
  "$HOME/.claude/.credentials.json"
)
for credential_file in "${credential_files[@]}"; do
  if [[ -e "$credential_file" ]]; then
    echo "Reusable base contains provider credentials: $credential_file" >&2
    exit 1
  fi
done

chrome_output="$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --dump-dom \
  'data:text/html,<title>sprite-ready</title><p>ok</p>' 2>/dev/null)"
if [[ "$chrome_output" != *"<p>ok</p>"* ]]; then
  echo "Chrome headless smoke test failed." >&2
  exit 1
fi

printf '%-18s %s\n' \
  "Bun" "$(bun --version)" \
  "Node.js" "$(node --version)" \
  "Corepack" "$(corepack --version)" \
  "TypeScript" "$(tsc --version)" \
  "Python" "$(python3 --version)" \
  "Rust" "$(rustc --version)" \
  "wasm-bindgen" "$(wasm-bindgen --version)" \
  "wasm-pack" "$(wasm-pack --version)" \
  "wasm-opt" "$(wasm-opt --version | head -n 1)" \
  "Chrome" "$(google-chrome --version)" \
  "FFmpeg" "$(ffmpeg -version | head -n 1)" \
  "Codex" "$(codex --version)" \
  "Claude" "$(claude --version)" \
  "Muse" "$(muse --version)"

echo "Studio worker v1 verification passed."
