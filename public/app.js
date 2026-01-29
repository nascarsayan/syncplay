const state = {
  user: null,
  roomId: "main",
  ws: null,
  applyingRemote: false,
  currentVideo: null,
  ignoreEventsUntil: 0,
  subtitleLoading: false,
  subtitleLastVideo: null,
  subtitleLastLoadedAt: 0,
};

const DEBUG = true;
function log(...args) {
  if (!DEBUG) return;
  console.log("[syncplay]", ...args);
}

const el = {
  statusBadge: document.getElementById("statusBadge"),
  loginView: document.getElementById("loginView"),
  inviteView: document.getElementById("inviteView"),
  appView: document.getElementById("appView"),
  otpRequestForm: document.getElementById("otpRequestForm"),
  emailInput: document.getElementById("emailInput"),
  otpHint: document.getElementById("otpHint"),
  inviteForm: document.getElementById("inviteForm"),
  inviteToken: document.getElementById("inviteToken"),
  inviteEmail: document.getElementById("inviteEmail"),
  inviteHint: document.getElementById("inviteHint"),
  roomLabel: document.getElementById("roomLabel"),
  userEmail: document.getElementById("userEmail"),
  adminBadge: document.getElementById("adminBadge"),
  logoutButton: document.getElementById("logoutButton"),
  videoPlayer: document.getElementById("videoPlayer"),
  videoOverlay: document.getElementById("videoOverlay"),
  seekBack: document.getElementById("seekBack"),
  seekForward: document.getElementById("seekForward"),
  fullscreenButton: document.getElementById("fullscreenButton"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  nowPlayingSelect: document.getElementById("nowPlayingSelect"),
  applyVideoButton: document.getElementById("applyVideoButton"),
  videoStatus: document.getElementById("videoStatus"),
  adminPanel: document.getElementById("adminPanel"),
  inviteCreateForm: document.getElementById("inviteCreateForm"),
  inviteEmailAdmin: document.getElementById("inviteEmailAdmin"),
  inviteCreateButton: document.getElementById("inviteCreateButton"),
  inviteCreateHint: document.getElementById("inviteCreateHint"),
  inviteList: document.getElementById("inviteList"),
  toggleInvites: document.getElementById("toggleInvites"),
  inviteBody: document.getElementById("inviteBody"),
};

function show(view) {
  el.loginView.classList.add("hidden");
  el.inviteView.classList.add("hidden");
  el.appView.classList.add("hidden");
  view.classList.remove("hidden");
}

function setHint(target, message, isError = false) {
  target.textContent = message;
  target.classList.toggle("error", Boolean(isError));
}

function truncateMiddle(value, front = 28, back = 12) {
  if (!value) return "";
  if (value.length <= front + back + 3) return value;
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    log("fetchJSON:error", url, response.status, data);
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function loadSession() {
  log("loadSession:start");
  const data = await fetchJSON("/api/me", { method: "GET" });
  state.user = data.user;
  if (!state.user) {
    log("loadSession:logged_out");
    show(el.loginView);
    el.adminBadge.classList.add("hidden");
    return;
  }
  log("loadSession:logged_in", state.user.email, "admin", state.user.isAdmin);
  show(el.appView);
  el.userEmail.textContent = state.user.email;
  el.adminBadge.classList.toggle("hidden", !state.user.isAdmin);
  el.adminPanel.classList.toggle("hidden", !state.user.isAdmin);
  if (el.applyVideoButton) {
    el.applyVideoButton.classList.toggle("hidden", !state.user.isAdmin);
    el.applyVideoButton.disabled = true;
  }
  el.roomLabel.textContent = state.roomId;
  await loadVideos();
  await loadInvites();
  updateNowPlayingLabel();
  setControlsEnabled(false);
  connectWebSocket();
  primeRoomState();
}

function syncStatus(online) {
  el.statusBadge.textContent = online ? "live" : "offline";
  el.statusBadge.classList.toggle("online", online);
}

function connectWebSocket() {
  if (state.ws) state.ws.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws?room=${state.roomId}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    log("ws:open");
    syncStatus(true);
  });
  ws.addEventListener("close", () => {
    log("ws:close");
    syncStatus(false);
  });

  ws.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || payload.type !== "state") return;
    log("ws:state", payload.data);
    applyState(payload.data);
  });
}

function sendAction(action) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  log("ws:send", action);
  state.ws.send(
    JSON.stringify({
      type: "action",
      action,
      position: el.videoPlayer.currentTime,
      playbackRate: el.videoPlayer.playbackRate,
    })
  );
}

function applyState(data) {
  const { videoPath, position, paused, playbackRate, serverTime } = data;
  log("applyState", { videoPath, position, paused, playbackRate, serverTime });
  state.applyingRemote = true;

  if (videoPath !== state.currentVideo) {
    state.currentVideo = videoPath;
    if (videoPath) {
      clearSubtitles();
      setHint(el.videoStatus, "Loading video...");
      setControlsEnabled(false);
      el.videoPlayer.src = `/media/${encodeURIComponent(videoPath)}`;
      el.videoOverlay.classList.add("hidden");
      log("applyState:loadSubtitles", videoPath);
      loadSubtitles(videoPath).then(() => {
        applyPreferredSubtitle();
        setTimeout(applyPreferredSubtitle, 300);
      });
    } else {
      el.videoPlayer.removeAttribute("src");
      el.videoPlayer.load();
      el.videoOverlay.classList.remove("hidden");
      setHint(el.videoStatus, "No video selected.");
      setControlsEnabled(false);
      clearSubtitles();
    }
    updateNowPlayingLabel();
  }

  el.videoPlayer.playbackRate = playbackRate || 1;
  if (el.nowPlaying) {
    el.nowPlaying.textContent = videoPath ? `Now playing: ${videoPath}` : "No video selected.";
  }

  if (videoPath) {
    const delta = Math.max(0, (Date.now() - (serverTime || Date.now())) / 1000);
    const targetTime = paused ? position : position + delta * el.videoPlayer.playbackRate;
    if (Number.isFinite(targetTime)) {
      const diff = Math.abs(el.videoPlayer.currentTime - targetTime);
      if (diff > 0.4) {
        el.videoPlayer.currentTime = targetTime;
      }
    }
    if (paused) {
      el.videoPlayer.pause();
    } else {
      el.videoPlayer.play().catch(() => {});
    }
  }

  state.applyingRemote = false;
  state.ignoreEventsUntil = Date.now() + 600;
}

function updateNowPlayingLabel() {
  if (!el.nowPlayingSelect) return;
  const current = state.currentVideo || "";
  if (el.nowPlayingSelect.value !== current) {
    log("nowPlaying:update", current);
    el.nowPlayingSelect.value = current;
  }
  if (el.applyVideoButton) {
    el.applyVideoButton.disabled = true;
  }
}

async function primeRoomState() {
  try {
    const data = await fetchJSON(`/api/room/state?room=${encodeURIComponent(state.roomId)}`);
    if (data?.videoPath) {
      loadSubtitles(data.videoPath).then(() => {
        applyPreferredSubtitle();
        setTimeout(applyPreferredSubtitle, 300);
      });
    }
  } catch {
    // ignore
  }
}

async function loadVideos() {
  if (!state.user?.isAdmin) return;
  const data = await fetchJSON("/api/videos");
  el.nowPlayingSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "None";
  el.nowPlayingSelect.appendChild(placeholder);
  for (const file of data.files) {
    const opt = document.createElement("option");
    opt.value = file;
    opt.textContent = truncateMiddle(file);
    opt.title = file;
    el.nowPlayingSelect.appendChild(opt);
  }
}

async function loadInvites() {
  if (!state.user?.isAdmin) return;
  const data = await fetchJSON("/api/invites");
  el.inviteList.innerHTML = "";
  for (const invite of data.invites) {
    const item = document.createElement("div");
    item.className = "invite-item";
    const email = invite.email ? `for ${invite.email}` : "open";
    item.textContent = `${invite.token} · ${email}`;
    el.inviteList.appendChild(item);
  }
}

async function loadSubtitles(videoPath) {
  if (!el.subtitleSelect) return;
  if (state.subtitleLoading) return;
  if (state.subtitleLastVideo === videoPath && Date.now() - state.subtitleLastLoadedAt < 30000) {
    log("loadSubtitles:skip_recent", videoPath);
    return;
  }
  state.subtitleLoading = true;
  const previousValue = el.subtitleSelect.value;
  log("loadSubtitles:start", videoPath, "previous", previousValue);

  if (!videoPath) {
    state.subtitleLoading = false;
    return;
  }

  try {
    const data = await fetchJSON(`/api/subtitles?video=${encodeURIComponent(videoPath)}`);
    log("loadSubtitles:data", data);
    el.subtitleSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Off";
    el.subtitleSelect.appendChild(noneOpt);
    for (const track of data.tracks || []) {
      const opt = document.createElement("option");
      opt.value = track.url;
      opt.textContent = track.label || track.url;
      el.subtitleSelect.appendChild(opt);
    }
    applyPreferredSubtitle();
    if (previousValue) {
      const match = Array.from(el.subtitleSelect.options).find((opt) => opt.value === previousValue);
      if (match) {
        el.subtitleSelect.value = previousValue;
        setSubtitleTrack(previousValue);
      }
    }
  } catch (error) {
    log("loadSubtitles:error", error?.message || error);
  }
  state.subtitleLoading = false;
  state.subtitleLastLoadedAt = Date.now();
  state.subtitleLastVideo = videoPath;
  log("loadSubtitles:done", videoPath, "count", el.subtitleSelect.options.length);
}

function setSubtitleTrack(url) {
  const existing = el.videoPlayer.querySelector("track");
  if (existing) existing.remove();
  if (!url) return;

  log("setSubtitleTrack", url);
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = "Subtitles";
  track.srclang = "en";
  track.src = url;
  track.default = true;
  el.videoPlayer.appendChild(track);
}

function clearSubtitles() {
  const existing = el.videoPlayer.querySelector("track");
  if (existing) existing.remove();
  if (el.subtitleSelect) {
    el.subtitleSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Off";
    el.subtitleSelect.appendChild(opt);
  }
}

function setControlsEnabled(enabled) {
  el.seekBack.disabled = !enabled;
  el.seekForward.disabled = !enabled;
  el.fullscreenButton.disabled = !enabled;
  if (el.subtitleSelect) el.subtitleSelect.disabled = !enabled;
}

function applyPreferredSubtitle() {
  if (!el.subtitleSelect) return;
  const opts = Array.from(el.subtitleSelect.options);
  const preferred = opts.find((o) => /\beng\b|english/i.test(o.textContent || "")) || opts[1];
  if (preferred) {
    log("applyPreferredSubtitle", preferred.textContent, preferred.value);
    el.subtitleSelect.value = preferred.value;
    setSubtitleTrack(el.subtitleSelect.value);
  }
}

el.otpRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setHint(el.otpHint, "");
  try {
    await fetchJSON("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: el.emailInput.value }),
    });
    setHint(el.otpHint, "Signed in.", false);
    await loadSession();
  } catch (error) {
    setHint(el.otpHint, error.message, true);
  }
});

el.inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setHint(el.inviteHint, "");
  try {
    await fetchJSON("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: el.inviteToken.value,
        email: el.inviteEmail.value,
      }),
    });
    setHint(el.inviteHint, "Invite accepted. Signing you in...");
    await loadSession();
  } catch (error) {
    setHint(el.inviteHint, error.message, true);
  }
});

el.logoutButton.addEventListener("click", async () => {
  await fetchJSON("/api/auth/logout", { method: "POST" });
  state.user = null;
  show(el.loginView);
  syncStatus(false);
});

el.seekBack.addEventListener("click", () => {
  el.videoPlayer.currentTime = Math.max(0, el.videoPlayer.currentTime - 10);
  sendAction("seek");
});
el.seekForward.addEventListener("click", () => {
  el.videoPlayer.currentTime = el.videoPlayer.currentTime + 10;
  sendAction("seek");
});

el.fullscreenButton.addEventListener("click", () => {
  if (el.videoPlayer.requestFullscreen) {
    el.videoPlayer.requestFullscreen();
  }
});

el.videoPlayer.addEventListener("loadedmetadata", () => {
  setHint(el.videoStatus, "Video metadata loaded.");
});

el.videoPlayer.addEventListener("canplay", () => {
  setHint(el.videoStatus, "Video ready.");
  setControlsEnabled(true);
});

el.videoPlayer.addEventListener("error", () => {
  setHint(el.videoStatus, "Video failed to load.", true);
  setControlsEnabled(false);
});

el.videoPlayer.addEventListener("play", () => {
  if (state.applyingRemote) return;
  if (Date.now() < state.ignoreEventsUntil) return;
  log("video:play");
  sendAction("play");
});

el.videoPlayer.addEventListener("pause", () => {
  if (state.applyingRemote) return;
  if (Date.now() < state.ignoreEventsUntil) return;
  if (el.videoPlayer.seeking) return;
  log("video:pause");
  sendAction("pause");
});

el.videoPlayer.addEventListener("seeked", () => {
  if (state.applyingRemote) return;
  if (Date.now() < state.ignoreEventsUntil) return;
  log("video:seeked", el.videoPlayer.currentTime);
  sendAction("seek");
});

el.videoPlayer.addEventListener("ratechange", () => {
  if (state.applyingRemote) return;
  if (Date.now() < state.ignoreEventsUntil) return;
  log("video:rate", el.videoPlayer.playbackRate);
  sendAction("rate");
});

el.nowPlayingSelect.addEventListener("change", () => {
  const videoPath = el.nowPlayingSelect.value || "";
  log("nowPlayingSelect:change", videoPath);
  if (el.applyVideoButton) {
    el.applyVideoButton.disabled = !videoPath || videoPath === state.currentVideo;
  }
  setHint(el.videoStatus, videoPath ? "Selection staged. Click Apply to switch." : "No video selected.");
});

if (el.applyVideoButton) {
  el.applyVideoButton.addEventListener("click", async () => {
    const videoPath = el.nowPlayingSelect.value || null;
    log("applyVideoButton:click", videoPath);
    setHint(el.videoStatus, "Switching video...");
    setControlsEnabled(false);
    await fetchJSON("/api/room/set-video", {
      method: "POST",
      body: JSON.stringify({ roomId: state.roomId, videoPath }),
    });
    setHint(el.videoStatus, videoPath ? "Video selected. Loading..." : "Cleared video.");
    if (el.applyVideoButton) el.applyVideoButton.disabled = true;
  });
}

el.inviteCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setHint(el.inviteCreateHint, "");
  try {
    const data = await fetchJSON("/api/invites/create", {
      method: "POST",
      body: JSON.stringify({
        email: el.inviteEmailAdmin.value || null,
      }),
    });
    setHint(el.inviteCreateHint, `Invite: ${data.inviteUrl}`);
    el.inviteEmailAdmin.value = "";
    el.inviteCreateButton.disabled = true;
    await loadInvites();
  } catch (error) {
    setHint(el.inviteCreateHint, error.message, true);
  }
});

function isValidEmail(value) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
}

el.inviteEmailAdmin.addEventListener("input", () => {
  el.inviteCreateButton.disabled = !isValidEmail(el.inviteEmailAdmin.value.trim());
});

if (el.toggleInvites && el.inviteBody) {
  el.toggleInvites.addEventListener("click", () => {
    const isHidden = el.inviteBody.classList.toggle("hidden");
    el.toggleInvites.textContent = isHidden ? "Show" : "Hide";
  });
}

if (el.subtitleSelect) {
  el.subtitleSelect.addEventListener("change", () => {
    log("subtitleSelect:change", el.subtitleSelect.value);
    setSubtitleTrack(el.subtitleSelect.value);
  });
}

function handleInviteRoute() {
  const match = location.pathname.match(/^\/invite\/(.+)$/);
  if (!match) return false;
  const token = match[1];
  el.inviteToken.value = token;
  show(el.inviteView);
  return true;
}

if (!handleInviteRoute()) {
  loadSession().catch((err) => {
    console.error(err);
    show(el.loginView);
  });
}
