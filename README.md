# cluster-departure

Every Deployment is a station, every replica a track, and every pod a
train. Hopefully your deployments dont get stuck as the Deutsche Bahn.

## Run it

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open http://localhost:8000 and enjoy the departure board.

Needs a kubeconfig (or an in-cluster config) and `metrics-server` running -
that's where the live CPU/memory numbers come from.
