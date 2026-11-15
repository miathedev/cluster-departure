import pathlib
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from kubernetes import client, config

app = FastAPI(title="cluster-departure")

STATIC_DIR = pathlib.Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


try:
    config.load_kube_config()
except config.ConfigException:
    config.load_incluster_config()

core = client.CoreV1Api()
custom = client.CustomObjectsApi()


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def node_metrics() -> list[dict]:
    raw = custom.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
    return [
        {
            "name": i["metadata"]["name"],
            "cpu": i["usage"]["cpu"],
            "memory": i["usage"]["memory"],
        }
        for i in raw["items"]
    ]


def pod_metrics() -> list[dict]:
    raw = custom.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")
    return [
        {
            "namespace": i["metadata"]["namespace"],
            "name": i["metadata"]["name"],
            "containers": [
                {"cpu": c["usage"]["cpu"], "memory": c["usage"]["memory"]}
                for c in i["containers"]
            ],
        }
        for i in raw["items"]
    ]


def cpu_to_nano(s: str) -> int:
    """Parse a k8s CPU quantity ('296384584n', '250m', '2') to nanocores."""
    if s.endswith("n"):
        return int(s[:-1])
    if s.endswith("u"):
        return int(s[:-1]) * 1_000
    if s.endswith("m"):
        return int(s[:-1]) * 1_000_000
    return int(float(s) * 1_000_000_000)


def mem_to_bytes(s: str) -> int:
    """Parse a k8s memory quantity ('6408628Ki', '1Gi', '512Mi') to bytes."""
    for suffix, mult in (("Ki", 1024), ("Mi", 1024**2), ("Gi", 1024**3),
                         ("K", 1000), ("M", 1000**2), ("G", 1000**3)):
        if s.endswith(suffix):
            return int(s[: -len(suffix)]) * mult
    return int(s)


def pod_info(p, metrics_map: dict) -> dict:
    phase = p.status.phase or "Unknown"
    reason = p.status.reason
    for cs in p.status.container_statuses or []:
        if cs.state and cs.state.waiting:
            reason = reason or cs.state.waiting.reason
    deleting = p.metadata.deletion_timestamp is not None
    if phase in ("Succeeded", "Failed") or deleting:
        state = "leaving"
    elif phase == "Pending":
        state = "entering"
    else:
        state = "running"
    usage = metrics_map.get((p.metadata.namespace, p.metadata.name), {})
    return {
        "uid": p.metadata.uid,
        "name": p.metadata.name,
        "phase": phase,
        "reason": reason,
        "state": state,
        "cpu_nano": usage.get("cpu_nano"),
        "mem_bytes": usage.get("mem_bytes"),
    }


@app.get("/api/state")
def api_state():
    """Deployment-driven yard state: one track per replica, pods mapped by age."""
    apps = client.AppsV1Api()
    metrics_map: dict[tuple[str, str], dict] = {}
    for pm in pod_metrics():
        metrics_map[(pm["namespace"], pm["name"])] = {
            "cpu_nano": sum(cpu_to_nano(c["cpu"]) for c in pm["containers"]),
            "mem_bytes": sum(mem_to_bytes(c["memory"]) for c in pm["containers"]),
        }

    stations = []
    for d in sorted(
        apps.list_deployment_for_all_namespaces().items,
        key=lambda d: (d.metadata.namespace, d.metadata.name),
    ):
        ns = d.metadata.namespace
        sel = d.spec.selector.match_labels or {}
        label_selector = ",".join(f"{k}={v}" for k, v in sel.items())
        pods = core.list_namespaced_pod(ns, label_selector=label_selector).items
        pods.sort(key=lambda p: p.metadata.creation_timestamp
                 or datetime.min.replace(tzinfo=timezone.utc))
        replicas = d.spec.replicas or 0
        tracks = []
        for i in range(max(replicas, len(pods))):
            pod = pods[i] if i < len(pods) else None
            tracks.append({"index": i, "pod": pod_info(pod, metrics_map) if pod else None})
        stations.append({"uid": d.metadata.uid, "namespace": ns, "name": d.metadata.name,
                         "tracks": tracks})

    running = sum(1 for s in stations for t in s["tracks"]
                  if t["pod"] and t["pod"]["state"] == "running")
    log(f"yard state: {len(stations)} deployments, {running} running pods")
    return {
        "time": datetime.now(timezone.utc).isoformat(),
        "nodes": node_metrics(),
        "stations": stations,
    }
