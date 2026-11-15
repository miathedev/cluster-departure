// --- layout constants -------------------------------------------------------
// The whole yard is drawn at a fixed design width and then scaled to fit the
// window (see fit()), so every position below is in "design pixels".

const SCALE = 5; // sprite scale: one train block is 48px * SCALE
const CAR_W = 48 * SCALE; // one complete wagon, 3 blocks like the loco
const LOCO_W = 48 * SCALE; // the locomotive
const TRAIN_W = CAR_W + LOCO_W;
const PARK_X = 60; // x position where a stationed train sits
const MOVE_MS = 1600; // duration of the roll-in / roll-off animation

// --- DOM handles --------------------------------------------------------------
// Grab the handful of elements we touch over and over, once, up front.

const stationsEl = document.getElementById("stations");
const nodeBox = document.getElementById("nodebox");
const connEl = document.getElementById("conn");
const emptyEl = document.getElementById("empty");
const nsSelect = document.getElementById("ns");

// --- state --------------------------------------------------------------------

const trains = new Map(); // pod uid -> { uid, el, label, state, gone }
// the live DOM train for each pod we know about
const stationEls = new Map(); // deployment uid -> { el, lanesBox, lanes: [] }
const seen = new Set(); // pod uids present in the latest poll (for cleanup)
let nsFilter = ""; // selected namespace ("" = all)
let nsInit = false; // auto-select first namespace on first data
let lastData = null; // last payload, re-rendered when the filter changes

// re-render with the newly selected namespace
nsSelect.addEventListener("change", () => {
  nsFilter = nsSelect.value;
  if (lastData) render(lastData);
});

const DESIGN_W = 1100; // fixed design width the yard is laid out at
const MAX_SCALE = 3; // never blow the yard up larger than this

// scale the whole yard to fit the browser window and center it
function fit() {
  const header = document.querySelector("header");
  // reset to scale(1) first so offsetWidth/offsetHeight measure the real
  // content instead of the previously applied transform
  stationsEl.style.transform = "scale(1)";
  stationsEl.style.width = DESIGN_W + "px";
  const availW = window.innerWidth;
  const availH = window.innerHeight - header.offsetHeight;
  const s = Math.min(
    availW / stationsEl.offsetWidth,
    availH / stationsEl.offsetHeight,
    MAX_SCALE,
  );
  stationsEl.style.transform = `scale(${s})`;
  stationsEl.style.marginLeft =
    Math.max(0, (availW - stationsEl.offsetWidth * s) / 2) + "px";
  stationsEl.style.marginTop =
    Math.max(0, (availH - stationsEl.offsetHeight * s) / 2) + "px";
}
window.addEventListener("resize", fit);

// --- k8s quantity formatting ---------------------------------------------------
// The API hands us raw k8s quantities as strings ("296384584n", "512Mi"), so we
// parse those to numbers and then format them back for humans.

// nanocores -> "1.50 cores" or "250m"
function fmtCpu(nano) {
  if (nano == null) return "";
  if (nano >= 1e9) return (nano / 1e9).toFixed(2) + " cores";
  return Math.round(nano / 1e6) + "m";
}

// bytes -> "1.5Gi" or "512Mi"
function fmtMem(bytes) {
  if (bytes == null) return "";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + "Gi";
  return Math.round(bytes / 1024 ** 2) + "Mi";
}

// parse a k8s CPU quantity ("250m", "296384584n", "2") to nanocores
function cpuNano(s) {
  if (s.endsWith("n")) return +s.slice(0, -1);
  if (s.endsWith("u")) return +s.slice(0, -1) * 1e3;
  if (s.endsWith("m")) return +s.slice(0, -1) * 1e6;
  return +s * 1e9;
}

// parse a k8s memory quantity ("512Mi", "1Gi") to bytes
function memBytes(s) {
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };
  for (const [suffix, m] of Object.entries(mult)) {
    if (s.endsWith(suffix)) return +s.slice(0, -suffix.length) * m;
  }
  return +s;
}

// --- element builders -----------------------------------------------------------

// build an img sprite element
function makeImg(src, cls) {
  const img = document.createElement("img");
  img.src = src;
  img.className = cls;
  img.draggable = false; // keep the browser from offering a drag ghost
  return img;
}

// build the train element: wagon + loco sprites with the pod name as label
function makeTrainEl(podName) {
  const inner = document.createElement("div");
  inner.className = "train-inner";
  inner.appendChild(makeImg("/static/sprites/car.png", "car"));
  inner.appendChild(makeImg("/static/sprites/loco.png", "loco"));

  // outer wrapper: this is the element we translate along the lane
  const el = document.createElement("div");
  el.className = "train";
  el.appendChild(inner);

  // the pod name label that rides on the train
  const label = document.createElement("span");
  label.className = "podlabel";
  label.textContent = podName; // the pod name rides on the train itself
  el.appendChild(label);
  return { el, label };
}

// --- movement -------------------------------------------------------------------

// move an element to x px, animated or instant
function setX(el, x, animate) {
  // setting the transition and the transform in the same frame can skip the
  // animation, which is why callers force a reflow between the two (see below)
  el.style.transition = animate
    ? `transform ${MOVE_MS}ms cubic-bezier(0.22,1,0.36,1)`
    : "none";
  el.style.transform = `translateX(${x}px)`;
}

// live pixel width of a lane (800 fallback before first layout)
function laneWidth(lane) {
  return lane.clientWidth || 800;
}

// animate a train into a lifecycle state; "leaving" rolls it off-screen, then removes it
function applyState(t, lane, state) {
  // remember the state so renderTrack can detect changes between polls
  t.state = state;
  t.label.className = `podlabel ${state}`; // colors the label per state (see style.css)
  if (state !== "leaving") {
    setX(t.el, PARK_X, true); // entering/running: roll to the platform and stay
    return;
  }

  // leaving: aim just past the right edge of the lane so the train fully exits
  setX(t.el, laneWidth(lane) + 80, true);
  if (t.gone) return; // guard: we may get "leaving" several polls in a row,
  t.gone = true; // but the removal timer must only be scheduled once

  // once the roll-off has finished, drop the element and forget the train
  setTimeout(() => {
    t.el.remove();
    trains.delete(t.uid);
  }, MOVE_MS + 300); // wait for the roll-off to finish before cleanup
}

// --- stations and lanes -----------------------------------------------------------
// Stations (deployments) and lanes (replica tracks) are created lazily as the
// API reports them, and reused across polls.

// get or create the station section for a deployment
function ensureStation(st) {
  // look up the station built for this deployment in an earlier poll
  let entry = stationEls.get(st.uid);
  if (!entry) {
    // first time we see this deployment: create its station section
    const el = document.createElement("section");
    el.className = "station";

    // the box that holds this station's lanes (tracks)
    const lanesBox = document.createElement("div");
    el.appendChild(lanesBox);
    stationsEl.appendChild(el);
    entry = { el, lanesBox, lanes: [] };
    stationEls.set(st.uid, entry);
  }
  return entry;
}

// get or create lane number i inside a station
function ensureLane(entry, i) {
  while (entry.lanes.length <= i) {
    // grow the station by one lane (one replica track)
    const lane = document.createElement("div");
    lane.className = "lane inactive"; // starts inactive until a pod sits on it

    // the decorative rails inside the lane
    const rails = document.createElement("div");
    rails.className = "rails";
    lane.appendChild(rails);
    entry.lanesBox.appendChild(lane);
    entry.lanes.push(lane);
  }
  return entry.lanes[i];
}

// --- per-pod rendering ------------------------------------------------------------

// tooltip text for a pod: phase, waiting reason, and live usage
function podTooltip(pod) {
  // start with the phase (Pending/Running/...), then add the details
  let tip = pod.phase;
  if (pod.reason) tip += " - " + pod.reason; // e.g. CrashLoopBackOff
  if (pod.cpu_nano != null) {
    tip += ` | cpu ${fmtCpu(pod.cpu_nano)} mem ${fmtMem(pod.mem_bytes)}`;
  }
  return tip;
}

// render one track (lane) of a station: park a new train or update the existing one
function renderTrack(entry, track) {
  // get (or create) the lane for this track index
  const lane = ensureLane(entry, track.index);
  const pod = track.pod;
  if (!pod) {
    lane.classList.add("inactive"); // replica slot with no pod yet: empty track
    return;
  }
  lane.classList.remove("inactive");
  seen.add(pod.uid); // remember we saw this pod, so syncTrains doesn't retire it

  let t = trains.get(pod.uid);
  if (!t) {
    // first time we see this pod: build its train just off-screen left...
    const made = makeTrainEl(pod.name);
    t = {
      uid: pod.uid,
      el: made.el,
      label: made.label,
      state: null,
      gone: false,
    };
    trains.set(pod.uid, t);
    lane.appendChild(t.el);
    setX(t.el, -TRAIN_W - 20, false); // start off-screen left, no animation yet
    void t.el.offsetWidth; // force reflow so the next setX animates
  } else if (t.el.parentElement !== lane) {
    lane.appendChild(t.el); // pod moved to a different track: re-parent
  }
  if (t.state !== pod.state) applyState(t, lane, pod.state);
  else t.label.className = `podlabel ${pod.state}`; // same state: just recolor
  t.label.title = podTooltip(pod);
}

// --- header widgets ---------------------------------------------------------------

// refill the namespace dropdown when the set of namespaces changes
function updateNsSelect(nsSet) {
  // compare a signature so we don't rebuild (and reset the user's selection)
  // on every 2s poll when nothing changed
  const sig = nsSet.join(",");

  // namespaces unchanged since last poll: leave the dropdown as it is
  if (nsSelect.dataset.sig === sig) return;
  // remember which namespaces we rendered, to compare against next poll
  nsSelect.dataset.sig = sig;
  nsSelect.innerHTML = "";

  // first option: show all namespaces at once
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "all namespaces";
  nsSelect.appendChild(allOpt);

  // then one option per namespace
  for (const n of nsSet) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    nsSelect.appendChild(o);
  }
}

// show the first node's live cpu/mem in the header
function updateNodeBox(nodes) {
  const node = nodes[0]; // single-node cluster: the first node is the node
  if (!node) return;
  nodeBox.textContent = `node ${node.name}: cpu ${
    fmtCpu(cpuNano(node.cpu))
  } mem ${fmtMem(memBytes(node.memory))}`;
}

// --- cleanup ----------------------------------------------------------------------
// After rendering, anything we did NOT see in this poll has to go.

// remove stations that vanished from the API (sending their trains off first);
// stations hidden by the namespace filter are kept, just display:none
function syncStations(all, visible) {
  // copy the entries first: we delete from the map while iterating
  for (const [uid, entry] of [...stationEls]) {
    if (all.some((s) => s.uid === uid)) {
      // still exists in the cluster: show it, or hide it if another
      // namespace is selected (hidden, not removed, so trains survive)
      entry.el.style.display = visible.has(uid) ? "" : "none";
      continue;
    }
    stationEls.delete(uid);

    // which trains are currently parked inside this station?
    const resident = [...trains.values()].filter((t) =>
      entry.el.contains(t.el)
    );
    if (resident.length) {
      // let the trains roll off before tearing down the station
      for (const t of resident) applyState(t, t.el.parentElement, "leaving");
      setTimeout(() => entry.el.remove(), MOVE_MS + 400);
    } else {
      entry.el.remove(); // empty station: remove right away
    }
  }
}

// send off trains whose pods vanished from the API
function syncTrains() {
  for (const t of trains.values()) {
    // skip trains seen in this poll, and trains already rolling off
    if (seen.has(t.uid) || t.gone) continue;

    // if the train is on a track, animate it off; otherwise drop it directly
    if (t.el.parentElement) applyState(t, t.el.parentElement, "leaving");
    else {
      t.el.remove(); // not attached anywhere: skip the animation
      trains.delete(t.uid);
    }
  }
}

// --- the render pipeline ------------------------------------------------------------

// rebuild the whole yard from one /api/state payload
function render(data) {
  seen.clear();
  lastData = data;

  // figure out which namespaces exist and which one we are looking at
  const all = data.stations;
  const nsSet = [...new Set(all.map((s) => s.namespace))].sort();
  if (!nsInit && nsSet.length) {
    nsFilter = nsSet[0]; // first visit: default to the first namespace
    nsInit = true;
  }
  if (nsFilter !== "" && !nsSet.includes(nsFilter)) nsFilter = nsSet[0] || "";

  updateNsSelect(nsSet);
  nsSelect.value = nsFilter;

  // apply the namespace filter ("" means show everything)
  const shown = all.filter((s) => !nsFilter || s.namespace === nsFilter);
  const visible = new Set(shown.map((s) => s.uid));
  emptyEl.hidden = shown.length > 0; // "no deployments in this namespace"

  updateNodeBox(data.nodes);

  // draw the stations and their tracks
  for (const st of shown) {
    // get or create the station element for this deployment
    const entry = ensureStation(st);
    entry.el.style.display = "";

    // draw each replica track of this station
    for (const track of st.tracks) renderTrack(entry, track);
  }

  // then clean up whatever disappeared since last poll
  syncStations(all, visible);
  syncTrains();

  fit();
}

// poll /api/state every 2s and re-render; flag the header when the connection drops
async function poll() {
  try {
    const r = await fetch("/api/state");
    const data = await r.json();
    connEl.textContent = "live " + new Date(data.time).toLocaleTimeString();
    connEl.classList.remove("lost");
    render(data);
  } catch {
    connEl.textContent = "connection lost";
    connEl.classList.add("lost");
  }
  // setTimeout (not setInterval) so a slow fetch never stacks up with itself
  setTimeout(poll, 2000);
}

fit(); // initial layout before the first data arrives
poll(); // start the polling loop
