#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible baseline for Company OS studio workers. This installs tools
# only; provider and service credentials are provisioned after cloning.

BUN_VERSION="${BUN_VERSION:-1.4.2}"
NODE_VERSION="${NODE_VERSION:-24.18.0}"
TYPESCRIPT_VERSION="${TYPESCRIPT_VERSION:-7.0.2}"
UPDATE_AGENT_CLIENTS="${UPDATE_AGENT_CLIENTS:-0}"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

if [[ "$(uname -s)" != "Linux" ]] || ! command -v apt-get >/dev/null; then
  echo "This baseline currently supports Ubuntu/Debian Sprites only." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  sudo -n true
  SUDO=(sudo)
fi

echo "Installing native development and browser tooling..."
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y --no-install-recommends \
  binaryen \
  build-essential \
  ca-certificates \
  clang \
  cmake \
  curl \
  ffmpeg \
  git \
  git-lfs \
  imagemagick \
  jq \
  libvulkan1 \
  lld \
  mesa-utils \
  mesa-vulkan-drivers \
  netcat-openbsd \
  ninja-build \
  openssl \
  pkg-config \
  python3 \
  python3-pip \
  python3-venv \
  ripgrep \
  socat \
  sqlite3 \
  unzip \
  vulkan-tools \
  wget \
  xauth \
  xvfb \
  xz-utils \
  zip \
  zstd

mkdir -p "$HOME/.local/bin" "$HOME/.local/lib" "$HOME/.config/company-os"
git lfs install --skip-repo

install_node() {
  local machine node_arch archive base temp_dir install_dir
  machine="$(uname -m)"
  case "$machine" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) echo "Unsupported Node.js architecture: $machine" >&2; return 1 ;;
  esac
  archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  temp_dir="$(mktemp -d)"
  install_dir="$HOME/.local/lib/node-v${NODE_VERSION}"
  curl -fsSLo "$temp_dir/$archive" "$base/$archive"
  curl -fsSLo "$temp_dir/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (
    cd "$temp_dir"
    grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict
  )
  rm -rf "$install_dir"
  mkdir -p "$install_dir"
  tar -xJf "$temp_dir/$archive" --strip-components=1 -C "$install_dir"
  rm -rf "$temp_dir"
  for command_name in node npm npx corepack; do
    if [[ -x "$install_dir/bin/$command_name" ]]; then
      ln -sfn "$install_dir/bin/$command_name" "$HOME/.local/bin/$command_name"
    fi
  done
}

node_major=""
if command -v node >/dev/null; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [[ "$node_major" != "${NODE_VERSION%%.*}" ]]; then
  echo "Installing Node.js $NODE_VERSION..."
  install_node
fi

if ! command -v corepack >/dev/null; then
  npm install --global --prefix "$HOME/.local" corepack@0.35.0
fi
corepack enable --install-directory "$HOME/.local/bin"
npm install --global --prefix "$HOME/.local" "typescript@$TYPESCRIPT_VERSION"

current_bun="$(bun --version 2>/dev/null || true)"
if [[ "$current_bun" != "$BUN_VERSION" ]]; then
  echo "Installing Bun $BUN_VERSION..."
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  ln -sfn "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"
fi

if ! command -v rustup >/dev/null; then
  echo "Installing Rustup..."
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
fi

rustup toolchain install stable --profile minimal
rustup default stable
rustup target add wasm32-unknown-unknown

install_cargo_tool() {
  local command_name="$1"
  local crate_name="$2"
  if ! command -v "$command_name" >/dev/null; then
    echo "Installing $crate_name..."
    cargo install "$crate_name" --locked --root "$HOME/.local"
  fi
}

install_cargo_tool wasm-bindgen wasm-bindgen-cli
install_cargo_tool wasm-pack wasm-pack
install_cargo_tool websocat websocat

if ! command -v google-chrome >/dev/null; then
  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "The Chrome installer is currently configured for x86_64 Sprites." >&2
    exit 1
  fi
  echo "Installing Google Chrome Stable..."
  chrome_deb="$(mktemp --suffix=.deb)"
  curl -fsSLo "$chrome_deb" \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  "${SUDO[@]}" apt-get install -y "$chrome_deb"
  rm -f "$chrome_deb"
fi

install_agent() {
  local command_name="$1"
  shift
  if [[ "$UPDATE_AGENT_CLIENTS" == "1" ]] || ! command -v "$command_name" >/dev/null; then
    "$@"
  fi
}

install_agent codex bash -lc \
  'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'
install_agent claude bash -lc \
  'curl -fsSL https://claude.ai/install.sh | bash -s stable'
install_agent muse bash -lc \
  'curl -fsSL https://dev.meta.ai/install.sh | sh'

cat >"$HOME/.config/company-os/sprite-toolchain-v1.txt" <<EOF
schema=company-os-studio-worker-v1
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
bun=$(bun --version)
node=$(node --version)
typescript=$(tsc --version)
python=$(python3 --version 2>&1)
rust=$(rustc --version)
chrome=$(google-chrome --version)
codex=$(codex --version)
claude=$(claude --version)
muse=$(muse --version)
EOF

echo
echo "Studio worker v1 provisioning complete."
echo "No provider login or API credential was configured by this script."
cat "$HOME/.config/company-os/sprite-toolchain-v1.txt"
