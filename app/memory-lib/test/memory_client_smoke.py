# memory-lib python SDK smoke test —— 连生产 8787 验证。
# 运行：python test/memory_client_smoke.py
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk"))
from memory_client import MemoryClient

mem = MemoryClient(
    url="http://127.0.0.1:8787",
    credential_ref="memory-lib/deepseek-harness",
    secret="<rotated-2026-09-21; secret lives in Windows Credential Manager (target: memory-lib_deepseek-harness)>",
    agent="pilot-01",
    role="steward",  # steward 有 project:* 通配，能读项目档案
)

h = mem.health()
print("health:", h["health"])

r = mem.search("memory", limit=3)
print("search count:", r.get("count"))

g = mem.graph_stats()
print("graph nodes:", g["graph"]["nodes"], "edges:", g["graph"]["edges"])

item = mem.get("mem_memory_lib_state")
print("get:", "OK" if item.get("item") else "not found")

print("PYTHON_SDK_SMOKE_OK")
