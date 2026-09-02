---
description: "Python: never swallow exceptions with an empty except body (except: pass / except Exception: ...) — handle, log, re-raise, or use contextlib.suppress explicitly"
condition: '(?m)^[ \t]*except\b[^:\n]{0,120}:\s*(?:#[^\n]{0,120}\s*){0,10}(?:pass\b|\.\.\.)'
astCondition:
  - "try:\n  $$$BODY\nexcept:\n  pass"
  - "try:\n  $$$BODY\nexcept:\n  ..."
  - "try:\n  $$$BODY\nexcept $E:\n  pass"
  - "try:\n  $$$BODY\nexcept $E:\n  ..."
  - "try:\n  $$$BODY\nexcept* $E:\n  pass"
  - "try:\n  $$$BODY\nexcept* $E:\n  ..."
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

## 不要吞掉 Python 异常

`except` 块里只有一句 `pass`（或 `...`）会把错误悄无声息地吃掉：异常和栈信息丢失，故障推迟到下游某个无关的位置才爆发，届时无人能追溯根因。裸 `except:` 更糟——它连 `KeyboardInterrupt` 和 `SystemExit` 都一并拦截。

### Avoid

```python
try:
    cfg = json.loads(raw)
except:
    pass
```

```python
try:
    os.remove(tmp_path)
except Exception:
    pass
```

### Use

```python
try:
    cfg = json.loads(raw)
except json.JSONDecodeError as e:
    raise ValueError(f"unparseable config: {raw!r}") from e
```

捕获最具体的异常类型，然后三选一：真正处理（有明确语义的回退值、写日志）、用 `raise ... from e` 换型重抛、或在确属"没发生更好"的场景改用显式抑制：

```python
with contextlib.suppress(FileNotFoundError):
    os.remove(tmp_path)
```

### When this is actually fine

- 尽力而为的清理（关闭句柄、删临时文件、上报指标）失败可容忍时：仍然要捕获具体异常类型，并加一行注释说明为什么可以安全忽略；不要写裸 `except`。
- `except` 块里除了 `pass` 还有真正的处理语句时，异常依然被无视了——删掉那行多余的 `pass`，并按上面的方式处理或显式抑制。
- 本提醒命中的是 docstring、字符串或注释里恰好出现的 `except: pass` 字样（而不是真正写出的代码结构）时，属于误报，忽略即可。
