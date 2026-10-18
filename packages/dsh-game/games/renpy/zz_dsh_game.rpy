# dsh-game 的 Ren'Py 接入（由 dsh-game 插件安装；删掉这个文件和 dsh_game.json 就卸载了）
# https://github.com/ (待发布) — 兼容 Ren'Py 6/7（Python 2）和 Ren'Py 8（Python 3）
#
# 游戏 → 插件：台词、画面（show/scene）、label、需要回答的提示（选项 / 写诗选词 / 对话框 / 读诗）。
# 插件 → 游戏：回答、hold/release（她说话时停住自动前进）、截图、强制打码。
#
# 一行一个 JSON，走 127.0.0.1 TCP；mod 是客户端，连不上每 2 秒重试，没连上时游戏照常手动玩。
# 网络线程只收发字节，所有游戏状态只在主线程里动（periodic callback / afm callback / 交互里的 timer）。

init -5 python:
    import json as _hj
    import os as _hos
    import socket as _hsock
    import threading as _hthread
    import time as _htime
    import collections as _hcoll

    class _DshGameBridge(object):

        def __init__(self):
            self.port = None
            self.name = None
            self.afm_time = 6
            # 写诗小游戏所在的 label（DDLC 是 "poem"；别的游戏不配就没有这个钩子）
            self.poem_label = None
            # 「弹窗提示」的屏幕名（DDLC 是 dialog）和「展示诗」的屏幕名（DDLC 是 poem）
            self.dialog_screens = ["dialog"]
            # 是 / 否弹窗（DDLC：「解锁了特别诗，要读吗？」）
            self.confirm_screens = ["confirm"]
            self.poem_screen = None
            # 写诗挑词时，每个角色的分数在词对象的哪个属性上（{角色: 属性名}）
            self.poem_points = None
            # 插件自己的存档位（不配就不存档）
            self.resume_slot = None
            self.load_game = False
            # 画面推流用的端口（插件开的第二个端口）
            self.frame_port = None
            self.sock = None
            self.lock = _hthread.Lock()
            # deque 的 append / popleft 是线程安全的（DDLC 的精简 Python 里没有 Queue 模块）
            self.inbox = _hcoll.deque()
            self.connected = False
            self.was_connected = False
            # 当前等她回答的提示：{id, kind, itype, values}
            self.prompt = None
            self.answer = None
            self.seq = 0
            # 台词留底：每句编号，插件确认「交给她了」（ack）才删；插件重启后重新连上时，把没交过的整批补发（backlog）
            self.line_seq = 0
            self.backlog = _hcoll.deque(maxlen=800)
            self.held = False
            # 快进（导演模式）：用 Ren'Py 自带的跳过；停住或在等回答时暂停跳过
            self.fast = False
            self.censor = False
            self.label = None
            self.poem_buttons = None
            self.dev_jump = None
            self.start_game = False
            self.at_main_menu = None
            self.saved_prefs = None
            # 狂点前的（文字速度, 自动前进间隔）；狂点时自动前进间隔用多少（不能是 0：0 等于关掉自动前进）
            self.rush_prefs = None
            self.rush_afm_time = 0.05
            try:
                cfg_path = _hos.path.join(config.gamedir, "dsh_game.json")
                with open(cfg_path, "rb") as f:
                    cfg = _hj.loads(f.read())
                self.port = int(cfg.get("port", 0)) or None
                self.name = cfg.get("name")
                self.afm_time = cfg.get("afm_time", self.afm_time)
                self.poem_label = cfg.get("poem_label")
                self.dialog_screens = cfg.get("dialog_screens", self.dialog_screens)
                self.confirm_screens = cfg.get("confirm_screens", self.confirm_screens)
                self.poem_screen = cfg.get("poem_screen")
                self.poem_points = cfg.get("poem_points")
                self.resume_slot = cfg.get("resume_slot")
                self.frame_port = cfg.get("frame_port")
            except Exception:
                self.port = None

        # ── 网络线程 ─────────────────────────────────────────

        def start(self):
            if not self.port:
                return
            t = _hthread.Thread(target=self._loop)
            t.daemon = True
            t.start()

        def _loop(self):
            while True:
                try:
                    s = _hsock.create_connection(("127.0.0.1", self.port), 3)
                    s.settimeout(None)
                    with self.lock:
                        self.sock = s
                    self.inbox.append({"type": "_connected"})
                    # 按字节收（Python 3 的 recv 返回 bytes），整行再解码
                    buf = b""
                    while True:
                        chunk = s.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                        while b"\n" in buf:
                            raw, buf = buf.split(b"\n", 1)
                            line = raw.decode("utf-8")
                            if line.strip():
                                try:
                                    self.inbox.append(_hj.loads(line))
                                except Exception:
                                    pass
                except Exception:
                    pass
                with self.lock:
                    self.sock = None
                self.inbox.append({"type": "_disconnected"})
                _htime.sleep(2)

        def send(self, obj):
            try:
                data = _hj.dumps(obj) + "\n"
                if not isinstance(data, bytes):
                    data = data.encode("utf-8")
                with self.lock:
                    if self.sock is not None:
                        self.sock.sendall(data)
            except Exception:
                pass

        # ── 主线程 ───────────────────────────────────────────

        def pump(self):
            """处理收到的指令（只在主线程调用）"""
            while True:
                try:
                    msg = self.inbox.popleft()
                except IndexError:
                    return
                try:
                    self.handle(msg)
                except Exception as e:
                    self.send({"type": "error", "where": "handle", "message": repr(e)})

        def handle(self, msg):
            t = msg.get("type")
            if t == "_connected":
                self.connected = True
                self.was_connected = True
                self.take_prefs()
                self.send({
                    "type": "hello",
                    "renpy": renpy.version_only,
                    "playthrough": persistent.playthrough,
                    "playername": persistent.playername or "",
                    "label": self.label,
                    "mainMenu": bool(getattr(store, "main_menu", False)),
                    "resume": self.resume_info(),
                })
                # 断线前还没交给她的台词（插件重启时丢在它内存里的、断线期间演过的）整批补发
                if self.backlog:
                    self.send({"type": "backlog", "lines": [{"seq": n, "who": w, "what": t} for n, w, t in self.backlog]})
                # 断线前没回答的提示重新发一遍
                if self.prompt is not None:
                    self.send(self.prompt["event"])
            elif t == "_disconnected":
                if self.connected:
                    self.connected = False
                    self.held = False
                    self.fast = False
                    config.skipping = None
                    _dshgame_frames.fps = 0
                    self.set_rush(False)
                    self.restore_prefs()
            elif t == "hold":
                self.held = True
            elif t == "release":
                self.held = False
            elif t == "answer":
                p = self.prompt
                if p is not None and msg.get("id") == p["id"]:
                    i = msg.get("index")
                    if isinstance(i, int) and 0 <= i < len(p["values"]):
                        self.answer = p["values"][i]
            elif t == "name":
                value = (msg.get("value") or "").strip()[:12]
                if value and not persistent.playername:
                    persistent.playername = value
                    store.player = value
                    renpy.save_persistent()
            elif t == "afm":
                self.afm_time = msg.get("time", self.afm_time)
                if self.connected:
                    _preferences.afm_time = self.afm_time
            elif t == "shot":
                path = msg.get("path")
                ok = False
                try:
                    renpy.screenshot(path)
                    ok = True
                except Exception:
                    pass
                self.send({"type": "shot", "id": msg.get("id"), "path": path, "ok": ok})
            elif t == "ack":
                # 插件把这一句之前的都交给她了：留底可以删了
                done = msg.get("seq") or 0
                while self.backlog and self.backlog[0][0] <= done:
                    self.backlog.popleft()
            elif t == "stream":
                _dshgame_frames.start(msg.get("fps"))
            elif t == "rush":
                self.set_rush(bool(msg.get("on")))
            elif t == "skip":
                self.fast = bool(msg.get("on"))
                if self.fast:
                    _preferences.skip_unseen = True
                else:
                    config.skipping = None
            elif t == "censor":
                self.censor = bool(msg.get("on"))
                renpy.restart_interaction()
            elif t == "save":
                # 插件自己的存档位：每个时刻存一次，下次打开从这里继续
                ok = False
                if self.resume_slot and not getattr(store, "main_menu", False):
                    try:
                        renpy.save(self.resume_slot, extra_info="%s|%s" % (persistent.playthrough, self.label or ""))
                        ok = True
                    except Exception as e:
                        self.send({"type": "error", "where": "save", "message": repr(e)})
                self.send({"type": "saved", "ok": ok})
            elif t == "load":
                # 主菜单上读插件的存档，在下一次 periodic 里读
                self.load_game = True
            elif t == "start":
                # 主菜单上开新游戏（名字要先用 name 指令设好），在下一次 periodic 里跳
                self.start_game = True
            elif t == "dev_jump":
                self.dev_jump = msg.get("label")
            elif t == "dev_show":
                renpy.show(tuple(msg.get("name", "").split()))
                renpy.restart_interaction()

        def take_prefs(self):
            if self.saved_prefs is None:
                self.saved_prefs = (_preferences.afm_enable, _preferences.afm_time, _preferences.using_afm_enable)
            _preferences.using_afm_enable = False
            _preferences.afm_enable = True
            _preferences.afm_time = self.afm_time
            # 正在显示的这句是在自动前进关着时排的计时（停住时的 0.1 秒轮询断了）：重排一次才会接着走
            renpy.restart_interaction()

        def set_rush(self, on):
            """狂点：文字瞬间显示（text_cps 0）、自动前进间隔压到最短；关掉时恢复原来的设置"""
            if on and self.rush_prefs is None:
                self.rush_prefs = (_preferences.text_cps, _preferences.afm_time)
                _preferences.text_cps = 0
                _preferences.afm_time = self.rush_afm_time
                renpy.restart_interaction()
            elif not on and self.rush_prefs is not None:
                _preferences.text_cps, _preferences.afm_time = self.rush_prefs
                self.rush_prefs = None

        def restore_prefs(self):
            if self.saved_prefs is not None:
                _preferences.afm_enable, _preferences.afm_time, _preferences.using_afm_enable = self.saved_prefs
                self.saved_prefs = None

        # ── 提示（等她回答）───────────────────────────────────

        def ask(self, kind, itype, labels, values, extra=None):
            self.seq += 1
            pid = "%s-%d" % (kind, self.seq)
            event = {"type": "prompt", "id": pid, "kind": kind, "choices": labels}
            if extra:
                event.update(extra)
            self.prompt = {"id": pid, "kind": kind, "itype": itype, "values": values, "event": event}
            self.answer = None
            # 快进时 pause 会被直接跳过：有提示就立刻停下，不等下一次 periodic
            if self.fast:
                config.skipping = None
            self.send(event)
            return pid

        def say_line(self, who, what):
            """一句台词：编号、留底、发给插件"""
            self.line_seq += 1
            self.backlog.append((self.line_seq, who, what))
            self.send({"type": "say", "seq": self.line_seq, "who": who, "what": what})

        def resume_info(self):
            """插件的存档能不能读：存在、而且是在同一周目存的（DDLC 换幕时全局进度会变）"""
            slot = self.resume_slot
            if not slot or not renpy.can_load(slot):
                return None
            # 6.99 没有 renpy.slot_extra_info；存档的 extra_info 在 slot_json 的 _save_name 里
            try:
                extra = (renpy.slot_json(slot) or {}).get("_save_name") or ""
            except Exception as e:
                self.send({"type": "error", "where": "resume", "message": repr(e)})
                extra = ""
            parts = extra.split("|", 1)
            if len(parts) != 2 or parts[0] != str(persistent.playthrough):
                return None
            return {"label": parts[1]}

        def done(self, pid):
            if self.prompt is not None and self.prompt["id"] == pid:
                self.prompt = None
                self.answer = None

        def poll(self):
            """交互里的 timer 调：有答案就返回它，交互随之结束"""
            self.pump()
            if self.answer is not None:
                rv = self.answer
                self.answer = None
                return rv
            return None

    _dshgame = _DshGameBridge()

    # ── 画面推流（插件那边有人在看「游戏」标签时才开）──────────
    # 主线程按帧率抓一帧（约 8 毫秒）缩小，后台线程压 JPEG（不占主线程）、和上一帧一样就不发，
    # 用单独的连接发给插件：4 字节长度（大端）+ JPEG。
    # 抓帧用的是 Ren'Py 内部接口 renpy.display.draw.screenshot（6.99 实测可用），换 Ren'Py 版本时只需要改 grab()。

    class _DshFrameStream(object):
        SIZE = (960, 540)

        def __init__(self, port):
            self.port = port
            self.fps = 0
            self.due = 0.0
            self.pending = None
            self.cond = _hthread.Condition()
            # 抓帧失败时先歇一会儿再试（不永久放弃）；报错一分钟最多报一次
            self.retry_at = 0.0
            self.error_at = 0.0
            # 刚开始推流（有新观众）：下一帧不管和上一帧一不一样都发，不然游戏停着时新观众一直黑屏
            self.fresh = False
            try:
                import tempfile as _htmp
                folder = _htmp.gettempdir()
            except Exception:
                folder = config.gamedir
            self.path = _hos.path.join(folder, "dsh_game_frame_%d.jpg" % _hos.getpid())
            if port:
                t = _hthread.Thread(target=self._loop)
                t.daemon = True
                t.start()

        def grab(self):
            interface = renpy.game.interface
            surf = renpy.display.draw.screenshot(interface.surftree, getattr(interface, "fullscreen_video", False))
            return renpy.display.scale.smoothscale(surf, self.SIZE)

        def start(self, fps):
            """插件让推流（fps > 0）或停（0）"""
            self.fps = max(0, min(30, int(fps or 0)))
            if self.fps:
                self.fresh = True

        def tick(self):
            """periodic 里调：到时间了就抓一帧交给后台线程（后台还没压完上一帧就覆盖它）"""
            if not self.fps or renpy.display.draw is None:
                return
            # periodic 每 50 毫秒才调一次：按时间表累计（不是「距上一帧多久」），平均帧率才能到 fps
            now = _htime.time()
            if now < self.due or now < self.retry_at:
                return
            self.due = max(self.due + 1.0 / self.fps, now - 1.0 / self.fps)
            try:
                surf = self.grab()
            except Exception as e:
                self.retry_at = now + 3.0
                if now - self.error_at > 60.0:
                    self.error_at = now
                    _dshgame.send({"type": "error", "where": "frame", "message": repr(e)})
                return
            with self.cond:
                self.pending = surf
                self.cond.notify()

        def _loop(self):
            import pygame_sdl2 as _hpg
            import struct as _hstruct
            sock = None
            previous = None
            while True:
                with self.cond:
                    while self.pending is None:
                        self.cond.wait()
                    surf, self.pending = self.pending, None
                    if self.fresh:
                        self.fresh = False
                        previous = None
                try:
                    _hpg.image.save(surf, self.path)
                    with open(self.path, "rb") as f:
                        data = f.read()
                except Exception:
                    continue
                if data == previous:
                    continue
                try:
                    if sock is None:
                        sock = _hsock.create_connection(("127.0.0.1", self.port), 3)
                    sock.sendall(_hstruct.pack(">I", len(data)) + data)
                    previous = data
                except Exception:
                    try:
                        sock.close()
                    except Exception:
                        pass
                    sock = None
                    previous = None

    _dshgame_frames = _DshFrameStream(_dshgame.frame_port)

    class _DshGamePoll(Action):
        """不重启交互的轮询（Function 默认每次都 restart_interaction）"""
        def __call__(self):
            return _dshgame.poll()

    def _dshgame_text(s):
        try:
            return renpy.substitute(s)
        except Exception:
            return s

    # ── 自动前进：她说话时停住 ────────────────────────────

    def _dshgame_periodic():
        _dshgame.pump()
        _dshgame_frames.tick()
        at_menu = bool(getattr(store, "main_menu", False))
        if at_menu != _dshgame.at_main_menu:
            _dshgame.at_main_menu = at_menu
            _dshgame.send({"type": "main_menu", "on": at_menu})
        if _dshgame.load_game:
            _dshgame.load_game = False
            if at_menu and _dshgame.resume_info() is not None:
                renpy.load(_dshgame.resume_slot)
        if _dshgame.start_game:
            _dshgame.start_game = False
            if at_menu and persistent.playername and renpy.get_screen("name_input") is None:
                renpy.jump_out_of_context("start")
        if _dshgame.connected:
            # 快进：没停住、没在等回答、游戏允许跳过时就一直跳；DDLC 在部分段落会关掉跳过，这时自然停下
            want = _dshgame.fast and not _dshgame.held and _dshgame.prompt is None and config.allow_skipping
            if want and not config.skipping:
                config.skipping = True
            elif not want and config.skipping and _dshgame.fast:
                config.skipping = None
        if _dshgame.connected and _preferences.afm_enable is False and _dshgame.prompt is None:
            # DDLC 读诗时会关掉自动前进（poems.rpy showpoem），读完再打开
            _preferences.afm_enable = True
            renpy.restart_interaction()

    def _dshgame_afm():
        _dshgame.pump()
        if _dshgame.dev_jump:
            target, _dshgame.dev_jump = _dshgame.dev_jump, None
            renpy.jump(target)
        if not _dshgame.connected:
            return True
        return not _dshgame.held

    config.periodic_callbacks.append(_dshgame_periodic)
    config.afm_callback = _dshgame_afm

    # ── label：章节进度 ──────────────────────────────────

    def _dshgame_label(name, abnormal):
        if name.startswith("_"):
            return
        if name == "after_load":
            # 读档后 Ren'Py 走的系统段落：剧情位置是存档里记下的那个段落（store 变量跟着存档走）
            name = getattr(store, "dshgame_story_label", None)
            if not name:
                return
        store.dshgame_story_label = name
        _dshgame.label = name
        _dshgame.poem_buttons = [] if (_dshgame.poem_label and name == _dshgame.poem_label) else None
        _dshgame.send({"type": "label", "name": name, "playthrough": persistent.playthrough})

    config.label_callback = _dshgame_label

    # ── 台词 ────────────────────────────────────────────

    _dshgame_orig_say = renpy.character.ADVCharacter.__call__

    def _dshgame_say(self, what, *args, **kwargs):
        interact = args[0] if args else kwargs.get("interact", True)
        try:
            if interact and (self.condition is None or renpy.python.py_eval(self.condition)):
                who = self.name
                if self.dynamic and who:
                    who = renpy.python.py_eval(who)
                _dshgame.say_line(who or "", _dshgame_text(what))
        except Exception as e:
            _dshgame.send({"type": "error", "where": "say", "message": repr(e)})
        return _dshgame_orig_say(self, what, *args, **kwargs)

    renpy.character.ADVCharacter.__call__ = _dshgame_say

    # ── 画面：show / scene / hide ─────────────────────────

    _dshgame_orig_show = renpy.exports.show
    _dshgame_orig_scene = renpy.exports.scene
    _dshgame_orig_hide = renpy.exports.hide

    def _dshgame_layer(layer):
        return layer in (None, "master")

    def _dshgame_show(name, *args, **kwargs):
        try:
            if _dshgame_layer(kwargs.get("layer")) and not kwargs.get("transient"):
                parts = name if isinstance(name, tuple) else tuple(str(name).split())
                _dshgame.send({"type": "show", "name": " ".join(str(p) for p in parts), "tag": kwargs.get("tag")})
        except Exception:
            pass
        return _dshgame_orig_show(name, *args, **kwargs)

    def _dshgame_scene(*args, **kwargs):
        layer = args[0] if args else kwargs.get("layer", "master")
        if _dshgame_layer(layer):
            _dshgame.send({"type": "scene"})
        return _dshgame_orig_scene(*args, **kwargs)

    def _dshgame_hide(name, *args, **kwargs):
        try:
            layer = args[0] if args else kwargs.get("layer")
            if _dshgame_layer(layer):
                parts = name if isinstance(name, tuple) else tuple(str(name).split())
                _dshgame.send({"type": "hide", "name": " ".join(str(p) for p in parts)})
        except Exception:
            pass
        return _dshgame_orig_hide(name, *args, **kwargs)

    # show/scene/hide 语句走的是 config.show 等，Python 里的 renpy.show 走 exports
    renpy.exports.show = config.show = _dshgame_show
    renpy.exports.scene = config.scene = _dshgame_scene
    renpy.exports.hide = config.hide = _dshgame_hide

    # ── 选项 ────────────────────────────────────────────

    _dshgame_orig_display_menu = renpy.exports.display_menu

    def _dshgame_menu(items, *args, **kwargs):
        if kwargs.get("interact", True) is False:
            return _dshgame_orig_display_menu(items, *args, **kwargs)
        labels = [_dshgame_text(l) for l, v in items if v is not None and l]
        values = [v for l, v in items if v is not None and l]
        captions = [_dshgame_text(l) for l, v in items if v is None and l]
        pid = _dshgame.ask("menu", "menu", labels, values, {"caption": " ".join(captions)})
        try:
            return _dshgame_orig_display_menu(items, *args, **kwargs)
        finally:
            _dshgame.done(pid)

    renpy.exports.display_menu = _dshgame_menu
    store.menu = _dshgame_menu

    # ── 对话框（call screen dialog）和读诗（show screen poem）────

    _dshgame_orig_call_screen = renpy.exports.call_screen
    _dshgame_orig_show_screen = renpy.exports.show_screen

    def _dshgame_confirm_values(args, kwargs):
        """是 / 否弹窗（screen confirm(message, yes_action, no_action)）两个按钮的返回值；按钮不是 Return 就不接管"""
        yes = kwargs.get("yes_action", args[1] if len(args) > 1 else None)
        no = kwargs.get("no_action", args[2] if len(args) > 2 else None)
        if isinstance(yes, Return) and isinstance(no, Return):
            return [yes.value, no.value]
        return None

    # 她在弹窗上点了 OK（轮询屏幕返回它；弹窗按钮本来的动作随后照做）
    _DSHGAME_OK = "__dsh_game_ok__"

    def _dshgame_call_screen(_screen_name, *args, **kwargs):
        message = kwargs.get("message", args[0] if args else "")
        ok = None
        if _screen_name in _dshgame.dialog_screens:
            ok = kwargs.get("ok_action", args[1] if len(args) > 1 else None)
            pid = _dshgame.ask("dialog", "screen", ["OK"], [_DSHGAME_OK], {"message": _dshgame_text(message)})
        elif _screen_name in _dshgame.confirm_screens and _dshgame_confirm_values(args, kwargs) is not None:
            pid = _dshgame.ask("dialog", "screen", ["Yes", "No"], _dshgame_confirm_values(args, kwargs), {"message": _dshgame_text(message)})
        else:
            return _dshgame_orig_call_screen(_screen_name, *args, **kwargs)
        try:
            rv = _dshgame_orig_call_screen(_screen_name, *args, **kwargs)
        finally:
            _dshgame.done(pid)
        if rv != _DSHGAME_OK:
            return rv
        # 照 OK 按钮本来的动作做：Return 就返回它的值；别的（比如 DDLC 片尾后报错弹窗的 Quit）就执行它
        if ok is None:
            return True
        if isinstance(ok, Return):
            return ok.value
        return renpy.run(ok)

    def _dshgame_show_screen(_screen_name, *args, **kwargs):
        rv = _dshgame_orig_show_screen(_screen_name, *args, **kwargs)
        if _dshgame.poem_screen and _screen_name == _dshgame.poem_screen:
            poem = kwargs.get("currentpoem", args[0] if args else None)
            if poem is not None:
                _dshgame.ask("poem_read", "pause", ["OK"], [True], {
                    "author": getattr(poem, "author", ""),
                    "title": _dshgame_text(getattr(poem, "title", "") or ""),
                    "text": _dshgame_text(getattr(poem, "text", "") or ""),
                })
        return rv

    renpy.exports.call_screen = _dshgame_call_screen
    renpy.exports.show_screen = _dshgame_show_screen

    # ── 写诗小游戏：记下这一轮的 10 个词按钮 ───────────────

    _dshgame_orig_textbutton = renpy.ui.textbutton
    _dshgame_orig_interact = renpy.ui.interact

    def _dshgame_textbutton(label, *args, **kwargs):
        if _dshgame.poem_buttons is not None:
            _dshgame.poem_buttons.append((label, kwargs.get("clicked")))
        return _dshgame_orig_textbutton(label, *args, **kwargs)

    def _dshgame_interact(*args, **kwargs):
        itype = kwargs.get("type", args[0] if args else "misc")
        pid = None
        if _dshgame.poem_buttons and itype == "misc":
            words = [l for l, c in _dshgame.poem_buttons]
            values = [c() if callable(c) else c for l, c in _dshgame.poem_buttons]
            progress = getattr(store, "progress", 0)
            extra = {"progress": progress, "total": getattr(store, "numWords", 20)}
            if _dshgame.poem_points:
                # 每个词给每个角色加多少分（DDLC 的 PoemWord.sPoint / nPoint / yPoint）
                extra["points"] = [
                    dict((who, getattr(v, attr, 0) or 0) for who, attr in _dshgame.poem_points.items())
                    for v in values
                ]
            pid = _dshgame.ask("poem_word", "misc", words, values, extra)
        # 等她回答的交互里放一个轮询屏幕：答案到了，交互返回它。
        # 放在最上层的屏幕里，因为 DDLC 的对话框是 modal，会挡住下面图层的 timer
        p = _dshgame.prompt
        if p is not None and p["itype"] == itype:
            _dshgame_orig_show_screen("dsh_game_poll", _transient=True)
        try:
            return _dshgame_orig_interact(*args, **kwargs)
        finally:
            if pid is not None:
                _dshgame.done(pid)
            if _dshgame.poem_buttons is not None:
                _dshgame.poem_buttons = []
            if p is not None and p["kind"] == "poem_read" and itype == "pause":
                _dshgame.done(p["id"])

    renpy.ui.textbutton = _dshgame_textbutton
    renpy.ui.interact = _dshgame_interact

    # ── 主播手动强制打码（兜底名单漏掉的画面）──────────────

    config.overlay_screens.append("dsh_game_censor")

    _dshgame.start()

screen dsh_game_censor():
    zorder 1000
    if _dshgame.censor:
        add "dsh_game/censor_card.png"

screen dsh_game_poll():
    zorder 1001
    timer 0.2 repeat True action _DshGamePoll()
