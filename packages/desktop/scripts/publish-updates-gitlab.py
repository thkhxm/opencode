from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[3]
DIST = ROOT / "packages" / "desktop" / "dist"
ARTIFACT_PATTERNS = ("*.exe", "*.dmg", "*.zip", "*.blockmap", "latest*.yml")


def fail(message: str) -> None:
    print(f"错误: {message}", file=sys.stderr)
    raise SystemExit(1)


def env(name: str, required: bool = True, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    if required:
        fail(f"缺少 CI 变量 {name}")
    return default


def channel() -> str:
    raw = os.environ.get("PUNKCODE_CHANNEL") or os.environ.get("OPENCODE_CHANNEL") or "prod"
    if raw in {"prod", "beta", "dev"}:
        return raw
    return "prod"


def channel_join(base: str, current: str) -> str:
    base = base.rstrip("/")
    if current == "prod":
        return base
    return f"{base}/{current}"


def yaml_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_manifest(path: Path) -> tuple[str, list[dict[str, str]]]:
    version = ""
    files: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("version:"):
            version = yaml_value(stripped.split(":", 1)[1])
            continue
        if stripped.startswith("- url:"):
            current = {"url": yaml_value(stripped.split(":", 1)[1])}
            files.append(current)
            continue
        if current is None:
            continue
        if stripped.startswith("sha512:"):
            current["sha512"] = yaml_value(stripped.split(":", 1)[1])
        if stripped.startswith("size:"):
            current["size"] = yaml_value(stripped.split(":", 1)[1])

    if not version:
        fail(f"{path.name} 缺少 version")
    if not files:
        fail(f"{path.name} 缺少 files")
    return version, files


def sha512_base64(path: Path) -> str:
    h = hashlib.sha512()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode("ascii")


def collect_artifacts() -> list[Path]:
    if not DIST.exists():
        fail(f"产物目录不存在: {DIST}")

    files: list[Path] = []
    seen: set[Path] = set()
    for pattern in ARTIFACT_PATTERNS:
        for item in sorted(DIST.glob(pattern)):
            if not item.is_file() or item in seen:
                continue
            seen.add(item)
            files.append(item)

    names = {item.name for item in files}
    manifests = [item for item in files if item.name in {"latest.yml", "latest-mac.yml", "latest-linux.yml"}]
    if "latest.yml" not in names:
        fail("缺少 Windows latest.yml")
    if "latest-mac.yml" not in names:
        fail("缺少 macOS latest-mac.yml")

    versions: dict[str, str] = {}
    for manifest in manifests:
        version, entries = parse_manifest(manifest)
        versions[manifest.name] = version
        for entry in entries:
            url = entry.get("url")
            if not url:
                fail(f"{manifest.name} 存在缺少 url 的文件项")
            target = DIST / Path(url).name
            if not target.exists():
                fail(f"{manifest.name} 引用的文件不存在: {url}")
            expected_size = entry.get("size")
            if expected_size and target.stat().st_size != int(expected_size):
                fail(f"{target.name} size 与 {manifest.name} 不一致")
            expected_sha = entry.get("sha512")
            if expected_sha and sha512_base64(target) != expected_sha:
                fail(f"{target.name} sha512 与 {manifest.name} 不一致")

    print("待发布版本:")
    for name, version in versions.items():
        print(f"  {name}: {version}")
    print("待上传文件:")
    for item in files:
        print(f"  {item.name} ({item.stat().st_size} bytes)")
    return files


def run(cmd: list[str], stdin: str | None = None) -> None:
    printable = " ".join(shlex.quote(part) for part in cmd)
    print(f"+ {printable}")
    subprocess.run(cmd, input=stdin, text=True, check=True)


def ssh_options(host: str, key_file: str | None, known_hosts: str | None) -> tuple[list[str], tempfile.TemporaryDirectory[str] | None]:
    temp_dir = tempfile.TemporaryDirectory()
    ssh_dir = Path(temp_dir.name)
    options = ["-o", "BatchMode=yes"]

    if key_file:
        options.extend(["-i", key_file])

    if known_hosts:
        known_hosts_file = ssh_dir / "known_hosts"
        known_hosts_file.write_text(known_hosts.rstrip() + "\n", encoding="utf-8")
        options.extend(["-o", f"UserKnownHostsFile={known_hosts_file}", "-o", "StrictHostKeyChecking=yes"])
    else:
        options.extend(["-o", "StrictHostKeyChecking=accept-new"])

    return options, temp_dir


def publish(files: list[Path]) -> str:
    current = channel()
    host = env("PUNKCODE_UPDATE_HOST")
    user = env("PUNKCODE_UPDATE_USER")
    remote_dir = channel_join(env("PUNKCODE_UPDATE_REMOTE_DIR"), current)
    public_url = channel_join(env("PUNKCODE_UPDATE_PUBLIC_URL", required=False, default="https://punkcodeai.myverse.site/updates"), current)
    private_key = env("PUNKCODE_UPDATE_SSH_PRIVATE_KEY", required=False)
    host_key = env("PUNKCODE_UPDATE_SSH_HOST_KEY", required=False)

    if not host or not user or not remote_dir or not public_url:
        fail("更新服务器配置不完整")

    with tempfile.TemporaryDirectory() as local_temp:
        key_path: str | None = None
        if private_key:
            key = Path(local_temp) / "update_ssh_key"
            key.write_text(private_key.replace("\r\n", "\n").rstrip() + "\n", encoding="utf-8")
            key.chmod(0o600)
            key_path = str(key)

        ssh_opts, ssh_temp = ssh_options(host, key_path, host_key)
        try:
            remote = f"{user}@{host}"
            tag = os.environ.get("CI_COMMIT_TAG") or os.environ.get("CI_COMMIT_SHORT_SHA") or str(int(time.time()))
            slug = re.sub(r"[^A-Za-z0-9_.-]", "-", tag)
            remote_tmp = f"/tmp/punkcodeai-updates-{slug}-{int(time.time())}"

            run(["ssh", *ssh_opts, remote, f"rm -rf {shlex.quote(remote_tmp)} && mkdir -p {shlex.quote(remote_tmp)}"])
            run(["scp", *ssh_opts, *[str(item) for item in files], f"{remote}:{remote_tmp}/"])

            manifest = "\n".join(f"{item.name}\t{item.stat().st_size}" for item in files)
            remote_script = f"""
set -eu
tmp={shlex.quote(remote_tmp)}
remote_dir={shlex.quote(remote_dir)}
mkdir -p "$remote_dir"
cd "$tmp"
while IFS='	' read -r file size; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || {{ echo "missing $file" >&2; exit 1; }}
  actual=$(wc -c < "$file" | tr -d ' ')
  [ "$actual" = "$size" ] || {{ echo "size mismatch $file: $actual != $size" >&2; exit 1; }}
done <<'EOF'
{manifest}
EOF
for file in *; do
  case "$file" in
    latest*.yml) ;;
    *) cp -f "$file" "$remote_dir/$file"; chmod 0644 "$remote_dir/$file" ;;
  esac
done
for file in latest*.yml; do
  [ -e "$file" ] || continue
  cp -f "$file" "$remote_dir/$file"
  chmod 0644 "$remote_dir/$file"
done
rm -rf "$tmp"
"""
            run(["ssh", *ssh_opts, remote, "sh -s"], stdin=remote_script)
        finally:
            if ssh_temp:
                ssh_temp.cleanup()

    return public_url


def verify_public(public_url: str) -> None:
    for manifest in ("latest.yml", "latest-mac.yml"):
        local = DIST / manifest
        if not local.exists():
            continue
        version, _ = parse_manifest(local)
        url = f"{public_url.rstrip('/')}/{manifest}?t={int(time.time())}"
        print(f"验证 {url}")
        with urlopen(url, timeout=20) as response:
            text = response.read().decode("utf-8")
        if f"version: {version}" not in text and f"version: '{version}'" not in text and f'version: "{version}"' not in text:
            fail(f"{manifest} 公开地址版本不匹配，期望 {version}")


def main() -> None:
    files = collect_artifacts()
    public_url = publish(files)
    verify_public(public_url)
    print("发布完成")


if __name__ == "__main__":
    main()
