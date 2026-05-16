const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://ciclo-estudos-api.onrender.com'
let USER_ID = localStorage.getItem('ciclo-user-id') || null

// ── FETCH WITH TIMEOUT ──
// timeoutMs: hard abort (default 35s covers Render cold start ~30s)
// onSlow: callback fired after 5s to show "connecting..." UI
async function fetchWithTimeout(url, options = {}, timeoutMs = 35000, onSlow) {
  const ac = new AbortController()
  const abortTimer = setTimeout(() => ac.abort(), timeoutMs)
  let slowTimer
  if (onSlow) slowTimer = setTimeout(onSlow, 5000)
  try {
    const res = await fetch(url, { ...options, signal: ac.signal })
    return res
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('REQUEST_TIMEOUT')
    throw err
  } finally {
    clearTimeout(abortTimer)
    clearTimeout(slowTimer)
  }
}

// ── CLOCK ──
function updateClock() {
  const el = document.getElementById('clock-badge');
  if (el) el.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ── SUBJECT HELPERS (string | {name, dailyGoal}) ──
const COLORS = ['#1d589b','#4b2da5','#e27923','#34d399','#a02263','#1f8f80','#fbbf24','#f85555','#60a5fa','#c084fc'];
function subjectColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}
function subjectInitial(name) { return name.trim()[0]?.toUpperCase() || '?'; }
function sName(s) { return typeof s === 'string' ? s : (s.name || ''); }
function sGoal(s) { return typeof s === 'string' ? 0 : (s.dailyGoal || 0); }

// ── STATE ──
let state = { subjects: [], currentIndex: 0, sessions: [], constantSubjects: [], facultySubjects: [] };
let timerInterval   = null;
let timerSeconds    = 0;
let timerRunning    = false;
let sessionStart    = null;
let pauseInterval   = null;
let pauseSeconds    = 0;
let studyingConstant = null;
let dragSrcIdx      = null;

// ── PLANNING STATE ──
let planningTasks = []
let planningExams = []
let planningPriorities = []
let activeTask = null

// ── POMODORO STATE ──
let pomoActive       = false;
let pomoPhase        = 'focus';   // 'focus' | 'break'
let pomoSecondsLeft  = 0;
let pomoFocusSecs    = 0;         // accumulated focus time in current session
let pomoBreakInterval = null;

// ── PERSIST ──
function save() {
  localStorage.setItem('study-cycle', JSON.stringify(state));
  if (USER_ID) {
    const normalizedSubjects = state.subjects.map(s => ({
      id: s.id || crypto.randomUUID(),
      name: typeof s === 'string' ? s : (s.name || ''),
      dailyGoal: s.dailyGoal || 0,
      order: s.order || 0,
      topics: Array.isArray(s.topics) ? s.topics : []
    }))

    const normalizedSessions = (state.sessions || []).map(s => ({
      id: s.id || crypto.randomUUID(),
      subject: s.subject || '',
      start: s.start || s.end,
      end: s.end,
      duration: s.duration || 0,
      pauseDuration: s.pauseDuration || 0
    }))

    const normalizedState = {
      subjects: normalizedSubjects,
      sessions: normalizedSessions,
      constantSubjects: state.constantSubjects || [],
      facultySubjects: state.facultySubjects || [],
      currentIndex: state.currentIndex || 0
    }

    fetch(`${API_URL}/api/sync/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, state: normalizedState })
    }).catch(() => {})
  }
}
function load() {
  const savedAccent = localStorage.getItem('ciclo-accent-color')
  if (savedAccent) document.documentElement.style.setProperty('--accent', savedAccent)
  const raw = localStorage.getItem('study-cycle');
  if (raw) { try { state = JSON.parse(raw); } catch(e) {} }
  if (!state.constantSubjects) state.constantSubjects = [];
  if (!state.facultySubjects) state.facultySubjects = [];
  // Normalize subjects: strings → {name, dailyGoal} and ensure id/order/topics
  state.subjects = state.subjects.map(s =>
    typeof s === 'string'
      ? { id: crypto.randomUUID(), name: s, dailyGoal: 0, order: 0, topics: [] }
      : { id: s.id || crypto.randomUUID(), name: s.name, dailyGoal: s.dailyGoal || 0, order: s.order || 0, topics: Array.isArray(s.topics) ? s.topics : [] }
  );
  initSync().then(() => renderDashboard())
}

// ── SYNC ──
async function initSync() {
  try {
    const res = await fetch(`${API_URL}/api/sync/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID })
    })
    if (!res.ok) return
    const data = await res.json()
    localStorage.setItem('ciclo-user-id', data.userId)
    USER_ID = data.userId
    updateUserIdDisplay()
    const remote = data.state
    if (remote.subjects && remote.subjects.length > 0) {
      state.subjects = remote.subjects
      state.sessions = remote.sessions ?? []
      state.constantSubjects = remote.constantSubjects ?? []
      state.facultySubjects = remote.facultySubjects ?? []
      state.currentIndex = remote.currentIndex ?? 0
    }
    save()
  } catch {
    // Server offline — continue with localStorage
  }
}

async function ensureUser() {
  if (!USER_ID) {
    await initSync()
  }
  if (!USER_ID) throw new Error('USER_UNAVAILABLE')
}

// ── AUDIO / VIBRATION ──
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}
function doVibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

// ── SIDEBAR DOTS ──
function updateSidebarDot() {
  const cls = timerRunning ? 'nav-dot running' : timerSeconds > 0 ? 'nav-dot paused' : 'nav-dot';
  document.querySelectorAll('.nav-dot').forEach(d => { d.className = cls; });
}

// ── POMODORO ──
function onPomoToggle() {
  pomoActive = document.getElementById('pomo-toggle').checked;
  if (!pomoActive) {
    document.getElementById('pomo-block-bar').style.display = 'none';
    if (!timerRunning && timerSeconds === 0) { pomoPhase = 'focus'; pomoSecondsLeft = 0; pomoFocusSecs = 0; }
  }
  const badge = document.getElementById('pomo-badge')
  if (badge) badge.style.display = pomoActive ? 'flex' : 'none'
  const cfg = document.getElementById('pomo-config')
  if (cfg) cfg.style.display = pomoActive ? 'block' : 'none'
}
function getPomoFocusSecs() { return (parseInt(document.getElementById('pomo-focus')?.value) || 25) * 60; }
function getPomoBreakSecs() { return (parseInt(document.getElementById('pomo-break')?.value) || 5) * 60; }

function updatePomoBadge() {
  const b = document.getElementById('pomo-phase-badge');
  if (!b) return;
  b.textContent = pomoPhase === 'focus' ? 'Foco' : 'Pausa';
  b.className = 'pomo-phase-badge ' + (pomoPhase === 'focus' ? 'pomo-phase-focus' : 'pomo-phase-break');
}

function updatePomoBar() {
  const total   = pomoPhase === 'focus' ? getPomoFocusSecs() : getPomoBreakSecs();
  const elapsed = total - pomoSecondsLeft;
  const pct     = Math.min(100, Math.round(elapsed / total * 100));
  const fill    = document.getElementById('pomo-bar-fill');
  if (!fill) return;
  fill.style.width      = pct + '%';
  fill.style.background = pomoPhase === 'break' ? 'var(--green)' : 'var(--accent)';
}

function onPomoFocusEnd() {
  // Called from within timerInterval — safe to clear here
  clearInterval(timerInterval); timerInterval = null;
  timerRunning = false;
  playBeep(); doVibrate([200, 100, 200]);
  showToast('Bloco concluído! Pausa de ' + Math.round(getPomoBreakSecs() / 60) + ' min', 'info');

  pomoPhase = 'break';
  pomoSecondsLeft = getPomoBreakSecs();
  updatePomoBadge(); updatePomoBar();

  document.getElementById('timer-display').textContent = formatTime(pomoSecondsLeft);
  document.getElementById('timer-display').className = 'timer-time paused';
  document.getElementById('timer-status').textContent = 'pausa pomodoro';
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-pause').disabled = true;
  document.getElementById('timer-card').classList.remove('running');
  updateSidebarDot();

  if (pomoBreakInterval) clearInterval(pomoBreakInterval);
  pomoBreakInterval = setInterval(() => {
    pomoSecondsLeft--;
    updatePomoBar();
    document.getElementById('timer-display').textContent = formatTime(Math.max(0, pomoSecondsLeft));
    if (pomoSecondsLeft <= 0) {
      clearInterval(pomoBreakInterval); pomoBreakInterval = null;
      playBeep(); doVibrate([200]);
      showToast('Hora de voltar!', 'info');
      pomoPhase = 'focus';
      pomoSecondsLeft = getPomoFocusSecs();
      updatePomoBadge(); updatePomoBar();
      document.getElementById('timer-display').textContent = formatTime(pomoSecondsLeft);
      document.getElementById('timer-display').className = 'timer-time';
      document.getElementById('timer-status').textContent = 'pronto';
      document.getElementById('btn-start').disabled = false;
    }
  }, 1000);
}

// ── TIMER ──
function startTimer() {
  if (!studyingConstant && !state.subjects.length) { showToast('Adicione matérias primeiro', 'info'); showView('subjects'); return; }
  if (pauseInterval) { clearInterval(pauseInterval); pauseInterval = null; }
  sessionStart = sessionStart || new Date().toISOString();

  if (pomoActive && timerSeconds === 0) {
    pomoPhase = 'focus';
    pomoSecondsLeft = getPomoFocusSecs();
    pomoFocusSecs = 0;
    document.getElementById('pomo-block-bar').style.display = '';
    updatePomoBadge();
  }

  timerRunning = true;
  timerInterval = setInterval(() => {
    timerSeconds++;
    if (pomoActive && pomoPhase === 'focus') {
      pomoFocusSecs++;
      pomoSecondsLeft--;
      updatePomoBar();
      if (pomoSecondsLeft <= 0) { onPomoFocusEnd(); return; }
    }
    updateTimerDisplay();
    renderGoalProgress();
  }, 1000);

  document.getElementById('btn-start').disabled  = true;
  document.getElementById('btn-pause').disabled  = false;
  document.getElementById('btn-finish').disabled = false;
  document.getElementById('timer-display').className = 'timer-time running';
  document.getElementById('timer-status').textContent = pomoActive ? 'foco' : 'em andamento';
  document.getElementById('timer-card').classList.add('running');
  updatePauseDisplay();
  updateSidebarDot();
}

function pauseTimer() {
  if (!timerRunning) return;
  clearInterval(timerInterval); timerInterval = null;
  timerRunning = false;
  pauseInterval = setInterval(() => { pauseSeconds++; updatePauseDisplay(); }, 1000);
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-pause').disabled = true;
  document.getElementById('timer-display').className = 'timer-time paused';
  document.getElementById('timer-status').textContent = 'pausado';
  document.getElementById('timer-card').classList.remove('running');
  updateSidebarDot();
}

function finishSession() {
  if (!timerRunning && timerSeconds === 0) return;
  const subjectName = studyingConstant !== null ? studyingConstant : sName(state.subjects[state.currentIndex]);
  const isConstant  = studyingConstant !== null;
  const duration    = (pomoActive && pomoFocusSecs > 0) ? pomoFocusSecs : timerSeconds;
  if (duration === 0) { showToast('Tempo insuficiente para registrar', 'info'); return; }

  const pauseInfo  = pauseSeconds > 0 ? ` e <strong>${formatShort(pauseSeconds)}</strong> de pausa` : '';
  const advanceInfo = isConstant ? '' : ' e avançar para a próxima matéria';

  showModal({
    icon: '✅', title: 'Finalizar sessão?',
    desc: `Salvar <strong>${formatTime(duration)}</strong> de estudo${pauseInfo} em <strong>${subjectName}</strong>${advanceInfo}?`,
    confirmLabel: 'Finalizar',
    onConfirm: () => {
      clearInterval(timerInterval); clearInterval(pauseInterval); clearInterval(pomoBreakInterval);
      timerInterval = null; pauseInterval = null; pomoBreakInterval = null;
      timerRunning = false;

      const newSession = { id: crypto.randomUUID(), subject: subjectName, start: sessionStart, end: new Date().toISOString(), duration, pauseDuration: pauseSeconds };
      state.sessions.unshift(newSession);
      if (!isConstant && state.subjects.length > 0) state.currentIndex = (state.currentIndex + 1) % state.subjects.length;
      studyingConstant = null;
      save();
      if (USER_ID) {
        fetch(`${API_URL}/api/sync/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_ID, session: newSession })
        }).catch(() => {})
      }

      if (activeTask) {
        const newTotal = (activeTask.totalTime || 0) + newSession.duration
        if (USER_ID) {
          fetch(`${API_URL}/api/tasks/${activeTask.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ totalTime: newTotal })
          }).catch(() => {})
        }
        activeTask.totalTime = newTotal
        const tidx = planningTasks.findIndex(t => t.id === activeTask.id)
        if (tidx !== -1) planningTasks[tidx].totalTime = newTotal
        activeTask = null
      }

      playBeep(); doVibrate([200, 100, 200]);
      showToast(`${subjectName} — ${formatTime(duration)} registrado`, 'success');

      timerSeconds = 0; pauseSeconds = 0; sessionStart = null;
      pomoFocusSecs = 0; pomoPhase = 'focus'; pomoSecondsLeft = 0;
      document.getElementById('pomo-block-bar').style.display = 'none';
      if (document.getElementById('pomo-bar-fill')) document.getElementById('pomo-bar-fill').style.width = '0%';
      updatePomoBadge();

      document.getElementById('btn-start').disabled  = false;
      document.getElementById('btn-pause').disabled  = true;
      document.getElementById('btn-finish').disabled = true;
      document.getElementById('timer-display').className = 'timer-time';
      document.getElementById('timer-status').textContent = 'parado';
      document.getElementById('timer-card').classList.remove('running');
      updateTimerDisplay(); updatePauseDisplay(); updateSidebarDot();
      renderGoalProgress(); renderDashboard(); buildConsistencyGraph();
    }
  });
}

function updateTimerDisplay() {
  const secs = (pomoActive && pomoPhase === 'focus' && pomoSecondsLeft > 0)
    ? pomoSecondsLeft : timerSeconds
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const pad = n => String(n).padStart(2, '0')
  const el = document.getElementById('timer-display')
  if (el) {
    el.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }
  updateTimerRing()
}

function updateTimerRing() {
  const ring = document.getElementById('timer-ring-fill')
  const dot  = document.getElementById('timer-ring-dot')
  if (!ring) return

  const r    = 152
  const circ = 2 * Math.PI * r

  if (!timerRunning && timerSeconds === 0) {
    ring.style.opacity = '0'
    if (dot) dot.style.opacity = '0'
    ring.setAttribute('stroke-dashoffset', String(circ))
    return
  }

  // Progresso: 45 minutos = 1 volta completa
  const FULL_CYCLE_SECS = 45 * 60
  const pct = timerRunning || timerSeconds > 0
    ? Math.min(1, timerSeconds / FULL_CYCLE_SECS)
    : 0

  const grad0 = document.getElementById('timer-grad-0')
  const grad1 = document.getElementById('timer-grad-1')
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  if (grad0) grad0.setAttribute('stop-color', accent)
  if (grad1) grad1.setAttribute('stop-color', accent)
  if (dot)   dot.style.fill = accent

  ring.setAttribute('stroke-dasharray', String(circ))
  ring.setAttribute('stroke-dashoffset', String(circ * (1 - pct)))
  ring.style.opacity = '1'
  ring.removeAttribute('stroke') // deixa o gradiente CSS atuar

  // Dot: posiciona no fim do arco
  if (dot) {
    const angle = pct * 2 * Math.PI - Math.PI / 2
    const cx = 160 + r * Math.cos(angle)
    const cy = 160 + r * Math.sin(angle)
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', String(cy))
    dot.style.opacity = timerRunning ? '1' : '0.5'
  }
}

function updatePauseDisplay() {
  const el = document.getElementById('pause-display');
  if (!el) return;
  if (pauseSeconds === 0) { el.textContent = ''; el.className = 'pause-time'; return; }
  el.textContent  = `pausa  ${formatTime(pauseSeconds)}`;
  el.className = 'pause-time ' + (pauseInterval ? 'counting' : 'accumulated');
}

function formatTime(s) {
  s = Math.max(0, s);
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60].map(n => String(n).padStart(2,'0')).join(':');
}
function formatShort(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtPlanSecs(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
  if (m > 0) return `${m}min`
  return secs > 0 ? `${secs}s` : '—'
}

// ── GOAL PROGRESS ──
function renderGoalProgress() {
  const section = document.getElementById('goal-section');
  if (!section) return;
  if (studyingConstant !== null || !state.subjects.length) { section.style.display = 'none'; return; }
  const subj = state.subjects[state.currentIndex];
  const goal = sGoal(subj);
  if (!goal) { section.style.display = 'none'; return; }

  section.style.display = '';
  const goalSecs = goal * 60;
  const todayStr = new Date().toDateString();
  const studied  = state.sessions
    .filter(s => s.subject === sName(subj) && new Date(s.end).toDateString() === todayStr)
    .reduce((a, s) => a + s.duration, 0) + (timerRunning ? timerSeconds : 0);
  const pct  = Math.min(100, Math.round(studied / goalSecs * 100));
  const done = studied >= goalSecs;

  document.getElementById('goal-text').textContent = `${formatShort(studied)} / ${formatShort(goalSecs)}`;
  document.getElementById('goal-pct').textContent  = `${pct}%`;
  document.getElementById('goal-fill').style.width = pct + '%';
  document.getElementById('goal-fill').className   = 'goal-bar-fill' + (done ? ' done' : '');
}

// ── DASHBOARD ──
function getDashGreeting() {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'bom dia, foco total!'
  if (h >= 12 && h < 18) return 'boa tarde, bora estudar!'
  if (h >= 18) return 'boa noite, mais um bloco!'
  return 'ainda acordado? foco!'
}

function renderDashStats() {
  const el = document.getElementById('dash-stats')
  if (!el) return

  const todayStr  = new Date().toDateString()
  const todaySess = state.sessions.filter(s =>
    new Date(s.end).toDateString() === todayStr)
  const todaySecs = todaySess.reduce((a, s) => a + s.duration, 0)
  const weekSess  = state.sessions.filter(s =>
    new Date(s.end) >= getWeekStart())
  const weekSecs  = weekSess.reduce((a, s) => a + s.duration, 0)
  const streak    = calcStreak()
  const total     = state.sessions.length

  const fmtSecs = secs => {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
    return m > 0 ? `${m}min` : secs > 0 ? `${secs}s` : '—'
  }

  const icons = {
    clock:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    trend:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    flame:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 3z"/></svg>`,
    target: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  }

  const card = (icon, label, value, sub, color = 'var(--text)') =>
    `<div style="background:var(--surface2);border:1px solid var(--surface3);
                 border-radius:10px;padding:14px 16px">
      <div style="display:flex;align-items:center;gap:6px;color:var(--text-dim);
                  margin-bottom:8px">
        ${icon}
        <span style="font-size:9px;font-family:monospace;letter-spacing:1px">
          ${label}
        </span>
      </div>
      <div style="font-size:22px;font-weight:600;color:${color};line-height:1">
        ${value}
      </div>
      <div style="font-size:10px;color:var(--text-dim);margin-top:4px">${sub}</div>
    </div>`

  el.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px'
  el.innerHTML = [
    card(icons.clock,  'HOJE',      fmtSecs(todaySecs),
      `${todaySess.length} sess${todaySess.length===1?'ão':'ões'}`),
    card(icons.trend,  'SEMANA',    fmtSecs(weekSecs),
      `${weekSess.length} sessões`),
    card(icons.flame,  'SEQUÊNCIA', streak > 0 ? `${streak}d` : '—',
      streak > 0 ? `Melhor sequência` : 'sem sequência',
      streak > 0 ? 'var(--orange)' : 'var(--text-dim)'),
    card(icons.target, 'SESSÕES',   `${total}`, 'concluídas'),
  ].join('')
}

function renderFocusToday() {
  const el = document.getElementById('focus-today-content')
  if (!el) return

  const todayStr  = new Date().toDateString()
  const todaySecs = state.sessions
    .filter(s => new Date(s.end).toDateString() === todayStr)
    .reduce((a, s) => a + s.duration, 0) + (timerRunning ? timerSeconds : 0)

  const totalGoalSecs = state.subjects.reduce((a, s) => a + sGoal(s) * 60, 0)

  if (!totalGoalSecs) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-dim)">
      Defina metas diárias nas matérias para ver seu progresso.</div>`
    return
  }

  const pct   = Math.min(1, todaySecs / totalGoalSecs)
  const done  = todaySecs >= totalGoalSecs
  const color = done ? 'var(--green)' : pct >= 0.6 ? 'var(--accent)'
    : pct >= 0.3 ? 'var(--orange)' : '#f87171'

  const r1 = 34, r2 = 26, r3 = 18
  const c1 = 2 * Math.PI * r1
  const fmtSecs = secs => {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
    return m > 0 ? `${m}min` : secs > 0 ? `${secs}s` : '0min'
  }
  const msg = done ? 'Meta diária atingida! 🎉'
    : pct >= 0.6 ? 'Bom progresso, continue!'
    : pct >= 0.3 ? 'Você está no caminho certo.'
    : 'Pequeno progresso todos os dias gera grandes resultados.'

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
      <svg width="80" height="80" viewBox="0 0 80 80" style="flex-shrink:0">
        <circle cx="40" cy="40" r="${r1}" fill="none"
          stroke="rgba(248,113,113,0.1)" stroke-width="5"/>
        <circle cx="40" cy="40" r="${r2}" fill="none"
          stroke="rgba(248,113,113,0.15)" stroke-width="5"/>
        <circle cx="40" cy="40" r="${r3}" fill="none"
          stroke="rgba(248,113,113,0.2)" stroke-width="5"/>
        <circle cx="40" cy="40" r="${r1}" fill="none"
          stroke="${color}" stroke-width="5"
          stroke-linecap="round"
          stroke-dasharray="${c1}"
          stroke-dashoffset="${c1 * (1 - pct)}"
          transform="rotate(-90 40 40)"
          style="transition:stroke-dashoffset .6s ease"/>
      </svg>
      <div>
        <div style="display:flex;align-items:baseline;gap:4px">
          <span style="font-size:22px;font-weight:700;color:${color}">
            ${fmtSecs(todaySecs)}
          </span>
          <span style="font-size:13px;color:var(--text-dim)">
            / ${fmtSecs(totalGoalSecs)}
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
          Meta diária
        </div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);font-style:italic">
      ${msg}
    </div>`
}

function renderDashPriorities() {
  let el = document.getElementById('dash-priorities')
  if (!el) {
    const stats = document.getElementById('dash-stats')
    if (!stats) return
    stats.insertAdjacentHTML('beforebegin', '<div id="dash-priorities"></div>')
    el = document.getElementById('dash-priorities')
    if (!el) return
  }
  const top2 = planningPriorities.slice(0, 2)
  if (!top2.length) {
    el.innerHTML = `<div style="background:var(--surface2);border:1px solid var(--surface3);border-radius:10px;padding:16px 20px;margin-top:16px">
      <div style="font-family:monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Foco agora</div>
      <div style="color:var(--text-dim);font-size:12px">Defina suas prioridades na aba Planejamento</div>
    </div>`
    return
  }
  const items = top2.map(p => {
    const [lbl, col] = planUrgencyInfo(p.urgencyLevel)
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0">
      <span style="background:${col};color:#000;font-size:9px;font-family:monospace;font-weight:700;letter-spacing:1px;padding:1px 5px;border-radius:4px;flex-shrink:0;white-space:nowrap">${lbl}</span>
      <div style="min-width:0;flex:1">
        <div style="font-size:12px;font-weight:600;color:var(--text)">${p.subjectName}</div>
        <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.reason}</div>
      </div>
    </div>`
  }).join('')
  el.innerHTML = `<div style="background:var(--surface2);border:1px solid var(--surface3);border-radius:10px;padding:16px 20px;margin-top:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-family:monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase">Foco agora</span>
      <button onclick="showView('planning')" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--accent);padding:0">ver todas →</button>
    </div>
    ${items}
  </div>`
}

function showCompletionToast(msg) {
  let t = document.getElementById('completion-toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'completion-toast'
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--green-dim);color:var(--green);border:1px solid var(--green);border-radius:8px;padding:12px 16px;font-size:13px;z-index:500;white-space:nowrap;pointer-events:none;display:none'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.style.display = 'block'
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.style.display = 'none' }, 4000)
}

function renderDashboard() {
  const nameEl    = document.getElementById('current-subject-name');
  const nextList  = document.getElementById('next-list');
  const cycleEl   = document.getElementById('cycle-indicator');
  const todayList = document.getElementById('today-list');

  if (!state.subjects.length && studyingConstant === null) {
    nameEl.textContent = 'Nenhuma matéria cadastrada';
    nameEl.className = 'subject-name empty';
    document.getElementById('active-task-label')?.remove()
    nextList.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px 0">—</div>';
    cycleEl.innerHTML = '';
    if (todayList) todayList.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">Nenhuma sessão hoje</div>';
    renderConstantDashboard(); renderFacultyDashboard(); renderGoalProgress(); renderDashStats(); renderFocusToday(); renderDashPriorities();
    return;
  }

  nameEl.className = 'subject-name';
  nameEl.textContent = studyingConstant !== null ? studyingConstant : sName(state.subjects[state.currentIndex]);
  let _taskLbl = document.getElementById('active-task-label')
  if (activeTask) {
    if (!_taskLbl) {
      nameEl.insertAdjacentHTML('afterend', '<div id="active-task-label" style="font-size:12px;font-style:italic;margin-top:2px"></div>')
      _taskLbl = document.getElementById('active-task-label')
    }
    if (_taskLbl) {
      if (activeTask.daysLeft != null) {
        const reviewColor = activeTask.daysLeft <= 7 ? 'var(--red)' : 'var(--orange)'
        _taskLbl.style.color = reviewColor
        _taskLbl.textContent = `Revisão para prova — ${activeTask.daysLeft} dias`
      } else {
        _taskLbl.style.color = 'var(--accent)'
        _taskLbl.textContent = `Tarefa: ${activeTask.title}`
      }
    }
  } else if (_taskLbl) {
    _taskLbl.remove()
  }

  cycleEl.innerHTML = state.subjects.map((_, i) =>
    `<div class="cycle-dot ${i === state.currentIndex ? 'active' : ''}"></div>`
  ).join('');

  if (state.subjects.length > 0) {
    const nexts = []
    for (let i = 1; i <= 5; i++)
      nexts.push({ name: sName(state.subjects[(state.currentIndex + i) % state.subjects.length]), offset: i })
    nextList.innerHTML = nexts.map((n, i) => {
      const isFirst = i === 0
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                border-radius:10px;margin-bottom:4px;cursor:pointer;
                background:${isFirst ? 'color-mix(in srgb,var(--accent) 15%,transparent)' : 'transparent'};
                border:1px solid ${isFirst ? 'color-mix(in srgb,var(--accent) 30%,transparent)' : 'transparent'};
                transition:background 0.2s"
              onclick="state.currentIndex=(state.currentIndex+${n.offset})%state.subjects.length;save();renderDashboard()">
        <div style="width:26px;height:26px;border-radius:50%;background:var(--accent);
                    display:flex;align-items:center;justify-content:center;
                    font-size:11px;font-weight:700;color:#000;flex-shrink:0">
          ${n.offset}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:${isFirst ? 'var(--text)' : 'var(--text-muted)'};
                      font-weight:${isFirst ? '600' : '400'};
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${n.name}
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:1px">
            Próxima sessão
          </div>
        </div>
      </div>`
    }).join('')
  } else {
    nextList.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">—</div>'
  }

  const todayStr = new Date().toDateString();
  const bySubject = {};
  state.sessions.filter(s => new Date(s.end).toDateString() === todayStr).forEach(s => {
    bySubject[s.subject] = (bySubject[s.subject] || 0) + s.duration;
  });
  const entries = Object.entries(bySubject).sort((a, b) => b[1] - a[1]);

  if (todayList) todayList.innerHTML = !entries.length
    ? '<div style="font-size:12px;color:var(--text-dim)">Nenhuma sessão hoje</div>'
    : entries.map(([name, time]) =>
        `<div style="font-size:12px;color:var(--text-muted);padding:3px 0">${name} — ${formatShort(time)}</div>`
      ).join('');

  renderConstantDashboard(); renderFacultyDashboard(); renderGoalProgress(); renderDashStats(); renderFocusToday(); renderDashPriorities();
  const dashView = document.getElementById('view-dashboard')
  if (dashView && !dashView.querySelector('.view-spacer')) dashView.insertAdjacentHTML('beforeend', '<div class="view-spacer" style="height:80px"></div>')
}

// ── CONSTANT SUBJECTS ──
function renderConstantDashboard() {
  const section = document.getElementById('const-dash-section')
  if (!section) return
  if (!state.constantSubjects || !state.constantSubjects.length) {
    section.style.display = 'none'; return
  }
  section.style.display = 'block'
  document.getElementById('const-dash-list').innerHTML =
    state.constantSubjects.map(name => {
      const isActive = studyingConstant === name
      const safe = name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")
      return `<div onclick="selectConstantSubject('${safe}')"
        style="display:flex;align-items:center;gap:10px;padding:8px 10px;
               border-radius:10px;margin-bottom:4px;cursor:pointer;
               background:${isActive
                 ? 'color-mix(in srgb,var(--accent) 15%,transparent)'
                 : 'transparent'};
               border:1px solid ${isActive
                 ? 'color-mix(in srgb,var(--accent) 30%,transparent)'
                 : 'transparent'};
               transition:background 0.2s">
        <div style="width:26px;height:26px;border-radius:50%;
                    background:var(--accent);display:flex;
                    align-items:center;justify-content:center;
                    font-size:11px;font-weight:700;color:#000;flex-shrink:0">
          ${subjectInitial(name)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;
                      white-space:nowrap;
                      color:${isActive ? 'var(--text)' : 'var(--text-muted)'};
                      font-weight:${isActive ? '600' : '400'}">
            ${name}
          </div>
        </div>
        ${isActive ? '<span style="font-size:9px;font-family:monospace;color:var(--accent);letter-spacing:1px">ATIVA</span>' : ''}
      </div>`
    }).join('')
}

function renderFacultyDashboard() {
  const section = document.getElementById('faculty-dash-section')
  if (!section) return
  if (!state.facultySubjects || !state.facultySubjects.length) {
    section.style.display = 'none'; return
  }
  section.style.display = 'block'
  document.getElementById('faculty-dash-list').innerHTML =
    state.facultySubjects.map(s => {
      const name = s.name
      const isActive = studyingConstant === name
      const safe = name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")
      return `<div onclick="selectConstantSubject('${safe}')"
        style="display:flex;align-items:center;gap:10px;padding:8px 10px;
               border-radius:10px;margin-bottom:4px;cursor:pointer;
               background:${isActive
                 ? 'color-mix(in srgb,var(--accent) 15%,transparent)'
                 : 'transparent'};
               border:1px solid ${isActive
                 ? 'color-mix(in srgb,var(--accent) 30%,transparent)'
                 : 'transparent'};
               transition:background 0.2s">
        <div style="width:26px;height:26px;border-radius:50%;
                    background:var(--accent);display:flex;
                    align-items:center;justify-content:center;
                    font-size:11px;font-weight:700;color:#000;flex-shrink:0">
          ${subjectInitial(name)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;
                      white-space:nowrap;
                      color:${isActive ? 'var(--text)' : 'var(--text-muted)'};
                      font-weight:${isActive ? '600' : '400'}">
            ${name}
          </div>
        </div>
        ${isActive ? '<span style="font-size:9px;font-family:monospace;color:var(--accent);letter-spacing:1px">ATIVA</span>' : ''}
      </div>`
    }).join('')
}

function selectConstantSubject(name) {
  if (timerRunning || timerSeconds > 0) { showToast('Pare o timer atual primeiro', 'info'); return; }
  studyingConstant = (studyingConstant === name) ? null : name;
  const nameEl = document.getElementById('current-subject-name');
  if (nameEl) {
    nameEl.className = 'subject-name';
    nameEl.textContent = studyingConstant !== null ? studyingConstant : (state.subjects.length ? sName(state.subjects[state.currentIndex]) : '—');
  }
  renderConstantDashboard(); renderFacultyDashboard(); renderGoalProgress();
}

function addConstantSubject() {
  const input = document.getElementById('constant-input');
  const name  = input.value.trim();
  if (!name) return;
  if (!state.constantSubjects) state.constantSubjects = [];
  if (state.constantSubjects.includes(name)) { showToast('Matéria já existe nas constantes', 'error'); return; }
  state.constantSubjects.push(name);
  save(); input.value = '';
  renderConstantManage(); renderConstantDashboard(); renderFacultyDashboard();
}

function removeConstantSubject(idx) {
  const name = state.constantSubjects[idx];
  showModal({
    icon: '🗑️', title: 'Remover matéria constante', desc: `Remover <strong>${name}</strong>?`, confirmLabel: 'Remover',
    onConfirm: () => {
      state.constantSubjects.splice(idx, 1);
      if (studyingConstant === name) studyingConstant = null;
      save(); renderConstantManage(); renderConstantDashboard(); renderFacultyDashboard();
      showToast(`"${name}" removida`, 'success');
    }
  });
}

function renderConstantManage() {
  const list = document.getElementById('const-manage-list');
  if (!list) return;
  if (!state.constantSubjects || !state.constantSubjects.length) {
    list.innerHTML = '<div class="const-empty">Nenhuma matéria constante cadastrada ainda.</div>'; return;
  }
  list.innerHTML = state.constantSubjects.map((name, i) => {
    const c = subjectColor(name);
    return `<div class="const-manage-item">
      <div class="const-icon" style="background:${c}">${subjectInitial(name)}</div>
      <span class="const-manage-name">${name}</span>
      <button class="icon-btn del" onclick="removeConstantSubject(${i})" title="Remover">×</button>
    </div>`;
  }).join('');
}

// ── FACULTY SUBJECTS ──
function addFacultySubject() {
  const name = (document.getElementById('faculty-name')?.value || '').trim()
  if (!name) { showToast('Preencha o nome da matéria', 'error'); return }
  if (!state.facultySubjects) state.facultySubjects = []
  if (state.facultySubjects.some(s => s.name === name)) {
    showToast('Matéria já existe na faculdade', 'error'); return
  }
  state.facultySubjects.push({ name })
  save()
  document.getElementById('faculty-name').value = ''
  renderFacultySubjects()
}

function removeFacultySubject(idx) {
  state.facultySubjects.splice(idx, 1)
  save()
  renderFacultySubjects()
}

function renderFacultySubjects() {
  const list = document.getElementById('faculty-list')
  if (!list) return
  if (!state.facultySubjects) state.facultySubjects = []
  if (!state.facultySubjects.length) {
    list.innerHTML = '<div class="const-empty">Nenhuma matéria da faculdade cadastrada.</div>'
    return
  }
  list.innerHTML = state.facultySubjects.map((s, idx) => {
    const c = subjectColor(s.name)
    return `<div class="const-manage-item">
      <div class="const-icon" style="background:${c}">${subjectInitial(s.name)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</div>
      </div>
      <button class="icon-btn del" onclick="removeFacultySubject(${idx})" title="Remover">×</button>
    </div>`
  }).join('')
}

// ── SUBJECTS ──
function addSubject() {
  const input = document.getElementById('subject-input');
  const name  = input.value.trim();
  if (!name) return;
  if (state.subjects.some(s => sName(s) === name)) { showToast('Matéria já existe no ciclo', 'error'); return; }
  state.subjects.push({ name, dailyGoal: 0 });
  save(); input.value = '';
  renderSubjects(); renderDashboard();
}

function removeSubject(idx) {
  if (state.subjects.length === 1) { showToast('Deve ter ao menos uma matéria', 'error'); return; }
  const name = sName(state.subjects[idx]);
  showModal({
    icon: '🗑️', title: 'Remover matéria',
    desc: `Tem certeza que deseja remover <strong>${name}</strong>? Esta ação não pode ser desfeita.`,
    confirmLabel: 'Remover',
    onConfirm: () => {
      state.subjects.splice(idx, 1);
      if (idx < state.currentIndex) state.currentIndex--;
      if (state.currentIndex >= state.subjects.length) state.currentIndex = 0;
      save(); renderSubjects(); renderDashboard();
      showToast(`"${name}" removida`, 'success');
    }
  });
}

function setSubjectGoal(idx, val) {
  const g = Math.max(0, parseInt(val) || 0);
  if (typeof state.subjects[idx] === 'string') state.subjects[idx] = { name: state.subjects[idx], dailyGoal: g };
  else state.subjects[idx].dailyGoal = g;
  save(); renderGoalProgress();
}

function moveSubject(idx, dir) {
  const ni = idx + dir;
  if (ni < 0 || ni >= state.subjects.length) return;
  [state.subjects[idx], state.subjects[ni]] = [state.subjects[ni], state.subjects[idx]];
  if (state.currentIndex === idx) state.currentIndex = ni;
  else if (state.currentIndex === ni) state.currentIndex = idx;
  save(); renderSubjects(); renderDashboard();
}

function editSubject(idx) {
  const item = document.getElementById(`subject-item-${idx}`);
  if (!item) return;
  const nameEl = item.querySelector('.subject-item-name');
  const currentName = sName(state.subjects[idx]);
  const inp = document.createElement('input');
  inp.className = 'input'; inp.value = currentName;
  inp.style.cssText = 'flex:1;padding:5px 10px;font-size:13px;height:auto';
  nameEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const apply = () => {
    if (done) return; done = true;
    const newName = inp.value.trim();
    if (!newName || newName === currentName) { renderSubjects(); return; }
    if (state.subjects.some(s => sName(s) === newName)) { showToast('Matéria já existe', 'error'); renderSubjects(); return; }
    state.sessions.forEach(s => { if (s.subject === currentName) s.subject = newName; });
    if (typeof state.subjects[idx] === 'string') state.subjects[idx] = { name: newName, dailyGoal: 0 };
    else state.subjects[idx].name = newName;
    save(); renderSubjects(); renderDashboard();
    showToast('Matéria renomeada', 'success');
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') { done = true; renderSubjects(); } });
  inp.addEventListener('blur', apply);
}

// ── DRAG & DROP ──
const isTouchDevice = 'ontouchstart' in window;

function onDragStart(e, idx) {
  dragSrcIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => e.target.classList.add('dragging'), 0);
}
function onDragOver(e)  { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e, idx) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (dragSrcIdx === null || dragSrcIdx === idx) { dragSrcIdx = null; return; }
  const src = dragSrcIdx;
  const [moved] = state.subjects.splice(src, 1);
  state.subjects.splice(idx, 0, moved);
  if (state.currentIndex === src) state.currentIndex = idx;
  else if (src < state.currentIndex && idx >= state.currentIndex) state.currentIndex--;
  else if (src > state.currentIndex && idx <= state.currentIndex) state.currentIndex++;
  dragSrcIdx = null;
  save(); renderSubjects(); renderDashboard();
}
function onDragEnd() {
  document.querySelectorAll('.subject-item').forEach(c => c.classList.remove('drag-over','dragging'));
  dragSrcIdx = null;
}

function renderSubjects() {
  renderConstantManage();
  renderFacultySubjects();
  const list = document.getElementById('subjects-list');
  if (!state.subjects.length) {
    list.innerHTML = `<div class="empty-state"><p>📚</p><p>Nenhuma matéria ainda</p></div>`; return;
  }
  list.innerHTML = state.subjects.map((subj, i) => {
    const name    = sName(subj);
    const goal    = sGoal(subj);
    const isCurrent = i === state.currentIndex;
    const dnd = isTouchDevice ? '' : `draggable="true" ondragstart="onDragStart(event,${i})" ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event,${i})" ondragend="onDragEnd(event)"`;
    return `<div class="subject-item ${isCurrent?'current-subject':''}" id="subject-item-${i}" ${dnd}>
      ${!isTouchDevice ? '<span class="drag-handle" title="Arrastar">⠿</span>' : ''}
      <span class="subject-order">${i+1}</span>
      <span class="subject-item-name">${name}</span>
      ${isCurrent ? '<span class="current-badge">atual</span>' : ''}
      <input type="number" class="goal-input" min="0" max="720" placeholder="meta min" value="${goal||''}"
        title="Meta diária em minutos"
        onchange="setSubjectGoal(${i},this.value)" onclick="event.stopPropagation()">
      <div class="move-btns">
        ${isTouchDevice ? `<button class="icon-btn" onclick="moveSubject(${i},-1)" ${i===0?'disabled':''}>↑</button><button class="icon-btn" onclick="moveSubject(${i},1)" ${i===state.subjects.length-1?'disabled':''}>↓</button>` : ''}
        <button class="icon-btn edit" onclick="editSubject(${i})" title="Renomear">✎</button>
        <button class="icon-btn del"  onclick="removeSubject(${i})" title="Remover">×</button>
      </div>
    </div>`;
  }).join('');
  const subjView = document.getElementById('view-subjects')
  if (subjView && !subjView.querySelector('.view-spacer')) subjView.insertAdjacentHTML('beforeend', '<div class="view-spacer" style="height:80px"></div>')
}

// ── HISTORY ──
let histState = { tab: 'sessions', period: 'all', subject: '', sort: 'recent' };
let _sessId = 0;

function getTodayStart()  { const d = new Date(); d.setHours(0,0,0,0); return d; }
function getWeekStart()   { const d = new Date(); const day = d.getDay(); d.setDate(d.getDate() - (day===0?6:day-1)); d.setHours(0,0,0,0); return d; }
function getMonthStart()  { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; }

function calcStreak() {
  if (!state.sessions.length) return 0;
  const days = new Set(state.sessions.map(s => new Date(s.end).toDateString()));
  const cursor = new Date(); cursor.setHours(0,0,0,0);
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate()-1);
  let streak = 0;
  while (days.has(cursor.toDateString())) { streak++; cursor.setDate(cursor.getDate()-1); }
  return streak;
}

function getFilteredSessions() {
  let sessions = [...state.sessions];
  if (histState.period === 'today')  { const s = getTodayStart();  sessions = sessions.filter(x => new Date(x.end) >= s); }
  else if (histState.period === 'week')  { const s = getWeekStart();   sessions = sessions.filter(x => new Date(x.end) >= s); }
  else if (histState.period === 'month') { const s = getMonthStart();  sessions = sessions.filter(x => new Date(x.end) >= s); }
  if (histState.subject) sessions = sessions.filter(x => x.subject === histState.subject);
  if (histState.sort === 'recent')  sessions.sort((a,b) => new Date(b.end) - new Date(a.end));
  else if (histState.sort === 'longest') sessions.sort((a,b) => b.duration - a.duration);
  else if (histState.sort === 'subject') sessions.sort((a,b) => a.subject.localeCompare(b.subject));
  return sessions;
}

function groupByDay(sessions) {
  const map = new Map();
  sessions.forEach(s => { const k = new Date(s.end).toDateString(); if (!map.has(k)) map.set(k,[]); map.get(k).push(s); });
  return [...map.entries()].map(([date, sessions]) => ({ date, sessions }));
}

function getSubjectStats() {
  const stats = {};
  const ws = getWeekStart(), ms = getMonthStart(), ts = getTodayStart();
  state.sessions.forEach(s => {
    if (!stats[s.subject]) stats[s.subject] = { total:0, week:0, month:0, today:0, days: new Set() };
    const end = new Date(s.end);
    stats[s.subject].total += s.duration; stats[s.subject].days.add(end.toDateString());
    if (end >= ws) stats[s.subject].week  += s.duration;
    if (end >= ms) stats[s.subject].month += s.duration;
    if (end >= ts) stats[s.subject].today += s.duration;
  });
  return Object.entries(stats).map(([name,d]) => ({ name, total:d.total, week:d.week, month:d.month, today:d.today, days:d.days.size })).sort((a,b) => b.total - a.total);
}

function buildConsistencyGraph() {
  const graphEl = document.getElementById('consistency-graph');
  const subEl   = document.getElementById('consistency-sub');
  if (!graphEl) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build daily map: YYYY-MM-DD → total seconds
  const dailyMap = {};
  state.sessions.forEach(s => {
    const d = new Date(s.end);
    const key = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    dailyMap[key] = (dailyMap[key] || 0) + s.duration;
  });

  // 364-day range
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 363);

  // Grid starts on the Sunday on or before startDate
  const gridStart = new Date(startDate);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  // Count active days in range
  let activeDays = 0;
  for (const [key, secs] of Object.entries(dailyMap)) {
    const d = new Date(key);
    if (d >= startDate && d <= today && secs > 0) activeDays++;
  }
  if (subEl) subEl.textContent = `${activeDays} dia${activeDays !== 1 ? 's' : ''} estudados no último ano`;

  const COLORS = [
    'var(--surface3)',
    'color-mix(in srgb, var(--accent) 20%, transparent)',
    'color-mix(in srgb, var(--accent) 40%, transparent)',
    'color-mix(in srgb, var(--accent) 65%, transparent)',
    'var(--accent)',
  ];
  const MONTH_NAMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const DAY_LABELS  = ['Dom', '', 'Ter', '', 'Qui', '', 'Sab'];

  // Generate week columns
  const weeks = [];
  const cursor = new Date(gridStart);
  while (cursor <= today) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(cursor);
      day.setDate(day.getDate() + d);
      if (day < startDate || day > today) {
        week.push({ date: day, secs: 0, level: -1 });
      } else {
        const key = day.getFullYear() + '-' +
          String(day.getMonth() + 1).padStart(2, '0') + '-' +
          String(day.getDate()).padStart(2, '0');
        const secs = dailyMap[key] || 0;
        const h = secs / 3600;
        const level = h === 0 ? 0 : h <= 1 ? 1 : h <= 2 ? 2 : h <= 4 ? 3 : 4;
        week.push({ date: day, secs, level });
      }
    }
    weeks.push(week);
    cursor.setDate(cursor.getDate() + 7);
  }

  // Month label for each column
  const monthLabels = weeks.map((week, wi) => {
    const firstReal = week.find(c => c.level !== -1);
    if (!firstReal) return '';
    const m = firstReal.date.getMonth();
    if (wi === 0) return MONTH_NAMES[m];
    for (let pi = wi - 1; pi >= 0; pi--) {
      const prevReal = weeks[pi].find(c => c.level !== -1);
      if (prevReal) return prevReal.date.getMonth() !== m ? MONTH_NAMES[m] : '';
    }
    return MONTH_NAMES[m];
  });

  // Tooltip formatter
  const fmtTip = (day, secs) => {
    const dd = String(day.getDate()).padStart(2, '0');
    const mm = String(day.getMonth() + 1).padStart(2, '0');
    const yy = day.getFullYear();
    if (!secs) return `${dd}/${mm}/${yy} — Nenhum estudo`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h === 0) parts.push(`${m}min`);
    return `${dd}/${mm}/${yy} — ${parts.join(' ')} estudados`;
  };

  // Build HTML
  let html = '<div class="cg-wrap"><div class="cg-body">';

  // Day labels column
  html += '<div class="cg-day-labels">';
  DAY_LABELS.forEach(l => { html += `<div class="cg-day-label">${l}</div>`; });
  html += '</div>';

  // Weeks area (month row + cell grid)
  html += '<div class="cg-weeks-area">';

  html += '<div class="cg-months-row">';
  weeks.forEach((_, wi) => { html += `<div class="cg-month-slot">${monthLabels[wi]}</div>`; });
  html += '</div>';

  html += '<div class="cg-grid">';
  weeks.forEach(week => {
    html += '<div class="cg-col">';
    week.forEach(cell => {
      if (cell.level === -1) {
        html += '<div class="cg-cell" style="background:transparent;pointer-events:none"></div>';
      } else {
        const tip = fmtTip(cell.date, cell.secs).replace(/"/g, '&quot;');
        html += `<div class="cg-cell" style="background:${COLORS[cell.level]}" title="${tip}"></div>`;
      }
    });
    html += '</div>';
  });
  html += '</div>'; // cg-grid
  html += '</div>'; // cg-weeks-area
  html += '</div>'; // cg-body

  // Legend
  html += '<div class="cg-legend">';
  html += '<span class="cg-legend-label">Menos</span>';
  COLORS.forEach(c => { html += `<div class="cg-cell" style="background:${c}"></div>`; });
  html += '<span class="cg-legend-label">Mais</span>';
  html += '</div>';

  html += '</div>'; // cg-wrap
  graphEl.innerHTML = html;
}

function renderHistory() {
  buildConsistencyGraph(); renderHistSummary(); updateHistSubjectFilter();
  histState.tab === 'sessions' ? renderHistSessions() : renderHistSubjects();
  const histView = document.getElementById('view-history')
  if (histView && !histView.querySelector('.view-spacer')) histView.insertAdjacentHTML('beforeend', '<div class="view-spacer" style="height:80px"></div>')
}

function renderHistSummary() {
  const ts = getTodayStart(), ws = getWeekStart(), ms = getMonthStart();
  let today=0, week=0, month=0;
  state.sessions.forEach(s => { const e = new Date(s.end); if (e>=ts) today+=s.duration; if (e>=ws) week+=s.duration; if (e>=ms) month+=s.duration; });
  const streak = calcStreak();
  document.getElementById('hist-summary').innerHTML = `
    <div class="hist-stat"><div class="hist-stat-label">Hoje</div><div class="hist-stat-value accent">${today?formatShort(today):'—'}</div></div>
    <div class="hist-stat"><div class="hist-stat-label">Semana</div><div class="hist-stat-value">${week?formatShort(week):'—'}</div></div>
    <div class="hist-stat"><div class="hist-stat-label">Mês</div><div class="hist-stat-value">${month?formatShort(month):'—'}</div></div>
    <div class="hist-stat"><div class="hist-stat-label">Sequência</div><div class="hist-stat-value streak">${streak?streak+(streak===1?' dia':' dias'):'—'}</div></div>`;
}

function updateHistSubjectFilter() {
  const sel = document.getElementById('hist-subject-filter');
  if (!sel) return;
  const subjects = [...new Set(state.sessions.map(s => s.subject))].sort();
  sel.innerHTML = '<option value="">Todas matérias</option>' + subjects.map(s => `<option value="${s}"${histState.subject===s?' selected':''}>${s}</option>`).join('');
}

function switchHistTab(tab) {
  histState.tab = tab;
  document.querySelectorAll('.hist-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('hist-tab-sessions').style.display = tab==='sessions' ? '' : 'none';
  document.getElementById('hist-tab-subjects').style.display = tab==='subjects' ? '' : 'none';
  tab === 'sessions' ? renderHistSessions() : renderHistSubjects();
}

function setHistPeriod(period) {
  histState.period = period;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  renderHistSessions();
}

function renderHistSessions() {
  histState.subject = document.getElementById('hist-subject-filter')?.value ?? '';
  histState.sort    = document.getElementById('hist-sort')?.value ?? 'recent';
  _sessId = 0;
  const sessions     = getFilteredSessions();
  const list         = document.getElementById('hist-sessions-list');
  const showResume   = histState.period === 'today';
  if (!sessions.length) { list.innerHTML = '<div class="empty-state"><p>🕐</p><p>Nenhuma sessão encontrada</p></div>'; return; }
  list.innerHTML = groupByDay(sessions).map(g => renderDayGroup(g, showResume)).join('');
}

function renderDayGroup(group, showResume) {
  const d = new Date(group.date), today = getTodayStart();
  const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
  let label;
  if (d.toDateString() === today.toDateString()) label = 'Hoje';
  else if (d.toDateString() === yesterday.toDateString()) label = 'Ontem';
  else label = d.toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short' });
  const total = group.sessions.reduce((a,s) => a+s.duration, 0);
  return `<div class="day-group"><div class="day-group-header"><span class="day-group-label">${label}</span><div class="day-group-line"></div><span class="day-group-total">${formatShort(total)}</span></div>${group.sessions.map(s => renderSessionItem(s, showResume)).join('')}</div>`;
}

function renderSessionItem(s, showResume) {
  const id       = 'sess-' + (_sessId++);
  const sessIdx  = state.sessions.indexOf(s);
  const endDate  = new Date(s.end);
  const endStr   = endDate.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  const startStr = s.start ? new Date(s.start).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }) : null;
  const timeRange = startStr ? `${startStr} – ${endStr}` : endStr;
  const safeSubj = s.subject.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const resumeBtn = showResume
    ? `<button class="hist-action-btn resume" onclick="event.stopPropagation();resumeSubject('${safeSubj}')" title="Estudar mais">+ estudar</button>`
    : '';
  return `<div class="hist-session" id="${id}">
    <div class="hist-session-row" onclick="toggleSession('${id}')">
      <div class="hist-session-dot" style="background:${subjectColor(s.subject)}"></div>
      <span class="hist-session-subject">${s.subject}</span>
      <span class="hist-session-time">${timeRange}</span>
      ${resumeBtn}
      <span class="hist-session-dur">${formatShort(s.duration)}</span>
      <span class="hist-session-chevron">▾</span>
    </div>
    <div class="hist-session-detail">
      <div class="hist-detail-row">
        ${startStr ? `<div class="hist-detail-item"><span class="hist-detail-label">Início</span><span class="hist-detail-value">${new Date(s.start).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div>` : ''}
        <div class="hist-detail-item"><span class="hist-detail-label">Fim</span><span class="hist-detail-value">${new Date(s.end).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div>
        <div class="hist-detail-item"><span class="hist-detail-label">Estudo</span><span class="hist-detail-value">${formatTime(s.duration)}</span></div>
        ${s.pauseDuration > 0 ? `<div class="hist-detail-item"><span class="hist-detail-label">Pausa</span><span class="hist-detail-value" style="color:var(--orange)">${formatTime(s.pauseDuration)}</span></div>` : ''}
      </div>
      <div class="hist-detail-actions">
        <button class="hist-action-btn edit" onclick="openSessionEdit('${id}',${sessIdx})">Editar</button>
        <button class="hist-action-btn del"  onclick="deleteSession(${sessIdx})">Excluir</button>
      </div>
    </div>
  </div>`;
}

function toggleSession(id) { document.getElementById(id)?.classList.toggle('open'); }

// ── RESUME SUBJECT ──
function resumeSubject(subjectName) {
  if (timerRunning || timerSeconds > 0) { showToast('Pare o timer atual primeiro', 'info'); return; }
  if (state.constantSubjects.includes(subjectName)) {
    studyingConstant = subjectName;
    showView('dashboard');
    showToast(`Retomando ${subjectName}`);
    return;
  }
  const idx = state.subjects.findIndex(s => sName(s) === subjectName);
  if (idx !== -1) {
    state.currentIndex = idx; studyingConstant = null; save();
  } else {
    studyingConstant = subjectName; // subject removed from cycle — treat as temp constant
  }
  showView('dashboard');
  showToast(`Retomando ${subjectName}`);
}

// ── SESSION EDIT ──
function openSessionEdit(domId, sessIdx) {
  const s = state.sessions[sessIdx];
  if (!s) return;
  const container = document.getElementById(domId);
  if (!container) return;
  const existing = container.querySelector('.hist-edit-form');
  if (existing) { existing.remove(); return; }

  const fmtLocal = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '';
  const durMins = Math.round(s.duration / 60);

  const form = document.createElement('div');
  form.className = 'hist-edit-form';
  form.innerHTML = `
    <div class="hist-edit-grid">
      <div class="hist-edit-field"><label class="hist-edit-label">Matéria</label><input class="hist-edit-input" id="hed-subj-${sessIdx}" value="${s.subject.replace(/"/g,'&quot;')}"></div>
      <div class="hist-edit-field"><label class="hist-edit-label">Duração (min)</label><input class="hist-edit-input" type="number" id="hed-dur-${sessIdx}" value="${durMins}" min="1"></div>
      <div class="hist-edit-field"><label class="hist-edit-label">Início (HH:MM)</label><input class="hist-edit-input" id="hed-start-${sessIdx}" value="${fmtLocal(s.start)}" placeholder="--:--"></div>
      <div class="hist-edit-field"><label class="hist-edit-label">Fim (HH:MM)</label><input class="hist-edit-input" id="hed-end-${sessIdx}" value="${fmtLocal(s.end)}" placeholder="--:--"></div>
    </div>
    <div class="hist-edit-actions">
      <button class="hist-edit-btn save" onclick="saveSessionEdit(${sessIdx})">Salvar</button>
      <button class="hist-edit-btn" onclick="this.closest('.hist-edit-form').remove()">Cancelar</button>
    </div>`;
  container.querySelector('.hist-session-detail').appendChild(form);
}

function saveSessionEdit(sessIdx) {
  const s = state.sessions[sessIdx];
  if (!s) return;
  const newSubj = document.getElementById(`hed-subj-${sessIdx}`)?.value.trim();
  const newDur  = parseInt(document.getElementById(`hed-dur-${sessIdx}`)?.value) || 0;
  const newStartStr = document.getElementById(`hed-start-${sessIdx}`)?.value.trim();
  const newEndStr   = document.getElementById(`hed-end-${sessIdx}`)?.value.trim();
  if (!newSubj || newDur < 1) { showToast('Dados inválidos', 'error'); return; }
  s.subject  = newSubj;
  s.duration = newDur * 60;
  const refDate = new Date(s.end).toDateString();
  if (/^\d{2}:\d{2}$/.test(newStartStr)) s.start = new Date(refDate + ' ' + newStartStr).toISOString();
  if (/^\d{2}:\d{2}$/.test(newEndStr))   s.end   = new Date(refDate + ' ' + newEndStr).toISOString();
  save(); renderHistory(); renderDashboard();
  showToast('Sessão editada', 'success');
}

function deleteSession(sessIdx) {
  const s = state.sessions[sessIdx];
  if (!s) return;
  showModal({
    icon: '🗑️', title: 'Excluir sessão',
    desc: `Excluir sessão de <strong>${s.subject}</strong> (${formatShort(s.duration)})?`,
    confirmLabel: 'Excluir',
    onConfirm: () => { state.sessions.splice(sessIdx,1); save(); renderHistory(); renderDashboard(); showToast('Sessão excluída', 'success'); }
  });
}

function renderHistSubjects() {
  const stats = getSubjectStats();
  const list  = document.getElementById('hist-subjects-list');
  if (!stats.length) { list.innerHTML = '<div class="empty-state"><p>📊</p><p>Nenhum dado ainda</p></div>'; return; }
  const maxTotal = stats[0].total || 1;
  list.innerHTML = stats.map(s => `
    <div class="subj-stat">
      <div class="subj-stat-header"><span class="subj-stat-name">${s.name}</span><span class="subj-stat-total">${formatShort(s.total)}</span></div>
      <div class="subj-stat-meta">
        <div class="subj-meta-item"><span class="subj-meta-label">Semana</span><span class="subj-meta-value">${s.week?formatShort(s.week):'—'}</span></div>
        <div class="subj-meta-item"><span class="subj-meta-label">Mês</span><span class="subj-meta-value">${s.month?formatShort(s.month):'—'}</span></div>
        <div class="subj-meta-item"><span class="subj-meta-label">Dias estudados</span><span class="subj-meta-value">${s.days}</span></div>
      </div>
      <div class="subj-bar-wrap"><div class="subj-bar" style="width:${Math.round(s.total/maxTotal*100)}%;background:${subjectColor(s.name)}"></div></div>
    </div>`).join('');
}

function clearHistory() {
  if (!state.sessions.length) return;
  showModal({ icon:'🗑️', title:'Limpar histórico', desc:`Isso vai apagar <strong>${state.sessions.length} sessão(ões)</strong> permanentemente. Tem certeza?`, confirmLabel:'Limpar tudo',
    onConfirm: () => { state.sessions=[]; save(); renderHistory(); renderDashboard(); showToast('Histórico limpo', 'success'); }
  });
}

// ── EXPORT CSV ──
function exportCSV() {
  const sessions = getFilteredSessions();
  if (!sessions.length) { showToast('Nenhuma sessão para exportar', 'info'); return; }
  const fmtDate = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  const rows = ['Matéria,Início,Fim,Duração (min),Pausa (min)'];
  sessions.forEach(s => rows.push([
    `"${(s.subject||'').replace(/"/g,'""')}"`,
    `"${fmtDate(s.start)}"`,
    `"${fmtDate(s.end)}"`,
    Math.round(s.duration/60),
    Math.round((s.pauseDuration||0)/60)
  ].join(',')));
  const blob = new Blob(['﻿'+rows.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `ciclo-estudos-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast(`${sessions.length} sessões exportadas`, 'success');
}

// ── AI RECOMMENDATION ──
async function fetchCalendarEvents() {
  try {
    const res = await fetch(`${API_URL}/api/calendar/events?userId=${USER_ID}`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function getAIRecommendation() {
  const todayStr = new Date().toDateString();
  const sessionsToday = state.sessions
    .filter(s => new Date(s.end).toDateString() === todayStr)
    .map(s => ({
      subject: s.subject,
      duration: s.duration,
      start: s.start
        ? new Date(s.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '—',
      end: new Date(s.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    }));

  const subjects = state.subjects.map(s => ({
    name: sName(s),
    weeklyGoalMinutes: sGoal(s),
  }));

  const calendarEvents = await fetchCalendarEvents()

  try {
    const onSlow = () => {
      const el = document.getElementById('ai-result')
      if (el) { el.style.display = ''; el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Conectando ao servidor, aguarde...</p>' }
    }
    const res = await fetchWithTimeout(`${API_URL}/api/recommendation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentHour: new Date().getHours(),
        sessionsToday,
        subjects,
        calendarEvents,
      }),
    }, 35000, onSlow)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function renderAICard(cardState) {
  const btn    = document.getElementById('ai-btn');
  const result = document.getElementById('ai-result');
  if (!btn || !result) return;

  if (cardState === 'idle') {
    btn.textContent = 'O que estudar agora?';
    btn.disabled = false;
    result.style.display = 'none';
  } else if (cardState === 'loading') {
    btn.textContent = 'Consultando IA...';
    btn.disabled = true;
    result.style.display = '';
    result.innerHTML = `
      <div class="skeleton-block" style="height:18px;width:60%;margin-bottom:8px;border-radius:4px"></div>
      <div class="skeleton-block" style="height:12px;width:90%;margin-bottom:6px;border-radius:4px"></div>
      <div class="skeleton-block" style="height:12px;width:75%;border-radius:4px"></div>`;
  } else if (cardState === 'error') {
    btn.textContent = 'Tentar novamente';
    btn.disabled = false;
    result.style.display = '';
    result.innerHTML = '<p style="font-size:12px;color:var(--danger)">Não foi possível obter recomendação. Tente novamente.</p>';
  } else if (cardState?.recommendation) {
    btn.textContent = 'Atualizar';
    btn.disabled = false;
    result.style.display = '';
    result.innerHTML = `
      <p style="font-size:15px;font-weight:600;color:var(--text);line-height:1.6;margin-bottom:8px">${cardState.recommendation}</p>
      <button onclick="toggleAIReasoning(this)" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0">ver raciocínio ▾</button>
      <p id="ai-reasoning" style="display:none;font-size:13px;color:var(--text-muted);line-height:1.6;margin-top:8px">${cardState.reasoning}</p>`;
  }
}

function toggleAIReasoning(btn) {
  const p = document.getElementById('ai-reasoning');
  if (!p) return;
  const expanded = p.style.display !== 'none';
  p.style.display = expanded ? 'none' : '';
  btn.textContent = expanded ? 'ver raciocínio ▾' : 'ocultar ▴';
}

async function handleAIRecommendation() {
  if (!state.subjects.length) {
    const resultEl = document.getElementById('ai-result')
    const btn = document.getElementById('ai-btn')
    if (resultEl) {
      resultEl.style.display = ''
      resultEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Cadastre suas matérias primeiro para receber recomendações.</p>'
    }
    if (btn) { btn.textContent = 'O que estudar agora?'; btn.disabled = false }
    return
  }
  renderAICard('loading')
  const data = await getAIRecommendation()
  renderAICard(data ?? 'error')
}

// ── DEVICE SYNC ──
function updateUserIdDisplay() {
  const el = document.getElementById('user-id-display')
  if (!el) return
  el.textContent = USER_ID ? USER_ID.slice(0, 8) + '...' : '—'
}

function copyUserId() {
  if (!USER_ID) { showToast('Nenhum ID disponível', 'error'); return; }
  navigator.clipboard.writeText(USER_ID)
    .then(() => showToast('ID copiado!', 'success'))
    .catch(() => {
      const el = document.createElement('textarea')
      el.value = USER_ID
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      showToast('ID copiado!', 'success')
    })
}

function applyUserId() {
  const input = document.getElementById('sync-id-input')
  const novoId = input.value.trim()
  if (!novoId) { showToast('Cole um ID válido', 'error'); return; }
  localStorage.setItem('ciclo-user-id', novoId)
  USER_ID = novoId
  input.value = ''
  initSync().then(() => {
    updateUserIdDisplay()
    renderDashboard()
    showToast('Dispositivo sincronizado!', 'success')
  })
}

// ── CALENDAR AUTH ──
function onCalIconClick() {
  const btn = document.getElementById('cal-icon-btn')
  if (btn && btn.classList.contains('cal-connected')) {
    showToast('Google Calendar conectado ✓', 'success')
  } else {
    window.open(`${API_URL}/auth/google`, '_blank')
  }
}

async function checkCalendarAuth() {
  const btn = document.getElementById('cal-icon-btn')
  if (!btn) return
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/calendar/status`)
    let authenticated = false
    try {
      const data = await res.json()
      authenticated = data.authenticated === true
    } catch { /* non-JSON body — treat as unauthenticated */ }

    if (authenticated) {
      btn.classList.add('cal-connected')
      btn.classList.remove('cal-disconnected')
    } else {
      btn.classList.add('cal-disconnected')
      btn.classList.remove('cal-connected')
    }
  } catch {
    btn.classList.add('cal-disconnected')
    btn.classList.remove('cal-connected')
  }
}

// ── THEME COLOR ──
function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', color)
  localStorage.setItem('ciclo-accent-color', color)
  const picker = document.getElementById('theme-color-input')
  if (picker) picker.value = color
}

function toggleThemePopover(e) {
  e.stopPropagation()
  const p = document.getElementById('theme-popover')
  if (!p) return
  p.classList.toggle('open')
}

document.addEventListener('click', (e) => {
  const p = document.getElementById('theme-popover')
  if (p && p.classList.contains('open') && !p.contains(e.target)) {
    p.classList.remove('open')
  }
})

// ── EXAM PLAN ──
async function handleExamPlan() {
  const btn = document.getElementById('exam-btn');
  const result = document.getElementById('exam-result');
  const subject = document.getElementById('exam-subject')?.value.trim();
  const examDate = document.getElementById('exam-date')?.value;
  const topicsRaw = document.getElementById('exam-topics')?.value ?? '';
  const hours = parseFloat(document.getElementById('exam-hours')?.value);

  const topics = topicsRaw.split('\n').map(t => t.trim()).filter(Boolean);

  if (!subject || !examDate || !topics.length || !hours || hours < 0.5) {
    result.style.display = '';
    result.innerHTML = '<p style="font-size:12px;color:var(--danger)">Preencha todos os campos corretamente.</p>';
    return;
  }

  if (btn) { btn.textContent = 'Planejando...'; btn.disabled = true; }
  result.style.display = 'none';

  try {
    const onSlow = () => {
      result.style.display = ''
      result.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Conectando ao servidor, aguarde...</p>'
    }
    const res = await fetchWithTimeout(`${API_URL}/api/exam/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject,
        examDate: new Date(examDate + 'T23:59:59').toISOString(),
        topics,
        estimatedHoursTotal: hours,
      }),
    }, 35000, onSlow)

    const data = await res.json()

    result.style.display = ''
    if (!res.ok) {
      if (data.error === 'NOT_AUTHENTICATED') {
        result.innerHTML = '<p style="font-size:12px;color:var(--orange)">Conecte o Google Calendar primeiro.</p>'
      } else {
        result.innerHTML = '<p style="font-size:12px;color:var(--danger)">Erro ao gerar plano. Tente novamente.</p>'
      }
    } else {
      result.innerHTML = `
        <p style="font-size:13px;color:var(--green);margin-bottom:6px">${data.blocksCreated} bloco(s) criado(s) no seu Calendar.</p>
        <p style="font-size:12px;color:var(--text-muted);line-height:1.5">${data.summary}</p>`;
      document.getElementById('exam-subject').value = '';
      document.getElementById('exam-date').value = '';
      document.getElementById('exam-topics').value = '';
      document.getElementById('exam-hours').value = '';
    }
  } catch {
    result.style.display = '';
    result.innerHTML = '<p style="font-size:12px;color:var(--danger)">Não foi possível conectar ao servidor.</p>';
  } finally {
    if (btn) { btn.textContent = 'Gerar plano'; btn.disabled = false; }
  }
}

// ── VIEWS ──
const viewMeta = {
  dashboard: ['dashboard', 'bem-vindo de volta'],
  subjects:  ['matérias', 'gerencie seu ciclo'],
  history:   ['histórico', 'progresso de estudos'],
  planning:  ['planejamento', 'provas e prazos'],
  progress:  ['progresso', 'sua semana'],
};

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  const allIcons = [...document.querySelectorAll('.left-sidebar .nav-icon'), ...document.querySelectorAll('.mobile-nav .nav-icon')];
  const map = { dashboard:0, subjects:1, history:2, planning:3, progress:4 };
  allIcons.forEach((b,i) => b.classList.toggle('active', i%5 === map[name]));
  const [title, sub] = viewMeta[name] || ['',''];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-sub').textContent = name === 'dashboard' ? getDashGreeting() : sub;
  if (name === 'subjects')  { renderSubjects(); updateUserIdDisplay(); }
  if (name === 'history')   renderHistory();
  if (name === 'dashboard') renderDashboard();
  if (name === 'progress')  renderProgress();
  if (name === 'planning')  loadPlanning();
}

// ── PLANNING VIEW ──
// ── PLANNING HELPERS ──────────────────────────────────────────────────────────

function planUrgencyInfo(level) {
  const map = {
    critical: ['CRÍTICO', 'var(--red)'],
    high:     ['ALTO',    'var(--orange)'],
    medium:   ['MÉDIO',   'var(--accent)'],
    low:      ['BAIXO',   'var(--text-dim)'],
  }
  return map[level] ?? ['—', 'var(--text-dim)']
}
function planTopicIcon(s)  { return s === 'theory' ? '◑' : s === 'exercises' ? '●' : '○' }
function planTopicColor(s) { return s === 'theory' ? 'var(--accent)' : s === 'exercises' ? 'var(--green)' : 'var(--text-dim)' }
function planNextState(s)  { return s === 'pending' ? 'theory' : s === 'theory' ? 'exercises' : 'pending' }

// ── PLANNING ACTIONS ──────────────────────────────────────────────────────────

async function updatePriorities() {
  const el = document.getElementById('priorities-list')
  if (!el) return
  el.innerHTML = `
    <div class="skeleton-block" style="height:18px;width:60%;margin-bottom:8px;border-radius:4px"></div>
    <div class="skeleton-block" style="height:12px;width:90%;margin-bottom:6px;border-radius:4px"></div>
    <div class="skeleton-block" style="height:12px;width:75%;border-radius:4px"></div>`
  try {
    const subjects = state.subjects.map(s => ({ name: sName(s), weeklyGoalMinutes: sGoal(s) * 7 }))
    const res = await fetch(`${API_URL}/api/priorities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, subjects }),
    })
    if (!res.ok) throw new Error()
    const data = await res.json()
    planningPriorities = data.priorities ?? []
    el.innerHTML = planningPriorities.length
      ? planningPriorities.map(p => {
          const [lbl, col] = planUrgencyInfo(p.urgencyLevel)
          return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--surface3)">
            <span style="background:${col};color:#000;font-size:9px;font-family:monospace;font-weight:700;letter-spacing:1px;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:2px;white-space:nowrap">${lbl}</span>
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:2px">${p.subjectName}</div>
              <div style="font-size:12px;color:var(--text-muted);font-style:italic">${p.reason}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${p.pendingTopics} tópico${p.pendingTopics !== 1 ? 's' : ''} pendente${p.pendingTopics !== 1 ? 's' : ''}</div>
            </div>
          </div>`
        }).join('')
      : `<div style="color:var(--text-dim);text-align:center;font-size:12px;padding:16px 0">Nenhuma prioridade encontrada.</div>`
  } catch {
    el.innerHTML = `<div style="color:var(--danger);font-size:12px">Erro ao carregar. Tente novamente.</div>`
  }
}

function toggleTaskForm() {
  const f = document.getElementById('new-task-form')
  if (!f) return
  const open = f.style.display !== 'none'
  f.style.display = open ? 'none' : 'block'
  if (!open) {
    const sel = document.getElementById('task-subject-select')
    if (sel) {
      const ciclo = state.subjects.map(s =>
        `<option value="${sName(s).replace(/"/g,'&quot;')}">${sName(s)}</option>`).join('')
      const constantes = (state.constantSubjects || []).map(s =>
        `<option value="${s.replace(/"/g,'&quot;')}">${s}</option>`).join('')
      const faculdade = (state.facultySubjects || []).map(s =>
        `<option value="${s.name.replace(/"/g,'&quot;')}">${s.name}</option>`).join('')
      sel.innerHTML =
        '<option value="">Sem matéria vinculada</option>' +
        (ciclo      ? `<optgroup label="Ciclo">${ciclo}</optgroup>` : '') +
        (constantes ? `<optgroup label="Constantes">${constantes}</optgroup>` : '') +
        (faculdade  ? `<optgroup label="Faculdade">${faculdade}</optgroup>` : '')
    }
  }
}

async function createTask() {
  const title = (document.getElementById('task-title-input')?.value || '').trim()
  const subjectName = document.getElementById('task-subject-select')?.value || ''
  const raw = document.getElementById('task-topics-textarea')?.value || ''
  const topics = raw.split('\n').map(t => t.trim()).filter(Boolean)
  if (!title) { showToast('Preencha o título da tarefa', 'error'); return }
  try {
    const res = await fetch(`${API_URL}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, title, subjectName, topics }),
    })
    if (!res.ok) throw new Error()
    const task = await res.json()
    planningTasks.push(task)
    const list = document.getElementById('tasks-list')
    if (list) list.innerHTML = planningTasks.map(renderTaskCard).join('')
    toggleTaskForm()
  } catch { showToast('Erro ao criar tarefa', 'error') }
}

async function deleteTask(id) {
  try {
    await fetch(`${API_URL}/api/tasks/${id}`, { method: 'DELETE' })
    planningTasks = planningTasks.filter(t => t.id !== id)
    document.getElementById(`task-card-${id}`)?.remove()
    const list = document.getElementById('tasks-list')
    if (list && !list.querySelector('[id^="task-card-"]'))
      list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:12px 0">Nenhuma tarefa cadastrada</div>`
  } catch { showToast('Erro ao deletar tarefa', 'error') }
}

async function cycleTopicState(taskId, topicId) {
  const task = planningTasks.find(t => t.id === taskId)
  if (!task) return
  const topic = task.topics.find(tp => tp.id === topicId)
  if (!topic) return
  const next = planNextState(topic.state)
  topic.state = next
  const btn = document.getElementById(`topic-btn-${topicId}`)
  if (btn) {
    btn.textContent = planTopicIcon(next)
    btn.style.color = planTopicColor(next)
  }
  const allDone = task.topics.length > 0 && task.topics.every(tp => tp.state === 'exercises')
  const card = document.getElementById(`task-card-${taskId}`)
  if (card) card.style.borderColor = allDone ? 'var(--green)' : 'var(--surface4)'
  const badge = document.getElementById(`task-done-badge-${taskId}`)
  if (badge) badge.style.display = allDone ? '' : 'none'
  if (allDone) {
    const subjs = state.subjects
    const nextName = subjs.length > 0 ? sName(subjs[(state.currentIndex + 1) % subjs.length]) : ''
    showCompletionToast(nextName ? `✓ Tarefa concluída! Próxima matéria: ${nextName}` : '✓ Tarefa concluída!')
  }
  try {
    await fetch(`${API_URL}/api/tasks/${taskId}/topics/${topicId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: next }),
    })
  } catch { showToast('Erro ao salvar', 'error') }
}

function startReview(examId) {
  const exam = planningExams.find(e => e.id === examId)
  if (!exam) return
  const daysLeft = Math.ceil((new Date(exam.examDate) - new Date()) / (1000 * 60 * 60 * 24))
  activeTask = {
    id: 'review-' + exam.id,
    title: 'Revisão — ' + exam.subjectName,
    subjectName: exam.subjectName,
    totalTime: 0,
    topics: [],
    daysLeft,
  }
  const idx = state.subjects.findIndex(s => sName(s).toLowerCase().trim() === exam.subjectName.toLowerCase().trim())
  if (idx !== -1) { studyingConstant = null; state.currentIndex = idx }
  save()
  showView('dashboard')
}

function startTask(taskId, subjectName) {
  const task = planningTasks.find(t => t.id === taskId)
  if (!task) return
  activeTask = task
  if (subjectName) {
    const idx = state.subjects.findIndex(s =>
      sName(s).toLowerCase().trim() === subjectName.toLowerCase().trim())
    if (idx >= 0) { studyingConstant = null; state.currentIndex = idx }
  }
  save()
  showView('dashboard')
}

function toggleExamForm() {
  const f = document.getElementById('new-exam-form')
  if (f) f.style.display = f.style.display !== 'none' ? 'none' : 'block'
}

async function createExam() {
  const subjectName = (document.getElementById('exam-new-subject')?.value || '').trim()
  const examDateInput = document.getElementById('exam-new-date')?.value || ''
  const notes = (document.getElementById('exam-new-notes')?.value || '').trim() || undefined
  if (!subjectName || !examDateInput) { showToast('Preencha matéria e data', 'error'); return }
  const examDate = new Date(examDateInput).toISOString()

  async function doPost() {
    return fetch(`${API_URL}/api/exams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, subjectName, examDate, notes }),
    })
  }

  try {
    await ensureUser()
    let res = await doPost()

    if (res.status === 404) {
      const err = await res.json().catch(() => ({}))
      if (err.error === 'USER_NOT_FOUND') {
        USER_ID = null
        localStorage.removeItem('ciclo-user-id')
        await initSync()
        if (!USER_ID) { showToast('Sem conexão com o servidor', 'error'); return }
        res = await doPost()
      }
    }

    if (!res.ok) { showToast('Erro ao criar prova', 'error'); return }

    const exam = await res.json()
    planningExams.push(exam)
    planningExams.sort((a, b) => new Date(a.examDate) - new Date(b.examDate))
    const list = document.getElementById('exams-list')
    if (list) list.innerHTML = planningExams.map(renderExamCard).join('')
    toggleExamForm()
    showToast('Prova adicionada', 'success')
  } catch {
    showToast('Erro ao criar prova', 'error')
  }
}

async function deleteExam(id) {
  if (!USER_ID) { showToast('Configure seu ID de usuário nas configurações', 'info'); return }
  try {
    await fetch(`${API_URL}/api/exams/${id}`, { method: 'DELETE' })
    planningExams = planningExams.filter(e => e.id !== id)
    document.getElementById(`exam-card-${id}`)?.remove()
    const list = document.getElementById('exams-list')
    if (list && !list.querySelector('[id^="exam-card-"]'))
      list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:12px 0">Nenhuma prova cadastrada</div>`
  } catch { showToast('Erro ao deletar prova', 'error') }
}


// ── CARD RENDERERS ────────────────────────────────────────────────────────────

function renderTaskCard(task) {
  const allDone = task.topics.length > 0 && task.topics.every(tp => tp.state === 'exercises')
  const subColor = subjectColor(task.subjectName)
  const safe = task.subjectName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const topics = task.topics.map(tp =>
    `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
      <button id="topic-btn-${tp.id}" onclick="cycleTopicState('${task.id}','${tp.id}')"
        style="background:none;border:none;cursor:pointer;font-size:15px;color:${planTopicColor(tp.state)};padding:0;line-height:1;flex-shrink:0">${planTopicIcon(tp.state)}</button>
      <span style="font-size:13px;color:var(--text-muted)">${tp.text}</span>
    </div>`
  ).join('')
  return `<div id="task-card-${task.id}" style="background:var(--surface3);border:1px solid ${allDone ? 'var(--green)' : 'var(--surface4)'};border-radius:8px;padding:14px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:${task.topics.length ? '10px' : '4px'}">
      <span style="font-size:13px;font-weight:600;color:var(--text);flex:1;min-width:0">${task.title}</span>
      <span id="task-done-badge-${task.id}" style="font-size:9px;font-family:monospace;color:var(--green);border:1px solid var(--green);padding:1px 5px;border-radius:4px;${allDone ? '' : 'display:none'}">CONCLUÍDA</span>
      <span style="font-size:10px;color:${subColor};background:${subColor}22;padding:2px 6px;border-radius:4px;flex-shrink:0">${task.subjectName}</span>
      ${task.totalTime > 0 ? `<span style="font-size:11px;color:var(--text-dim);flex-shrink:0">${fmtPlanSecs(task.totalTime)}</span>` : ''}
      <button onclick="deleteTask('${task.id}')" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:18px;padding:0;line-height:1" title="Deletar">×</button>
    </div>
    ${topics}
    <button onclick="startTask('${task.id}','${safe}')" style="margin-top:8px;padding:5px 12px;font-size:10px;font-family:monospace;letter-spacing:1px;font-weight:700;background:var(--accent);color:#000;border:none;border-radius:5px;cursor:pointer">▶ INICIAR</button>
  </div>`
}

function renderExamCard(exam) {
  const now = new Date()
  const examDateObj = new Date(exam.examDate)
  const daysUntil = Math.ceil((examDateObj - now) / 86400000)
  const dateStr = examDateObj.toLocaleDateString('pt-BR')
  const daysText = daysUntil > 0 ? `${daysUntil} dias` : daysUntil === 0 ? 'HOJE' : 'PASSOU'

  let barColor, barPct, daysColor
  if (daysUntil <= 0) {
    barColor = 'var(--text-dim)'; barPct = 100; daysColor = 'var(--text-dim)'
  } else if (daysUntil <= 7) {
    barColor = 'var(--red)'; barPct = 100; daysColor = 'var(--red)'
  } else if (daysUntil <= 14) {
    barColor = 'var(--orange)'; barPct = 65; daysColor = 'var(--orange)'
  } else if (daysUntil <= 30) {
    barColor = 'var(--orange)'; barPct = 35; daysColor = 'var(--text-muted)'
  } else {
    barColor = 'var(--green)'; barPct = 15; daysColor = 'var(--text-muted)'
  }

  const urgencyBar = daysUntil > 0 ? `
    <div style="margin-top:10px;height:3px;background:var(--surface4);border-radius:2px;overflow:hidden">
      <div style="height:100%;width:${barPct}%;background:${barColor};border-radius:2px;transition:width .3s"></div>
    </div>` : ''

  return `<div id="exam-card-${exam.id}" style="background:var(--surface3);border:1px solid var(--surface4);border-radius:8px;padding:14px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:13px;font-weight:600;color:var(--text);flex:1">${exam.subjectName}</span>
      <span style="font-size:12px;color:var(--text-muted)">${dateStr}</span>
      <span style="font-size:12px;font-weight:600;color:${daysColor}">${daysText}</span>
      <button onclick="startReview('${exam.id}')" style="background:var(--surface4);border:1px solid var(--surface3);color:var(--text-muted);padding:4px 10px;border-radius:5px;font-size:11px;cursor:pointer">▶ Revisar</button>
      <button onclick="deleteExam('${exam.id}')" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:18px;padding:0;line-height:1" title="Deletar">×</button>
    </div>
    ${urgencyBar}
  </div>`
}

// ── RENDER PLANNING ───────────────────────────────────────────────────────────

function renderPlanning() {
  const container = document.getElementById('view-planning')
  if (!container) return

  const S  = 'background:var(--surface2);border:1px solid var(--surface3);border-radius:10px;padding:20px'
  const LB = 'font-family:monospace;font-size:10px;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase'
  const SB = 'padding:6px 12px;font-size:11px;border-radius:6px;border:1px solid var(--surface4);background:var(--surface3);color:var(--text-muted);cursor:pointer'
  const IS = 'width:100%;background:var(--surface2);border:1px solid var(--surface4);color:var(--text);padding:8px 10px;border-radius:7px;font-size:13px;font-family:var(--sans);outline:none;margin-bottom:8px'

  const _ciclo = state.subjects.map(s =>
    `<option value="${sName(s).replace(/"/g,'&quot;')}">${sName(s)}</option>`).join('')
  const _constantes = (state.constantSubjects || []).map(s =>
    `<option value="${s.replace(/"/g,'&quot;')}">${s}</option>`).join('')
  const _faculdade = (state.facultySubjects || []).map(s =>
    `<option value="${s.name.replace(/"/g,'&quot;')}">${s.name}</option>`).join('')
  const subjectOptions =
    '<option value="">Sem matéria vinculada</option>' +
    (_ciclo      ? `<optgroup label="Ciclo">${_ciclo}</optgroup>` : '') +
    (_constantes ? `<optgroup label="Constantes">${_constantes}</optgroup>` : '') +
    (_faculdade  ? `<optgroup label="Faculdade">${_faculdade}</optgroup>` : '')

  const prioritiesInner = !planningPriorities.length
    ? `<div style="color:var(--text-dim);text-align:center;font-size:12px;padding:16px 0">Clique em "Atualizar prioridades" para ver suas prioridades</div>`
    : planningPriorities.map(p => {
        const [lbl, col] = planUrgencyInfo(p.urgencyLevel)
        return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--surface3)">
          <span style="background:${col};color:#000;font-size:9px;font-family:monospace;font-weight:700;letter-spacing:1px;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:2px;white-space:nowrap">${lbl}</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:2px">${p.subjectName}</div>
            <div style="font-size:12px;color:var(--text-muted);font-style:italic">${p.reason}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${p.pendingTopics} tópico${p.pendingTopics !== 1 ? 's' : ''} pendente${p.pendingTopics !== 1 ? 's' : ''}</div>
          </div>
        </div>`
      }).join('')

  const prioritiesSection = `<div style="${S}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <span style="${LB}">Prioridades</span>
      <button onclick="updatePriorities()" style="${SB}">Atualizar prioridades</button>
    </div>
    <div id="priorities-list">${prioritiesInner}</div>
  </div>`

  const tasksSection = `<div style="${S}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <span style="${LB}">Tarefas</span>
      <button onclick="toggleTaskForm()" style="${SB}">+ Nova tarefa</button>
    </div>
    <div id="new-task-form" style="display:none;background:var(--surface3);border-radius:8px;padding:14px;margin-bottom:14px">
      <input id="task-title-input" placeholder="Título da tarefa" style="${IS}">
      <select id="task-subject-select" style="${IS}">${subjectOptions}</select>
      <textarea id="task-topics-textarea" placeholder="Tópicos (um por linha)" rows="3" style="${IS}resize:vertical;"></textarea>
      <div style="display:flex;gap:8px">
        <button onclick="createTask()" style="${SB};background:var(--accent);color:#000;border-color:var(--accent)">Criar</button>
        <button onclick="toggleTaskForm()" style="${SB}">Cancelar</button>
      </div>
    </div>
    <div id="tasks-list">${planningTasks.length ? planningTasks.map(renderTaskCard).join('') : '<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:12px 0">Nenhuma tarefa cadastrada</div>'}</div>
  </div>`

  const examsSection = `<div style="${S}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <span style="${LB}">Provas</span>
      <button onclick="toggleExamForm()" style="${SB}">+ Adicionar prova</button>
    </div>
    <div id="new-exam-form" style="display:none;background:var(--surface3);border-radius:8px;padding:14px;margin-bottom:14px">
      <input id="exam-new-subject" placeholder="Nome da matéria" style="${IS}">
      <input id="exam-new-date" type="date" style="${IS}">
      <textarea id="exam-new-notes" placeholder="Notas opcionais" rows="2" style="${IS}resize:vertical;"></textarea>
      <div style="display:flex;gap:8px">
        <button onclick="createExam()" style="${SB};background:var(--accent);color:#000;border-color:var(--accent)">Salvar</button>
        <button onclick="toggleExamForm()" style="${SB}">Cancelar</button>
      </div>
    </div>
    <div id="exams-list">${planningExams.length ? planningExams.map(renderExamCard).join('') : '<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:12px 0">Nenhuma prova cadastrada</div>'}</div>
  </div>`

  container.innerHTML = `<div style="max-width:860px;margin:0 auto;padding:24px 24px;display:flex;flex-direction:column;gap:24px">
    ${prioritiesSection}
    ${tasksSection}
    ${examsSection}
    <div style="height:80px"></div>
  </div>`
}

async function loadPlanning() {
  if (!USER_ID) { renderPlanning(); return }
  const timeout = (ms) => new Promise((_, rej) =>
    setTimeout(() => rej(new Error('TIMEOUT')), ms))
  try {
    const [tRes, eRes] = await Promise.race([
      Promise.all([
        fetch(`${API_URL}/api/tasks?userId=${USER_ID}`),
        fetch(`${API_URL}/api/exams?userId=${USER_ID}`),
      ]),
      timeout(10000).then(() => { throw new Error('TIMEOUT') })
    ])
    if (tRes.ok) planningTasks = await tRes.json()
    if (eRes.ok) planningExams = await eRes.json()
  } catch (e) {
    if (e.message === 'TIMEOUT') {
      showToast('Servidor demorando — exibindo dados locais', 'info')
    }
  }
  renderPlanning()
}

// ── PROGRESS VIEW ──
async function renderProgress() {
  const container = document.getElementById('progress-content')
  if (!container) return

  container.innerHTML = `
    <div class="skeleton-block" style="height:18px;width:60%;margin-bottom:8px;border-radius:4px"></div>
    <div class="skeleton-block" style="height:12px;width:90%;margin-bottom:6px;border-radius:4px"></div>
    <div class="skeleton-block" style="height:12px;width:75%;border-radius:4px"></div>`

  if (!state.subjects.length) {
    container.innerHTML = '<p class="progress-error">Adicione matérias ao ciclo para ver o diagnóstico.</p>'
    return
  }

  const minsToStr = m => {
    const h = Math.floor(m / 60), r = m % 60
    return h > 0 ? `${h}h${r > 0 ? ` ${r}min` : ''}` : `${r}min`
  }

  try {
    const weekStart = getWeekStart()
    const sessionsThisWeek = state.sessions.filter(s => new Date(s.end) >= weekStart)
    const onSlow = () => {
      container.innerHTML = `
        <div class="skeleton-block" style="height:18px;width:60%;margin-bottom:8px;border-radius:4px"></div>
        <div class="skeleton-block" style="height:12px;width:90%;margin-bottom:6px;border-radius:4px"></div>
        <div class="skeleton-block" style="height:12px;width:75%;margin-bottom:12px;border-radius:4px"></div>
        <p class="progress-error">Conectando ao servidor, aguarde...</p>`
    }
    const res = await fetchWithTimeout(`${API_URL}/api/progress/diagnosis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjects: state.subjects.map(s => ({ name: sName(s), dailyGoal: sGoal(s) })),
        weekStart: weekStart.toISOString(),
        sessions: sessionsThisWeek,
      }),
    }, 35000, onSlow)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()

    const statusColor = {
      completed: 'var(--green)',
      on_track:  'var(--accent)',
      behind:    'var(--orange)',
      neglected: 'var(--red)',
    }

    const overallBadge = {
      on_track: { bg: 'var(--green-dim)',  color: 'var(--green)',  text: 'EM DIA' },
      behind:   { bg: 'var(--orange-dim)', color: 'var(--orange)', text: 'ATRASADO' },
      ahead:    { bg: 'var(--blue-dim)',   color: 'var(--accent)', text: 'ADIANTADO' },
    }[data.overallStatus] || { bg: 'var(--surface3)', color: 'var(--text-muted)', text: (data.overallStatus || '').replace('_', ' ') }

    const subjectsHTML = (data.subjects || []).map(s => {
      const pct = s.goalMinutes > 0 ? Math.min(100, Math.round(s.studiedMinutes / s.goalMinutes * 100)) : 0
      const barColor    = statusColor[s.status] || 'var(--text-dim)'
      const borderColor = statusColor[s.status] || 'var(--border)'
      const timeColor   = s.status === 'neglected' ? 'var(--red)' : s.status === 'completed' ? 'var(--green)' : 'var(--text-muted)'
      const timeLabel   = s.goalMinutes > 0
        ? `${minsToStr(s.studiedMinutes)} estudadas de ${minsToStr(s.goalMinutes)}`
        : `${minsToStr(s.studiedMinutes)} estudadas esta semana`
      return `
        <div class="progress-subject-card" style="border-left:3px solid ${borderColor};padding-left:12px">
          <div class="progress-subject-name">${s.name}</div>
          <div style="height:4px;background:var(--surface3);border-radius:2px;margin:8px 0;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width 0.6s ease"></div>
          </div>
          <div class="progress-time-label" style="color:${timeColor}">${timeLabel}</div>
          <div class="progress-recommendation">${s.recommendation}</div>
        </div>`
    }).join('')

    container.innerHTML = `
      <div class="progress-overall-card">
        <div class="progress-overall-top">
          <span style="background:${overallBadge.bg};color:${overallBadge.color};border-radius:4px;padding:3px 8px;font-size:10px;font-weight:600;font-family:var(--mono)">${overallBadge.text}</span>
        </div>
        <div class="progress-overall-msg">${data.overallMessage}</div>
        <div class="progress-priority">▶&nbsp;${data.priorityAction}</div>
      </div>
      ${subjectsHTML}
      <button class="progress-refresh-btn" onclick="renderProgress()">↺ Atualizar diagnóstico</button>
      <div class="view-spacer" style="height:80px"></div>`
  } catch {
    container.innerHTML = `
      <p class="progress-error" style="color:var(--danger)">Não foi possível carregar o diagnóstico. Tente novamente.</p>
      <button class="progress-refresh-btn" onclick="renderProgress()">↺ Tentar novamente</button>
      <div class="view-spacer" style="height:80px"></div>`
  }
}

// ── NOTIFICATIONS ──
function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora mesmo'
  if (min < 60) return `há ${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h}h`
  return `há ${Math.floor(h / 24)}d`
}

function updateNotifBadge(count) {
  const badge = document.getElementById('notif-badge')
  if (!badge) return
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count)
    badge.style.display = ''
  } else {
    badge.style.display = 'none'
  }
}

async function loadNotifBadge() {
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/notifications?unreadOnly=true`)
    if (!res.ok) return
    updateNotifBadge((await res.json()).length)
  } catch {}
}

function toggleNotifDropdown() {
  const dropdown = document.getElementById('notif-dropdown')
  if (!dropdown) return
  if (dropdown.style.display !== 'none') {
    dropdown.style.display = 'none'
  } else {
    dropdown.style.display = ''
    loadNotifDropdown()
  }
}

async function loadNotifDropdown() {
  const list = document.getElementById('notif-list')
  if (!list) return
  list.innerHTML = '<div class="notif-empty" style="color:var(--text-muted)">Carregando notificações...</div>'
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/notifications`)
    if (!res.ok) throw new Error()
    const notifications = await res.json()
    const limited = notifications.slice(0, 10)
    if (!limited.length) { list.innerHTML = '<div class="notif-empty">Nenhuma notificação ainda</div>'; return; }
    const typeIcon = { daily_digest: '📅', block_reminder: '⏱', neglect_alert: '⚠️' }
    list.innerHTML = limited.map((n, i) => `
      <div class="notif-item${n.read ? '' : ' notif-unread'}" onclick="markNotifRead(${i}, this)">
        <span class="notif-type-icon">${typeIcon[n.type] || '🔔'}</span>
        <div class="notif-body">
          <p class="notif-msg">${n.message}</p>
          <span class="notif-time">${relativeTime(n.createdAt)}</span>
        </div>
      </div>`).join('')
  } catch {
    list.innerHTML = '<div class="notif-empty">Não foi possível carregar notificações</div>'
  }
}

async function markNotifRead(idx, el) {
  try {
    await fetchWithTimeout(`${API_URL}/api/notifications/${idx}/read`, { method: 'PATCH' })
    el.classList.remove('notif-unread')
    await loadNotifBadge()
  } catch {}
}

// Close notification dropdown when clicking outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('notif-bell-wrap')
  const dropdown = document.getElementById('notif-dropdown')
  if (!dropdown || dropdown.style.display === 'none') return
  if (wrap && !wrap.contains(e.target)) dropdown.style.display = 'none'
})

// ── KEYBOARD SHORTCUTS ──
let kbdOpen = false;
function toggleKbd() {
  kbdOpen = !kbdOpen;
  document.getElementById('kbd-panel').classList.toggle('visible', kbdOpen);
  document.getElementById('kbd-toggle-btn').style.display = kbdOpen ? 'none' : '';
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (timerRunning) pauseTimer(); else startTimer();
  } else if (e.key === 'f' || e.key === 'F') {
    if (timerRunning || timerSeconds > 0) finishSession();
  } else if (e.key === '1') { showView('dashboard'); }
  else if (e.key === '2') { showView('subjects'); }
  else if (e.key === '3') { showView('history'); }
  else if (e.key === 'Escape' && kbdOpen) { toggleKbd(); }
});

// ── TOAST ──
function showToast(msg, type = '') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = 'toast' + (type ? ' toast-' + type : '')
  el.classList.add('show')
  clearTimeout(el._hideTimer)
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 2500)
}

// ── MODAL ──
let modalAction = null;
function showModal({ icon, title, desc, confirmLabel, onConfirm }) {
  document.getElementById('modal-icon').textContent = icon;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-desc').innerHTML = desc;
  document.getElementById('modal-confirm-btn').textContent = confirmLabel;
  modalAction = onConfirm;
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModalDirect() { document.getElementById('modal-overlay').classList.remove('show'); modalAction = null; }
function closeModal(e) { if (e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
function confirmModalAction() { if (modalAction) modalAction(); closeModalDirect(); }

// ── BEFOREUNLOAD ──
window.addEventListener('beforeunload', e => {
  if (timerRunning || timerSeconds > 0) { e.preventDefault(); e.returnValue = ''; }
});

// ── INIT ──
load();
renderDashboard();
checkCalendarAuth();
loadNotifBadge();
