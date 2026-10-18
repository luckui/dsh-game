#!/usr/bin/env bash
# 开发测试用：保存 / 恢复 DDLC 的原始状态（游戏目录、characters/、persistent 存档、Ren'Py 的 .rpy 备份）。
#   bash tools/ddlc-snapshot.sh save      测试前
#   bash tools/ddlc-snapshot.sh restore   测试后（会先关掉 DDLC 进程）
#   bash tools/ddlc-snapshot.sh save act2 / restore act2   命名快照（分段测试：从第二幕开头接着测）
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${DSH_GAME_DDLC_DIR:-}" ] && [ -f .dev.env ]; then set -a; . ./.dev.env; set +a; fi
GAME="${DSH_GAME_DDLC_DIR:-/c/Program Files (x86)/Steam/steamapps/common/Doki Doki Literature Club}"
# 第二个参数是快照名（不填就是默认那份「测试前的干净状态」），比如 act2：分段测试用
SNAP=".dsh-home/ddlc-snapshot${2:+-$2}"
SAVE_DIR="$APPDATA/RenPy/DDLC-1454445547"

case "${1:-}" in
  save)
    rm -rf "$SNAP" && mkdir -p "$SNAP"
    cp -r "$GAME/characters" "$SNAP/characters"
    (cd "$GAME" && find . -type f | sort) > "$SNAP/files.txt"
    if [ -d "$SAVE_DIR" ]; then cp -r "$SAVE_DIR" "$SNAP/persistent"; fi
    echo "saved snapshot of $GAME"
    ;;
  restore)
    [ -d "$SNAP" ] || { echo "no snapshot"; exit 1; }
    taskkill //F //T //IM DDLC.exe >/dev/null 2>&1 || true
    sleep 1
    # 测试中新出现的文件（mod、配置、打码卡片、存档、日志、编译缓存）全部删掉
    (cd "$GAME" && find . -type f | sort) > "$SNAP/files-now.txt"
    comm -13 "$SNAP/files.txt" "$SNAP/files-now.txt" | while read -r f; do rm -f "$GAME/$f"; done
    find "$GAME/game" -type d -empty -delete 2>/dev/null || true
    [ -f "$GAME/game/firstrun" ] || : > "$GAME/game/firstrun"
    rm -rf "$GAME/characters" && cp -r "$SNAP/characters" "$GAME/characters"
    rm -rf "$SAVE_DIR"
    if [ -d "$SNAP/persistent" ]; then mkdir -p "$(dirname "$SAVE_DIR")" && cp -r "$SNAP/persistent" "$SAVE_DIR"; fi
    rm -f "$APPDATA/RenPy/backups/Doki Doki Literature Club/zz_dsh_game."* 2>/dev/null || true
    find "$APPDATA/RenPy" -type d -empty -delete 2>/dev/null || true
    echo "restored $GAME"
    ;;
  *) echo "usage: $0 save|restore"; exit 2 ;;
esac
